import { describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView, type Decoration } from '@codemirror/view'
import {
  cursorCharBackwardLogical, cursorCharForwardLogical, redo, selectCharBackwardLogical, undo, undoDepth,
} from '@codemirror/commands'

import { rebaseRemote } from './changes'
import {
  clearRemoteHighlight, deleteEmptyTaskPrefix, documentDecorations, editorExtensions, moveToTaskLabel,
  remoteHighlights, remoteTransaction,
} from './extensions'

const stateFor = (text: string, anchor = 0) => EditorState.create({
  doc: text, selection: { anchor }, extensions: [editorExtensions('other')],
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
const classes = (state: EditorState): string[] => {
  const result: string[] = []
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === 'function') continue
    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (typeof decoration.spec.class === 'string') result.push(...decoration.spec.class.split(' '))
    })
  }
  return result
}

describe('editor extensions', () => {
  test('reveals marker source for every selection range and reclassifies a changed checkbox', () => {
    let state = stateFor('- [ ] Ship\n')
    expect(classes(state)).toContain('pt-marker-open')
    expect(classes(state)).not.toContain('pt-marker-source')
    state = state.update({
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)], 0), userEvent: 'select.pointer',
    }).state
    expect(classes(state)).toContain('pt-marker-source')
    state = state.update({ changes: { from: 3, to: 4, insert: 'x' }, selection: { anchor: 8 } }).state
    expect(classes(state)).toContain('pt-line-task-done')
    expect(classes(state)).toContain('pt-marker-done')
    expect(classes(state)).not.toContain('pt-marker-source')
  })

  test('decorated lines hide syntax and prose bullets while preserving styled text and marker slots', () => {
    const text = '# Project\n- [ ] **bold** *em* ~~strike~~ `code` [guide](#project)\n  - **agent** planning\n  note\n> quote\n- plain bullet\n- [ ] \n'
    const state = stateFor(text, text.length)
    expect(hiddenText(state)).toEqual([
      '# ', '- ', '**', '**', '*', '*', '~~', '~~', '`', '`', '[', '](#project)', '- ', '**', '**', '> ', '- ',
    ])
    expect(classes(state)).toEqual(expect.arrayContaining([
      'pt-level-1', 'pt-strong', 'pt-em', 'pt-strike', 'pt-code', 'pt-link', 'pt-marker-open', 'pt-marker-empty',
    ]))
    for (const className of ['pt-heading-marks', 'pt-strong-mark', 'pt-em-mark', 'pt-strike-mark', 'pt-code-mark', 'pt-link-mark']) {
      expect(classes(state)).not.toContain(className)
    }
    const widgets = replacements(state).filter(({ decoration }) => decoration.spec.widget)
    expect(widgets.map(({ from, to }) => text.slice(from, to))).toEqual(['-'])
    const element = { tagName: '', className: '', textContent: '' }
    const widgetView = {
      dom: { ownerDocument: { createElement: (tag: string) => { element.tagName = tag; return element } } },
    } as unknown as EditorView
    widgets[0]!.decoration.spec.widget.toDOM(widgetView)
    expect(element).toEqual({ tagName: 'span', className: 'pt-bullet-dot', textContent: '•' })
    const markers = decorations(state).filter(({ decoration }) => decoration.spec.class?.split(' ').includes('pt-marker'))
    expect(markers.map(({ from, to }) => text.slice(from, to))).toEqual(['[ ]', '[ ]'])
    for (const marker of markers) {
      expect(marker.decoration.spec.widget).toBeUndefined()
      for (const replacement of replacements(state)) {
        expect(replacement.to <= marker.from || replacement.from >= marker.to).toBe(true)
      }
    }
    expect(decorations(state).filter(({ decoration }) => decoration.spec.class?.split(' ').includes('pt-hang'))
      .map(({ decoration }) => decoration.spec.attributes.style)).toEqual([
      '--pt-hang: 4', '--pt-hang: 2', '--pt-hang: 2', '--pt-hang: 4',
    ])
  })

  test('editing lines reveal delimiters, including selections touching multiple lines, while task and status bullets stay hidden', () => {
    const text = '# Project\n- [ ] **bold** *em* ~~strike~~ `code` [guide](#project)\n  - **agent** planning\n> quote\n- plain bullet\n'
    let state = stateFor(text, text.length)
    state = state.update({
      selection: EditorSelection.create([
        EditorSelection.range(state.doc.line(3).to, 0),
        EditorSelection.range(state.doc.line(4).from, state.doc.line(5).from),
      ]),
      userEvent: 'select.pointer',
    }).state
    expect(state.field(documentDecorations).editing).toEqual([1, 2, 3, 4, 5])
    expect(hiddenText(state)).toEqual(['- ', '- '])
    expect(replacements(state).some(({ decoration }) => decoration.spec.widget)).toBe(false)
    expect(classes(state)).toEqual(expect.arrayContaining([
      'pt-line-editing', 'pt-heading-marks', 'pt-strong-mark', 'pt-em-mark', 'pt-strike-mark', 'pt-code-mark', 'pt-link-mark', 'pt-bullet',
    ]))
  })

  test('atomic ranges contain exactly the replacements and never labels, line breaks or checkbox slots', () => {
    const text = '# Project\n- [ ] **label**\n- bullet\n'
    const state = stateFor(text, text.length)
    const preview = state.field(documentDecorations)
    const atomic: Array<[number, number, Decoration]> = []
    const providers = state.facet(EditorView.atomicRanges)
    expect(providers).toHaveLength(1)
    const set = providers[0]!({ state } as EditorView)
    expect(set).toBe(preview.atomicRanges)
    expect(set).not.toBe(preview.decorations)
    set.between(0, state.doc.length, (from, to, value: Decoration) => { atomic.push([from, to, value]) })
    atomic.sort((left, right) => left[0] - right[0] || left[1] - right[1])
    expect(atomic).toEqual(replacements(state).map(({ from, to, decoration }) => [from, to, decoration]))
    for (const [from, to] of atomic) {
      expect(text.slice(from, to)).not.toContain('\n')
      expect(text.slice(from, to)).not.toContain('label')
      expect(text.slice(from, to)).not.toContain('[ ]')
    }
  })

  test('emits heading level classes and hanging columns with mixed indentation', () => {
    const text = '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n \t- [ ] Task\n \t  - status\n \t  note\n'
    const state = stateFor(text, text.length)
    for (let level = 1; level <= 6; level += 1) expect(classes(state)).toContain(`pt-level-${level}`)
    expect(decorations(state).filter(({ decoration }) => decoration.spec.class?.split(' ').includes('pt-hang'))
      .map(({ decoration }) => decoration.spec.attributes.style)).toEqual(['--pt-hang: 8', '--pt-hang: 6', '--pt-hang: 6'])
  })

  test('reuses preview and atomic ranges for caret moves inside a line, including pointer access to a marker', () => {
    let state = stateFor('- [ ] **Task**\nOther', 8)
    const preview = state.field(documentDecorations)
    const sets = state.facet(EditorView.decorations)
    state = state.update({ selection: { anchor: 9 }, userEvent: 'select' }).state
    expect(state.field(documentDecorations)).toBe(preview)
    expect(state.facet(EditorView.decorations)).toBe(sets)
    state = state.update({ selection: { anchor: 3 }, userEvent: 'select.pointer' }).state
    expect(state.field(documentDecorations)).toBe(preview)
    expect(classes(state)).toContain('pt-marker-source')
    state = state.update({ selection: { anchor: 8 }, userEvent: 'select.pointer' }).state
    expect(state.field(documentDecorations)).toBe(preview)
    expect(classes(state)).not.toContain('pt-marker-source')
    state = state.update({ selection: { anchor: state.doc.line(2).from }, userEvent: 'select' }).state
    expect(state.field(documentDecorations)).not.toBe(preview)
    expect(hiddenText(state)).toEqual(['- ', '**', '**'])
    const beforeEdit = state.field(documentDecorations)
    state = state.update({ changes: { from: state.doc.length, insert: '!' }, userEvent: 'input.type' }).state
    expect(state.field(documentDecorations)).not.toBe(beforeEdit)
  })

  test('keyboard carets skip task prefixes but pointer, range and programmatic selections retain source access', () => {
    const text = ' \t- [ ] Task\n- [ ] Other'
    const state = stateFor(text, text.length)
    const label = text.indexOf('Task')
    for (let anchor = 2; anchor < label; anchor += 1) {
      expect(state.update({ selection: { anchor }, userEvent: 'select' }).state.selection.main.head).toBe(label)
      expect(state.update({ selection: { anchor }, userEvent: 'select.pointer' }).state.selection.main.head).toBe(anchor)
      expect(state.update({ selection: { anchor } }).state.selection.main.head).toBe(anchor)
    }
    expect(state.update({ selection: { anchor: 1 }, userEvent: 'select' }).state.selection.main.head).toBe(1)
    const range = state.update({ selection: { anchor: 2, head: 5 }, userEvent: 'select' }).state.selection.main
    expect([range.anchor, range.head]).toEqual([2, 5])
    const multi = state.update({
      selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(state.doc.line(2).from + 3)], 1),
      userEvent: 'select',
    }).state.selection
    expect(multi.ranges.map(range => range.head)).toEqual([label, text.indexOf('Other')])
    expect(multi.mainIndex).toBe(1)
    const remote = state.update({ selection: { anchor: 3 }, userEvent: 'select', annotations: remoteTransaction.of(1) }).state
    expect(remote.selection.main.head).toBe(3)
  })

  test('ArrowLeft leaves a task label for the previous line end, including empty and indented tasks', () => {
    for (const task of ['- [ ] Task', '  - [ ] Task', '- [ ] ', '  - [ ]']) {
      const text = `Previous\n${task}`
      let state = stateFor(text)
      const line = state.field(documentDecorations).classified.lines[1]!
      state = state.update({ selection: { anchor: line.label!.from } }).state
      expect(cursorCharBackwardLogical({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
      expect(state.selection.main.head).toBe('Previous'.length)
    }
    let state = stateFor('- [ ] First', 6)
    expect(cursorCharBackwardLogical({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.selection.main.head).toBe(0)
    expect(cursorCharForwardLogical({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.selection.main.head).toBe(6)
  })

  test('ArrowRight enters a task at its label and vertical entry also skips the prefix', () => {
    const text = 'Previous\n- [ ] Task\nNext'
    let state = stateFor(text, 'Previous'.length)
    const label = text.indexOf('Task')
    expect(cursorCharForwardLogical({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.selection.main.head).toBe(label)
    for (const start of [0, text.indexOf('Next')]) {
      const fromAnotherLine = stateFor(text, start)
      expect(fromAnotherLine.update({ selection: { anchor: label - 2 }, userEvent: 'select' }).state.selection.main.head).toBe(label)
    }
  })

  test('Home targets the task label from the label, body or marker without leaving the line', () => {
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

  test('Shift+ArrowLeft keeps a nonempty source selection and multiple carets use their own previous heads', () => {
    const text = 'Previous\n- [ ] First\nBetween\n- [ ] Second'
    const first = text.indexOf('First')
    const second = text.indexOf('Second')
    let state = stateFor(text, first)
    expect(selectCharBackwardLogical({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect([state.selection.main.anchor, state.selection.main.head]).toEqual([first, first - 1])
    state = state.update({
      selection: EditorSelection.create([EditorSelection.cursor(first), EditorSelection.cursor(second)], 1),
    }).state
    expect(cursorCharBackwardLogical({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.selection.ranges.map(range => range.head)).toEqual(['Previous'.length, text.indexOf('\n- [ ] Second')])
    expect(state.selection.mainIndex).toBe(1)
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
    const nonempty = stateFor('- [ ] Task', 6)
    expect(deleteEmptyTaskPrefix({ state: nonempty, dispatch: () => { throw new Error('Unexpected deletion') } })).toBe(false)
    const selected = stateFor('- [ ] ').update({ selection: { anchor: 2, head: 6 } }).state
    expect(deleteEmptyTaskPrefix({ state: selected, dispatch: () => { throw new Error('Unexpected deletion') } })).toBe(false)
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
