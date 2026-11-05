import { describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, type Decoration } from '@codemirror/view'
import {
  cursorCharBackwardLogical, cursorCharForwardLogical, deleteCharBackward, deleteCharForward, redo,
  selectCharBackwardLogical, undo, undoDepth,
} from '@codemirror/commands'

import { rebaseRemote } from './changes'
import type { EditorCommand } from './types'
import {
  clearRemoteHighlight, deleteBackwardAcrossMarks, deleteEmptyTaskPrefix, deleteForwardAcrossMarks, documentDecorations,
  editorExtensions, moveToTaskLabel, prefixTyping, remoteHighlights, remoteTransaction, runEditorCommand,
} from './extensions'

const stateFor = (text: string, anchor = 0, head = anchor) => EditorState.create({
  doc: text, selection: { anchor, head }, extensions: [editorExtensions('other')],
})
const decorations = (state: EditorState) => {
  const result: Array<{ from: number; to: number; decoration: Decoration }> = []
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue
    set.between(0, state.doc.length, (from, to, decoration) => { result.push({ from, to, decoration }) })
  }
  return result.sort((left, right) => left.from - right.from || left.to - right.to)
}
const replacements = (state: EditorState) => decorations(state).filter(({ from, to, decoration }) =>
  from < to && decoration.spec.class === undefined)
const hiddenText = (state: EditorState) => replacements(state)
  .filter(({ decoration }) => !decoration.spec.widget)
  .map(({ from, to }) => state.doc.sliceString(from, to))
const widgetTexts = (state: EditorState) => replacements(state).filter(({ decoration }) => decoration.spec.widget)
  .map(({ from, to }) => state.doc.sliceString(from, to))
const classes = (state: EditorState): string[] => {
  const result: string[] = []
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue
    set.between(0, state.doc.length, (_from, _to, decoration) => {
      if (typeof decoration.spec.class === 'string') result.push(...decoration.spec.class.split(' '))
    })
  }
  return result
}

interface FakeElement {
  tagName: string
  className: string
  textContent: string
  style: Record<string, string>
  attributes: Record<string, string>
  children: FakeElement[]
  setAttribute(name: string, value: string): void
  append(...children: FakeElement[]): void
}
const fakeView = {
  dom: {
    ownerDocument: {
      createElement: (tagName: string): FakeElement => ({
        tagName, className: '', textContent: '', style: {}, attributes: {}, children: [],
        setAttribute(name, value) { this.attributes[name] = value },
        append(...children) { this.children.push(...children) },
      }),
    },
  },
} as unknown as EditorView
const render = (decoration: Decoration) => decoration.spec.widget.toDOM(fakeView) as unknown as FakeElement
/** Each rendered task marker as its source text, classes, width, symbol and label. */
const markers = (state: EditorState) => replacements(state).flatMap(({ from, to, decoration }) => {
  if (!decoration.spec.widget) return []
  const element = render(decoration)
  if (!element.className.startsWith('pt-marker')) return []
  return [{
    source: state.doc.sliceString(from, to), className: element.className, width: element.style.width,
    symbol: element.children[0]?.children[0]?.textContent, label: element.attributes['aria-label'],
  }]
})
/** Enough of a view for commands that read the state and dispatch. */
const viewFor = (initial: EditorState) => {
  let state = initial
  return {
    get state() { return state },
    dispatch(spec: TransactionSpec | Transaction) { state = spec instanceof Transaction ? spec.state : state.update(spec).state },
  } as unknown as EditorView & { state: EditorState }
}
const run = (state: EditorState, command: (target: EditorView) => boolean) => {
  const view = viewFor(state)
  const handled = command(view)
  return { handled, state: view.state }
}
/** Types each character at the caret the way the editor's input handler does. */
const typeText = (initial: EditorState, text: string) => {
  let state = initial
  for (const character of text) {
    const head = state.selection.main.head
    state = state.update(prefixTyping(state, head, head, character) ?? {
      changes: { from: head, insert: character }, selection: { anchor: head + character.length }, userEvent: 'input.type',
    }).state
  }
  return state
}

const everyKind = [
  '# Project',
  '- [ ] Task with **bold** and [a link](https://example.com)',
  '  - **t1** planning',
  '  a note with *em*',
  'Some _prose_ text',
  '- plain bullet with `code`',
  '1. numbered ~~gone~~',
  '> quote with **bold**',
  '```',
  '**fenced**',
  '```',
].join('\n')

describe('rendered editor', () => {
  test('every line kind shows its rendered form, wherever the caret or selection is', () => {
    let state = stateFor(everyKind)
    const preview = state.field(documentDecorations)
    expect(hiddenText(state)).toEqual([
      '# ', '**', '**', '[', '](https://example.com)', '**', '**', '*', '*', '_', '_', '`', '`', '~~', '~~', '> ', '**', '**',
    ])
    expect(widgetTexts(state)).toEqual(['- [ ] ', '- ', '- '])
    expect(classes(state)).toEqual(expect.arrayContaining([
      'pt-level-1', 'pt-heading-title', 'pt-strong', 'pt-link', 'pt-em', 'pt-code', 'pt-strike', 'pt-bullet', 'pt-line-quote', 'pt-line-code',
    ]))
    for (const className of ['pt-line-editing', 'pt-heading-marks', 'pt-strong-mark', 'pt-em-mark', 'pt-link-mark', 'pt-marker-source']) {
      expect(classes(state)).not.toContain(className)
    }
    for (let line = 1; line <= state.doc.lines; line += 1) {
      const { from, to } = state.doc.line(line)
      for (const selection of [{ anchor: from }, { anchor: to }, { anchor: from, head: to }, { anchor: Math.floor((from + to) / 2) }]) {
        state = state.update({ selection, userEvent: 'select.pointer' }).state
        expect(state.field(documentDecorations)).toBe(preview)
      }
    }
    state = state.update({ selection: { anchor: 0, head: state.doc.length } }).state
    expect(state.field(documentDecorations)).toBe(preview)
  })

  test('the task, status and bullet prefixes render as one box, gap or dot in the width of their source', () => {
    const state = stateFor('- [ ] Open\n- [x] Done\n  - [-] Cancelled\n- [ ] \n- [ ]\n  - status\n- dot\n-   wide')
    expect(markers(state)).toEqual([
      { source: '- [ ] ', className: 'pt-marker pt-marker-open', width: '4ch', symbol: '☐', label: 'Open' },
      { source: '- [x] ', className: 'pt-marker pt-marker-done', width: '4ch', symbol: '✔', label: 'Done' },
      { source: '- [-] ', className: 'pt-marker pt-marker-cancelled', width: '4ch', symbol: '✘', label: 'Cancelled' },
      { source: '- [ ] ', className: 'pt-marker pt-marker-open pt-marker-empty', width: '4ch', symbol: '☐', label: 'Open' },
      { source: '- [ ]', className: 'pt-marker pt-marker-open pt-marker-empty', width: '3ch', symbol: '☐', label: 'Open' },
    ])
    const others = replacements(state).filter(({ decoration }) => decoration.spec.widget && !render(decoration).className.startsWith('pt-marker'))
    expect(others.map(({ from, to, decoration }) => {
      const element = render(decoration)
      return [state.doc.sliceString(from, to), element.className, element.textContent, element.style.width]
    })).toEqual([
      ['- ', 'pt-bullet-gap', '', '2ch'],
      ['- ', 'pt-bullet-dot', '•', '2ch'],
      ['- ', 'pt-bullet-dot', '•', '2ch'],
    ])
  })

  test('unfinished Markdown shows as typed until it is complete', () => {
    for (const typed of ['#', '-', '>', '**bol', '*em', '~~gone', '`code', '[text](url', '##', '1.']) {
      const state = stateFor(typed)
      expect(hiddenText(state)).toEqual([])
      expect(widgetTexts(state)).toEqual([])
    }
    expect(classes(stateFor('#'))).toContain('pt-heading-marks')
  })

  test('Markdown typed character by character renders as soon as each construct is complete', () => {
    let state = typeText(stateFor(''), '**bol')
    expect(hiddenText(state)).toEqual([])
    state = typeText(state, 'd** and _em_ with ~~x~~ `y` [z](#tasks)')
    expect(state.doc.toString()).toBe('**bold** and _em_ with ~~x~~ `y` [z](#tasks)')
    expect(hiddenText(state)).toEqual(['**', '**', '_', '_', '~~', '~~', '`', '`', '[', '](#tasks)'])
    state = typeText(stateFor(''), '#')
    expect(hiddenText(state)).toEqual([])
    state = typeText(state, ' Project')
    expect(hiddenText(state)).toEqual(['# '])
    expect(classes(state)).toContain('pt-level-1')
    state = typeText(stateFor(''), '- [ ] Ship')
    expect(state.doc.toString()).toBe('- [ ] Ship')
    expect(widgetTexts(state)).toEqual(['- [ ] '])
  })

  test('[] or [ ] and a space at the start of a line make a task, keeping the indentation', () => {
    for (const typed of ['[]', '[ ]', '- []', '- [ ]']) {
      const state = typeText(stateFor('  ', 2), `${typed} Ship`)
      expect(state.doc.toString()).toBe('  - [ ] Ship')
      expect(state.selection.main.head).toBe(state.doc.length)
    }
    expect(typeText(stateFor('text ', 5), '[] x').doc.toString()).toBe('text [] x')
  })

  test('typing before a rendered prefix writes into the text, and a gapless box gets its space', () => {
    let state = typeText(stateFor('  - [ ] Ship', 2), 'Now ')
    expect(state.doc.toString()).toBe('  - [ ] Now Ship')
    state = typeText(stateFor('## Title', 0), 'A ')
    expect(state.doc.toString()).toBe('## A Title')
    state = typeText(stateFor('- [ ]', 5), 'x')
    expect(state.doc.toString()).toBe('- [ ] x')
  })

  test('atomic ranges contain exactly the replacements and never labels or line breaks', () => {
    const state = stateFor(everyKind, everyKind.length)
    const preview = state.field(documentDecorations)
    const atomic: Array<[number, number, Decoration]> = []
    const providers = state.facet(EditorView.atomicRanges)
    expect(providers).toHaveLength(1)
    const set = providers[0]!({ state } as EditorView)
    expect(set).toBe(preview.atomicRanges)
    set.between(0, state.doc.length, (from, to, value: Decoration) => { atomic.push([from, to, value]) })
    atomic.sort((left, right) => left[0] - right[0] || left[1] - right[1])
    expect(atomic).toEqual(replacements(state).map(({ from, to, decoration }) => [from, to, decoration]))
    for (const [from, to] of atomic) {
      expect(everyKind.slice(from, to)).not.toContain('\n')
      for (const word of ['Task', 'bold', 'link', 'planning', 'em', 'prose', 'code', 'gone', 'quote']) {
        expect(everyKind.slice(from, to)).not.toContain(word)
      }
    }
  })

  test('decorates tags with their shared and sanitized name classes', () => {
    const text = '@today @HIGH @waiting\n`@code`\n```\n@fenced\n```'
    const state = stateFor(text, text.length)
    expect(classes(state)).toEqual(expect.arrayContaining(['pt-tag', 'pt-tag-today', 'pt-tag-high', 'pt-tag-waiting']))
    expect(classes(state)).not.toContain('pt-tag-code')
    expect(classes(state)).not.toContain('pt-tag-fenced')
    expect(hiddenText(state)).not.toContain('@today')
  })

  test('returns false for unavailable Tab and Shift-Tab actions so the browser can handle them', () => {
    const view = { state: stateFor('```\ncode\n```') } as unknown as EditorView
    expect(runEditorCommand(view, 'tab' as EditorCommand)).toBe(false)
    expect(runEditorCommand(view, 'outdent', true)).toBe(false)
  })

  test('emits heading level classes and hanging columns with mixed indentation', () => {
    const text = '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n \t- [ ] Task\n \t  - status\n \t  note\n'
    const state = stateFor(text, text.length)
    for (let level = 1; level <= 6; level += 1) expect(classes(state)).toContain(`pt-level-${level}`)
    expect(decorations(state).filter(({ decoration }) => decoration.spec.class?.split(' ').includes('pt-hang'))
      .map(({ decoration }) => decoration.spec.attributes.style)).toEqual(['--pt-hang: 8', '--pt-hang: 8', '--pt-hang: 6'])
  })
})

describe('caret over rendered prefixes', () => {
  test('the box is one caret step: before it is a position, inside it never is', () => {
    const text = ' \t- [ ] Task\n- [ ] Other'
    const state = stateFor(text, text.length)
    const prefix = text.indexOf('-')
    const label = text.indexOf('Task')
    for (let anchor = prefix + 1; anchor < label; anchor += 1) {
      expect(state.update({ selection: { anchor }, userEvent: 'select' }).state.selection.main.head).toBe(label)
      expect(state.update({ selection: { anchor }, userEvent: 'select.pointer' }).state.selection.main.head).toBe(label)
      expect(state.update({ selection: { anchor } }).state.selection.main.head).toBe(anchor)
    }
    expect(state.update({ selection: { anchor: prefix }, userEvent: 'select' }).state.selection.main.head).toBe(prefix)
    expect(state.update({ selection: { anchor: prefix }, userEvent: 'select.pointer' }).state.selection.main.head).toBe(prefix)
    const range = state.update({ selection: { anchor: 3, head: 5 }, userEvent: 'select' }).state.selection.main
    expect([range.anchor, range.head]).toEqual([3, 5])
    const remote = state.update({ selection: { anchor: 4 }, userEvent: 'select', annotations: remoteTransaction.of(1) }).state
    expect(remote.selection.main.head).toBe(4)
  })

  test('ArrowLeft steps from the label to before the box, then to the previous line; ArrowRight reverses it', () => {
    for (const indent of ['', '  ']) {
      const text = `Previous\n${indent}- [ ] Task`
      let state = stateFor(text, text.indexOf('Task'))
      const left = () => cursorCharBackwardLogical({ state, dispatch: transaction => { state = transaction.state } })
      const right = () => cursorCharForwardLogical({ state, dispatch: transaction => { state = transaction.state } })
      left()
      expect(state.selection.main.head).toBe(text.indexOf('- ['))
      for (let step = 0; step <= indent.length; step += 1) left()
      expect(state.selection.main.head).toBe('Previous'.length)
      for (let step = 0; step <= indent.length; step += 1) right()
      expect(state.selection.main.head).toBe(text.indexOf('- ['))
      right()
      expect(state.selection.main.head).toBe(text.indexOf('Task'))
    }
  })

  test('hidden heading and quote marks take no caret step', () => {
    for (const line of ['## Title', '> quoted']) {
      const text = `Previous\n${line}`
      const start = text.lastIndexOf(line.startsWith('#') ? 'Title' : 'quoted')
      let state = stateFor(text, start)
      cursorCharBackwardLogical({ state, dispatch: transaction => { state = transaction.state } })
      expect(state.selection.main.head).toBe('Previous'.length)
      cursorCharForwardLogical({ state, dispatch: transaction => { state = transaction.state } })
      expect(state.selection.main.head).toBe(start)
      expect(state.update({ selection: { anchor: start - 1 }, userEvent: 'select.pointer' }).state.selection.main.head).toBe(start)
    }
  })

  test('Home targets the task label from the label, body or box without leaving the line', () => {
    for (const prefix of ['', 'Previous\n', 'Previous\n  ']) {
      const text = `${prefix}- [ ] Task`
      const label = text.indexOf('Task')
      for (const start of [label - 2, label, text.length]) {
        let state = stateFor(text, start)
        expect(moveToTaskLabel({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
        expect(state.selection.main.head).toBe(label)
      }
    }
    expect(moveToTaskLabel({ state: stateFor('Prose', 3), dispatch: () => { throw new Error('Unexpected Home interception') } })).toBe(false)
  })

  test('Shift+ArrowLeft keeps a nonempty selection and multiple carets use their own previous heads', () => {
    const text = 'Previous\n- [ ] First\nBetween\n- [ ] Second'
    const first = text.indexOf('First')
    let state = stateFor(text, first)
    expect(selectCharBackwardLogical({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect([state.selection.main.anchor, state.selection.main.head]).toEqual([first, first - 1])
    state = state.update({
      selection: EditorSelection.create([EditorSelection.cursor(first), EditorSelection.cursor(text.indexOf('Second'))], 1),
    }).state
    expect(cursorCharBackwardLogical({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.selection.ranges.map(range => range.head)).toEqual([text.indexOf('- [ ] First'), text.indexOf('- [ ] Second')])
    expect(state.selection.mainIndex).toBe(1)
  })
})

describe('deleting rendered syntax', () => {
  const backspace = (state: EditorState) => run(state, deleteCharBackward).state
  const forwardDelete = (state: EditorState) => run(state, deleteCharForward).state

  test('Backspace after the box removes the whole task marker as one undoable character', () => {
    for (const box of ['[ ]', '[x]', '[-]']) {
      const text = `Before\n  - ${box} Ship it @done (26-11-05 10:00) @high\nAfter`
      let state = backspace(stateFor(text, text.indexOf('Ship')))
      expect(state.doc.toString()).toBe('Before\n  Ship it @done (26-11-05 10:00) @high\nAfter')
      expect(state.selection.main.head).toBe('Before\n  '.length)
      expect(widgetTexts(state)).toEqual([])
      expect(undo({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
      expect(state.doc.toString()).toBe(text)
    }
  })

  test('Delete before the box removes it too, and so does a selection covering part of it', () => {
    const text = '  - [x] Ship'
    expect(forwardDelete(stateFor(text, 2)).doc.toString()).toBe('  Ship')
    const cases: Array<[number, number, string]> = [[4, 9, '  hip'], [5, 6, '  Ship'], [9, 3, '  hip'], [0, 5, 'Ship']]
    for (const [anchor, head, expected] of cases) {
      const state = backspace(stateFor(text, anchor, head))
      expect(state.doc.toString()).toBe(expected)
      expect(state.doc.toString()).not.toMatch(/- \[|\[.\]/)
    }
  })

  test('a selection from the line above into the box joins the lines without the box', () => {
    const text = 'Plan\n- [ ] Ship'
    const state = backspace(stateFor(text, 2, text.indexOf('[') + 1))
    expect(state.doc.toString()).toBe('PlShip')
  })

  test('joining a prefixed line onto the previous one drops its prefix', () => {
    for (const line of ['- [ ] next', '- next', '## next', '> next', '  - [x] next']) {
      const text = `prev\n${line}`
      const start = text.indexOf('\n') + 1
      expect(backspace(stateFor(text, start)).doc.toString()).toBe('prevnext')
      expect(forwardDelete(stateFor(text, 4)).doc.toString()).toBe('prevnext')
    }
  })

  test('Backspace after a bullet dot or before a heading or quote title makes the line plain text', () => {
    expect(backspace(stateFor('- item', 2)).doc.toString()).toBe('item')
    expect(backspace(stateFor('## Title', 3)).doc.toString()).toBe('Title')
    expect(backspace(stateFor('> quoted', 2)).doc.toString()).toBe('quoted')
    expect(backspace(stateFor('- [ ] Task\n  - planning', '- [ ] Task\n  - '.length)).doc.toString()).toBe('- [ ] Task\n  planning')
  })

  test('Backspace and Delete next to hidden delimiters delete the visible character and keep the style', () => {
    let result = run(stateFor('a **bold** b', '**bold**'.length + 2), deleteBackwardAcrossMarks)
    expect(result.handled).toBe(true)
    expect(result.state.doc.toString()).toBe('a **bol** b')
    result = run(stateFor('a **bold** b', 2), deleteForwardAcrossMarks)
    expect(result.state.doc.toString()).toBe('a **old** b')
    result = run(stateFor('see [docs](#docs) now', 'see [docs](#docs)'.length), deleteBackwardAcrossMarks)
    expect(result.state.doc.toString()).toBe('see [doc](#docs) now')
    expect(run(stateFor('plain text', 5), deleteBackwardAcrossMarks).handled).toBe(false)
  })

  test('deleting the last styled character removes its delimiters, and hitting one delimiter removes both', () => {
    let result = run(stateFor('a **b** c', 7), deleteBackwardAcrossMarks)
    expect(result.state.doc.toString()).toBe('a  c')
    expect(backspace(stateFor('a **bold** c', 4, 6)).doc.toString()).toBe('a **ld** c')
    expect(backspace(stateFor('a **bold** c', 4, 8)).doc.toString()).toBe('a  c')
    expect(backspace(stateFor('a **bold** c', 6, 10)).doc.toString()).toBe('a bo c')
    expect(backspace(stateFor('[label](https://example.com) x', 1, 5)).doc.toString()).toBe('[l](https://example.com) x')
    expect(backspace(stateFor('[label](https://example.com) x', 1, 6)).doc.toString()).toBe(' x')
    result = run(stateFor('- [ ] **b**', 11), deleteBackwardAcrossMarks)
    expect(result.state.doc.toString()).toBe('- [ ] ')
    result = run(stateFor('- [ ] **b**', 8), deleteBackwardAcrossMarks)
    expect(result.state.doc.toString()).toBe('**b**')
  })

  test('typing over a selection that covers a delimiter keeps no half of the syntax', () => {
    const state = stateFor('a **bold** c', 6, 10)
    const next = state.update({ changes: { from: 6, to: 10, insert: 'X' }, selection: { anchor: 7 }, userEvent: 'input.type' }).state
    expect(next.doc.toString()).toBe('a boX c')
  })

  test('Backspace removes an empty task prefix in one undoable edit while keeping indentation', () => {
    const text = ' \t- [ ] \nNext'
    let state = stateFor(text, text.indexOf('\n'))
    expect(deleteEmptyTaskPrefix({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.doc.toString()).toBe(' \t\nNext')
    expect(state.selection.main.head).toBe(2)
    expect(undoDepth(state)).toBe(1)
    expect(undo({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.doc.toString()).toBe(text)
    expect(deleteEmptyTaskPrefix({ state: stateFor('- [ ] Task', 6), dispatch: () => { throw new Error('Unexpected deletion') } })).toBe(false)
  })

  test('Backspace removes empty prefixes at multiple carets and leaves extra label whitespace intact', () => {
    let state = stateFor('  - [ ]\n\t- [ ]   ')
    state = state.update({
      selection: EditorSelection.create([
        EditorSelection.cursor(state.doc.line(1).to), EditorSelection.cursor(state.doc.line(2).from + 7),
      ]),
    }).state
    expect(deleteEmptyTaskPrefix({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.doc.toString()).toBe('  \n\t  ')
    expect(state.selection.ranges.map(range => range.head)).toEqual([2, 4])
  })

  test('actions, remote edits, undo and redo pass through unchanged', () => {
    const text = '- [ ] Ship'
    const state = stateFor(text)
    const remote = state.update({ changes: { from: 2, to: 3, insert: '' }, annotations: remoteTransaction.of(1) }).state
    expect(remote.doc.toString()).toBe('-  ] Ship')
    const action = state.update({ changes: { from: 3, to: 4, insert: 'x' }, userEvent: 'input.action' }).state
    expect(action.doc.toString()).toBe('- [x] Ship')
  })
})

describe('remote edits', () => {
  test('maps inserted remote highlights through typing and clears them with an effect', () => {
    let state = stateFor('base\n')
    state = state.update({
      changes: { from: 0, insert: 'agent\n' },
      annotations: [remoteTransaction.of(1), Transaction.addToHistory.of(false)],
    }).state
    expect(state.field(remoteHighlights).size).toBe(1)
    state = state.update({ changes: { from: 0, insert: 'local\n' }, userEvent: 'input.type' }).state
    const spans: Array<{ from: number; to: number }> = []
    state.field(remoteHighlights).between(0, state.doc.length, (from, to) => { spans.push({ from, to }) })
    expect(spans).toEqual([{ from: 6, to: 12 }])
    state = state.update({ effects: clearRemoteHighlight.of(null) }).state
    expect(state.field(remoteHighlights).size).toBe(0)
  })

  test('remote edits stay out of local undo history while undo and redo retain the agent text', () => {
    const original = 'base\n'
    let state = stateFor(original)
    state = state.update({ changes: { from: original.length, insert: 'local\n' }, userEvent: 'input.type' }).state
    const remote = `agent\n${original}`
    state = state.update({
      changes: rebaseRemote(original, remote, state.doc.toString()),
      annotations: [remoteTransaction.of(1), Transaction.addToHistory.of(false)],
    }).state
    expect(undoDepth(state)).toBe(1)
    expect(undo({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.doc.toString()).toBe(remote)
    expect(redo({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.doc.toString()).toBe(`${remote}local\n`)
  })
})
