import { describe, expect, test } from 'bun:test'
import { EditorState, type RangeSet, type RangeValue } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { lines } from '@do-it/doc/text'

import { scanBlocks } from './blocks'
import { documentDecorations, editorExtensions, remoteTransaction } from './extensions'
import { foldViewState } from './fold-view'
import { foldState, setAllFoldsOpen, setFoldOpen } from './folds'
import { HtmlSectionWidget, htmlBlockDecorations, htmlSource, indentColumns, runHtmlScripts } from './html-block'

class StubElement {
  className = ''
  contentEditable = ''
  textContent = ''
  async = true
  isConnected = false
  removed = false
  height = 40
  attributes: Array<{ name: string; value: string }> = []
  listeners = new Map<string, Set<() => void>>()
  shadowRoot: StubRoot | undefined
  shadowMode: string | undefined
  style: Record<string, string> = {}
  constructor(readonly tagName: string) {}
  getAttribute(name: string): string | null { return this.attributes.find(attribute => attribute.name === name)?.value ?? null }
  hasAttribute(name: string): boolean { return this.getAttribute(name) !== null }
  setAttribute(name: string, value: string): void {
    const old = this.attributes.find(attribute => attribute.name === name)
    if (old) old.value = value
    else this.attributes.push({ name, value })
  }
  remove(): void { this.removed = true }
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener) }
  emit(type: string): void { for (const listener of [...(this.listeners.get(type) ?? [])]) listener() }
  attachShadow(options: { mode: string }): StubRoot { this.shadowMode = options.mode; return this.shadowRoot! }
  getBoundingClientRect(): { height: number } { return { height: this.height } }
}

const script = (code: string, attributes: Record<string, string> = {}): StubElement => {
  const node = new StubElement('script')
  node.textContent = code
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  return node
}

class StubRoot {
  innerHTML = ''
  appended: StubElement[] = []
  prepended: StubElement[] = []
  constructor(readonly host: StubElement, readonly ownerDocument: { createElement(tag: string): StubElement }, readonly scripts: StubElement[]) {}
  querySelectorAll(): StubElement[] { return this.scripts.filter(node => !node.removed) }
  append(node: StubElement): void { this.appended.push(node) }
  prepend(node: StubElement): void { this.prepended.unshift(node) }
}

// Payloads are never parsed or executed. Script discovery, loads, layout and animation frames are stubs.
const dom = (scripts: StubElement[] = []) => {
  const frames = new Map<number, () => void>()
  let nextFrame = 0
  let measureCalls = 0
  const observers: StubObserver[] = []
  class StubObserver {
    disconnected = false
    target: StubElement | undefined
    constructor(readonly notify: () => void) { observers.push(this) }
    observe(target: StubElement): void { this.target = target }
    disconnect(): void { this.disconnected = true }
  }
  const document = {
    defaultView: {
      requestAnimationFrame(callback: () => void) { frames.set(++nextFrame, callback); return nextFrame },
      cancelAnimationFrame(id: number) { frames.delete(id) },
      ResizeObserver: StubObserver,
    },
    createElement(tag: string): StubElement {
      const node = new StubElement(tag)
      if (tag === 'div') node.shadowRoot = new StubRoot(node, document, scripts)
      return node
    },
  }
  const view = {
    dom: { ownerDocument: document },
    requestMeasure(request: { read(): number | null; write(height: number | null): void }) {
      measureCalls += 1
      request.write(request.read())
    },
  } as unknown as EditorView
  return {
    view, document, observers,
    get measureCalls() { return measureCalls },
    frame() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback() },
  }
}
const rootFor = (scripts: StubElement[]) => {
  const env = dom(scripts)
  const host = env.document.createElement('div')
  host.isConnected = true
  return { ...env, host, root: host.shadowRoot! }
}
const asRoot = (root: StubRoot): ShadowRoot => root as unknown as ShadowRoot
const asHost = (host: StubElement): HTMLElement => host as unknown as HTMLElement
const collect = <T extends RangeValue>(set: RangeSet<T>, length: number) => {
  const result: Array<{ from: number; to: number; value: T }> = []
  set.between(0, length, (from, to, value) => { result.push({ from, to, value }) })
  return result
}
const stateFor = (doc: string): EditorState => EditorState.create({ doc, extensions: [editorExtensions('other')] })
const widgets = (state: EditorState) => collect(state.field(htmlBlockDecorations), state.doc.length)
const fence = '```html do-it\n<p>Content</p>\n```'

describe('HTML section source', () => {
  test('strips only literal fence indentation and preserves template whitespace and CRLF', () => {
    const payload = '<script>\r\n  const text = `first\r\n    indented\r\n  last`;\r\n</script>\r\n\r\n'
    const text = '    ~~~html do-it\r\n' + payload.split('\n').map((line, i, all) => i < all.length - 1 ? '    ' + line : line).join('\n') + '    ~~~'
    const block = scanBlocks(text, lines(text)).html[0]!
    expect(htmlSource(text, block)).toBe(payload)
    const mixed = '\t```html do-it\n\t  leading\n\t\tmore\n less\n\n\t```'
    expect(htmlSource(mixed, scanBlocks(mixed, lines(mixed)).html[0]!)).toBe('  leading\n\tmore\n less\n\n')
  })

  test('keeps an unindented payload verbatim and supports empty fences', () => {
    for (const payload of ['', '<style>p { color: red }</style>\n<svg><text>SVG</text></svg>\n<script>root.querySelector("p")</script>\n']) {
      const text = '```html do-it\n' + payload + '```'
      expect(htmlSource(text, scanBlocks(text, lines(text)).html[0]!)).toBe(payload)
    }
  })
})

describe('HTML section scripts', () => {
  test('removes every inert script first and evaluates inline classics in order with root', async () => {
    const scripts = [script('first()'), script('second()', { type: 'text/javascript' })]
    const { root } = rootFor(scripts)
    const calls: string[] = []
    await runHtmlScripts(asRoot(root), { evaluate: (code, receivedRoot) => {
      expect(receivedRoot).toBe(asRoot(root))
      expect(scripts.every(node => node.removed)).toBe(true)
      calls.push(code)
    } })
    expect(calls).toEqual(['first()', 'second()'])
    expect(root.appended).toEqual([])
  })

  test('reports a throwing inline script and continues with the next script', async () => {
    const { root } = rootFor([script('broken'), script('next')])
    const failure = new Error('Fixture error')
    const errors: unknown[] = []
    const calls: string[] = []
    await runHtmlScripts(asRoot(root), {
      evaluate: code => { calls.push(code); if (code === 'broken') throw failure },
      reportError: error => { errors.push(error) },
    })
    expect(calls).toEqual(['broken', 'next'])
    expect(errors).toEqual([failure])
  })

  test('copies src attributes and waits for load before the next script', async () => {
    const original = script('fallback', { src: 'https://example.invalid/fixture.js', integrity: 'fixture', crossorigin: 'anonymous' })
    const { root } = rootFor([script('before'), original, script('after')])
    const calls: string[] = []
    const running = runHtmlScripts(asRoot(root), { evaluate: code => { calls.push(code) } })
    expect(calls).toEqual(['before'])
    const fresh = root.appended[0]!
    expect(fresh).not.toBe(original)
    expect(fresh.attributes).toEqual(original.attributes)
    expect(fresh.textContent).toBe('fallback')
    expect(fresh.async).toBe(false)
    fresh.emit('load')
    await running
    expect(calls).toEqual(['before', 'after'])
    expect([...fresh.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  test('src errors are reported and later scripts still run', async () => {
    const { root } = rootFor([script('', { src: '/fixture.js' }), script('after')])
    const calls: string[] = []
    const errors: unknown[] = []
    const running = runHtmlScripts(asRoot(root), {
      evaluate: code => { calls.push(code) }, reportError: error => { errors.push(error) },
    })
    root.appended[0]!.emit('error')
    await running
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('/fixture.js')
    expect(calls).toEqual(['after'])
  })

  test('successive src scripts load in document order including external modules', async () => {
    const { root } = rootFor([script('', { src: '/first.js' }), script('', { src: '/second.js', type: 'module' }), script('last')])
    const calls: string[] = []
    const running = runHtmlScripts(asRoot(root), { evaluate: code => { calls.push(code) } })
    expect(root.appended.map(node => node.getAttribute('src'))).toEqual(['/first.js'])
    root.appended[0]!.emit('load')
    await Promise.resolve()
    expect(root.appended.map(node => node.getAttribute('src'))).toEqual(['/first.js', '/second.js'])
    expect(calls).toEqual([])
    expect(root.appended[1]!.async).toBe(false)
    root.appended[1]!.emit('load')
    await running
    expect(calls).toEqual(['last'])
  })

  test('modules and data scripts become fresh elements without a root evaluator', async () => {
    const originals = [script('export {}', { type: 'module', nonce: 'fixture' }), script('{"value":1}', { type: 'application/json', id: 'data' })]
    const { root } = rootFor(originals)
    const calls: string[] = []
    await runHtmlScripts(asRoot(root), { evaluate: code => { calls.push(code) } })
    expect(calls).toEqual([])
    expect(root.appended).toHaveLength(2)
    originals.forEach((original, index) => {
      expect(original.removed).toBe(true)
      expect(root.appended[index]).not.toBe(original)
      expect(root.appended[index]!.attributes).toEqual(original.attributes)
      expect(root.appended[index]!.textContent).toBe(original.textContent)
    })
  })

  test('abort removes a pending src script and prevents later scripts', async () => {
    const { root } = rootFor([script('', { src: '/fixture.js' }), script('after')])
    const controller = new AbortController()
    const calls: string[] = []
    const running = runHtmlScripts(asRoot(root), { signal: controller.signal, evaluate: code => { calls.push(code) } })
    const fresh = root.appended[0]!
    controller.abort()
    await running
    expect(fresh.removed).toBe(true)
    expect([...fresh.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    expect(calls).toEqual([])
  })

  test('disconnected or already aborted roots never execute scripts', async () => {
    const { root, host } = rootFor([script('never')])
    const calls: string[] = []
    host.isConnected = false
    await runHtmlScripts(asRoot(root), { evaluate: code => { calls.push(code) } })
    host.isConnected = true
    const controller = new AbortController()
    controller.abort()
    await runHtmlScripts(asRoot(root), { signal: controller.signal, evaluate: code => { calls.push(code) } })
    expect(calls).toEqual([])
    expect(root.scripts[0]!.removed).toBe(false)
  })
})

describe('HTML section widgets', () => {
  test('inserts verbatim HTML in an accessible open shadow root with a base style reset', () => {
    const source = '<style>.x { color: red }</style><svg><text>SVG</text></svg><button onclick="this.textContent=1">Click</button><script>root.querySelector(".x")</script>'
    const env = dom()
    const widget = new HtmlSectionWidget(source)
    const host = widget.toDOM(env.view) as unknown as StubElement
    expect(host.className).toBe('pt-html-section')
    expect(host.getAttribute('role')).toBe('group')
    expect(host.getAttribute('aria-label')).toBe('HTML section')
    expect(host.contentEditable).toBe('false')
    expect(host.shadowMode).toBe('open')
    expect(host.shadowRoot!.innerHTML).toBe(source)
    const base = host.shadowRoot!.prepended[0]!
    expect(base.tagName).toBe('style')
    for (const css of ['all: initial', 'display: block', 'white-space: normal', 'system-ui', 'max-width: 100%']) expect(base.textContent).toContain(css)
    expect(widget.ignoreEvent()).toBe(true)
    widget.destroy(asHost(host))
  })

  test('starts scripts on the next frame only while the host is connected', () => {
    for (const connected of [false, true]) {
      const original = script('export {}', { type: 'module' })
      const env = dom([original])
      const widget = new HtmlSectionWidget('module fixture')
      const host = widget.toDOM(env.view) as unknown as StubElement
      expect(original.removed).toBe(false)
      host.isConnected = connected
      env.frame()
      expect(original.removed).toBe(connected)
      expect(host.shadowRoot!.appended).toHaveLength(connected ? 1 : 0)
      widget.destroy(asHost(host))
    }
  })

  test('equal widgets compare source only and can clean up a reused host', () => {
    const widget = new HtmlSectionWidget('same source')
    const equal = new HtmlSectionWidget('same source')
    expect(widget.eq(equal)).toBe(true)
    expect(widget.eq(new HtmlSectionWidget('changed source'))).toBe(false)
    const env = dom([script('export {}', { type: 'module' })])
    const host = widget.toDOM(env.view) as unknown as StubElement
    host.isConnected = true
    equal.destroy(asHost(host))
    env.frame()
    expect(host.shadowRoot!.appended).toEqual([])
    expect(env.observers).toEqual([])
  })

  test('lines a section up with its fence indentation in editor character widths', () => {
    expect([indentColumns(''), indentColumns('  '), indentColumns('\t'), indentColumns(' \t ')]).toEqual([0, 2, 4, 5])
    expect(new HtmlSectionWidget('same', 2).eq(new HtmlSectionWidget('same', 4))).toBe(false)
    const env = dom()
    const view = { ...env.view, dom: env.view.dom, defaultCharacterWidth: 10, requestMeasure: () => {} } as unknown as EditorView
    const indented = new HtmlSectionWidget('<p>x</p>', 2).toDOM(view) as unknown as StubElement
    expect(indented.style.marginInlineStart).toBe('20px')
    const flush = new HtmlSectionWidget('<p>x</p>').toDOM(view) as unknown as StubElement
    expect(flush.style.marginInlineStart).toBeUndefined()
  })

  test('natural height changes update cached estimates and observers stop on destroy', () => {
    const widget = new HtmlSectionWidget('height fixture')
    expect(widget.estimatedHeight).toBe(-1)
    const env = dom()
    const host = widget.toDOM(env.view) as unknown as StubElement
    host.isConnected = true
    host.height = 120
    env.frame()
    expect(widget.estimatedHeight).toBe(120)
    host.height = 37
    env.observers[0]!.notify()
    expect(new HtmlSectionWidget(widget.source).estimatedHeight).toBe(37)
    expect(env.measureCalls).toBe(2)
    widget.destroy(asHost(host))
    expect(env.observers[0]!.disconnected).toBe(true)
    host.height = 0
    env.observers[0]!.notify()
    expect(widget.estimatedHeight).toBe(37)
    expect(env.measureCalls).toBe(2)
  })

  test('height estimates retain at most the last 64 measured sources', () => {
    for (let i = 0; i < 65; i += 1) {
      const env = dom()
      const widget = new HtmlSectionWidget(`bounded height fixture ${i}`)
      const host = widget.toDOM(env.view) as unknown as StubElement
      host.isConnected = true
      host.height = i + 10
      env.frame()
      widget.destroy(asHost(host))
    }
    expect(new HtmlSectionWidget('bounded height fixture 0').estimatedHeight).toBe(-1)
    expect(new HtmlSectionWidget('bounded height fixture 1').estimatedHeight).toBe(11)
    expect(new HtmlSectionWidget('bounded height fixture 64').estimatedHeight).toBe(74)
  })

  test('destroy aborts the src script wait without running the following module', async () => {
    const env = dom([script('', { src: '/fixture.js' }), script('export {}', { type: 'module' })])
    const widget = new HtmlSectionWidget('pending src fixture')
    const host = widget.toDOM(env.view) as unknown as StubElement
    host.isConnected = true
    env.frame()
    const fresh = host.shadowRoot!.appended[0]!
    widget.destroy(asHost(host))
    await Promise.resolve()
    expect(fresh.removed).toBe(true)
    expect(host.shadowRoot!.appended).toHaveLength(1)
    expect(env.observers[0]!.disconnected).toBe(true)
  })
})

describe('HTML section decorations', () => {
  test('a direct block replacement and atomic range cover exactly the complete fence', () => {
    const text = 'before\r\n  ~~~html do-it\r\n  <p>Content</p>\r\n  ~~~\r\nafter'
    const state = stateFor(text)
    const ranges = widgets(state)
    expect(ranges).toHaveLength(1)
    const range = ranges[0]!
    expect([range.from, range.to]).toEqual([text.indexOf('  ~~~'), text.lastIndexOf('  ~~~') + 5])
    expect(range.value.spec.block).toBe(true)
    expect(range.value.spec.widget).toBeInstanceOf(HtmlSectionWidget)
    expect(range.value.spec.widget.source).toBe('<p>Content</p>\r\n')
    expect(state.facet(EditorView.decorations)).toContain(state.field(htmlBlockDecorations))
    const view = { state } as EditorView
    expect(state.facet(EditorView.atomicRanges).some(source => source(view) === state.field(htmlBlockDecorations))).toBe(true)
  })

  test('closed HTML in folded projects tasks and details has no widget until revealed', () => {
    for (const text of ['# Project\n' + fence, '- [ ] Task\n' + fence.split('\n').map(line => '  ' + line).join('\n'), '<details><summary>Section</summary>\n' + fence + '\n</details>']) {
      let state = stateFor(text).update({ effects: setAllFoldsOpen.of(false) }).state
      expect(widgets(state)).toEqual([])
      const candidate = state.field(foldState).candidates[0]!
      state = state.update({ effects: setFoldOpen.of({ key: candidate.key, open: true }) }).state
      expect(widgets(state)).toHaveLength(1)
    }
  })

  test('base and details decorations do not overlap a rendered HTML fence', () => {
    const text = '<details open>\n<summary>**Section**</summary>\n' + fence + '\n</details>'
    const state = stateFor(text)
    const html = widgets(state)[0]!
    for (const set of [state.field(documentDecorations).decorations, state.field(foldViewState).decorations]) {
      for (const range of collect(set, state.doc.length)) expect(range.to <= html.from || range.from >= html.to).toBe(true)
    }
  })

  test('nested hidden fences stay absent while visible sibling fences render', () => {
    const text = '<details><summary>Outer</summary>\n<details><summary>Inner</summary>\n' + fence + '\n</details>\n</details>\n' + fence
    let state = stateFor(text)
    expect(widgets(state).map(range => range.from)).toEqual([text.lastIndexOf('```html do-it')])
    const outer = state.field(foldState).candidates[0]!
    state = state.update({ effects: setFoldOpen.of({ key: outer.key, open: true }) }).state
    expect(widgets(state)).toHaveLength(1)
    state = state.update({ effects: setAllFoldsOpen.of(true) }).state
    expect(widgets(state)).toHaveLength(2)
  })

  test('a task fold cutting through a less indented payload never overlaps an HTML widget', () => {
    const text = '- [ ] Task\n  ```html do-it\n  <p>indented</p>\n<p>outside task</p>\n  ```'
    let state = stateFor(text)
    expect(widgets(state)).toHaveLength(1)
    state = state.update({ effects: setAllFoldsOpen.of(false) }).state
    expect(state.field(foldViewState).hidden).toHaveLength(1)
    expect(widgets(state)).toEqual([])
  })

  test('unclosed and ordinary HTML fences remain visible code without widgets', () => {
    for (const text of ['```html do-it\n<script>never()</script>', '```html\n<script>never()</script>\n```', '```html do-it extra\n<p>code</p>\n```']) {
      const state = stateFor(text)
      expect(widgets(state)).toEqual([])
      expect(collect(state.field(foldViewState).decorations, state.doc.length)).toEqual([])
      expect(state.doc.toString()).toBe(text)
    }
  })

  test('remote completion renders a fence and equal source survives unrelated edits and selection', () => {
    let state = stateFor('before\n```html do-it\n<p>Content</p>\n')
    expect(widgets(state)).toEqual([])
    state = state.update({ changes: { from: state.doc.length, insert: '```' }, annotations: remoteTransaction.of(1) }).state
    const original = widgets(state)[0]!.value.spec.widget as HtmlSectionWidget
    state = state.update({ changes: { from: 0, insert: 'another line\n' } }).state
    expect(original.eq(widgets(state)[0]!.value.spec.widget)).toBe(true)
    const decorations = state.field(htmlBlockDecorations)
    state = state.update({ selection: { anchor: 3 } }).state
    expect(state.field(htmlBlockDecorations)).toBe(decorations)
  })
})
