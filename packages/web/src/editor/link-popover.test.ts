import { describe, expect, test } from 'bun:test'
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { showTooltip, type EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'

import { editorExtensions, remoteTransaction, runEditorCommand } from './extensions'
import { linkMarkdown } from './lines'
import { closeLinkEditor, linkEditSpec, linkEdits, linkTargetAt } from './link-popover'

const stateFor = (text: string, anchor = 0, head = anchor) => EditorState.create({
  doc: text, selection: { anchor, head }, extensions: [editorExtensions('mac')],
})
/** Enough of a view for commands that only read the state and dispatch. */
const viewFor = (initial: EditorState) => {
  let state = initial
  return {
    get state() { return state },
    dispatch(spec: TransactionSpec) { state = state.update(spec).state },
  } as unknown as EditorView & { state: EditorState }
}
const tooltips = (state: EditorState) => state.facet(showTooltip).filter(tooltip => tooltip !== null)

describe('link popover', () => {
  test('writes Markdown links, keeping the label and target inside the link syntax', () => {
    expect(linkMarkdown('the guide', 'https://example.com/guide')).toBe('[the guide](https://example.com/guide)')
    expect(linkMarkdown(' [odd]\nlabel ', ' https://example.com/a b(c) ')).toBe('[oddlabel](https://example.com/a%20b%28c%29)')
    expect(linkMarkdown('', '#tasks')).toBe('[#tasks](#tasks)')
    expect(linkMarkdown('plain text', '  ')).toBe('plain text')
  })

  test('targets the link under the caret, a bare URL, or the selected text of one line', () => {
    const text = '- [ ] Read [the guide](https://example.com/guide) and https://example.com/bare\nnext line'
    const markdown = text.indexOf('[the guide]')
    expect(linkTargetAt(stateFor(text, text.indexOf('guide]')))).toEqual({
      from: markdown, to: markdown + '[the guide](https://example.com/guide)'.length, label: 'the guide', target: 'https://example.com/guide',
    })
    const bare = text.indexOf('https://example.com/bare')
    expect(linkTargetAt(stateFor(text, bare + 4))).toEqual({
      from: bare, to: bare + 'https://example.com/bare'.length, label: 'https://example.com/bare', target: 'https://example.com/bare',
    })
    const read = text.indexOf('Read')
    expect(linkTargetAt(stateFor(text, read, read + 4))).toEqual({ from: read, to: read + 4, label: 'Read', target: '' })
    expect(linkTargetAt(stateFor(text, read, text.length))).toEqual({
      from: read, to: text.indexOf('\n'), label: text.slice(read, text.indexOf('\n')), target: '',
    })
  })

  test('Cmd-K opens the popover with the link values, and saving rewrites the source in one undoable change', () => {
    const text = '- [ ] Read [the guide](https://example.com/guide) today'
    const view = viewFor(stateFor(text, text.indexOf('guide]')))
    expect(runEditorCommand(view, 'editLink')).toBe(true)
    const edit = view.state.field(linkEdits)!
    expect(edit).toMatchObject({ label: 'the guide', target: 'https://example.com/guide', focus: true })
    expect(tooltips(view.state)).toEqual([edit.tooltip])
    view.dispatch(linkEditSpec(edit, 'the manual', 'https://example.com/manual'))
    const written = '- [ ] Read [the manual](https://example.com/manual) today'
    expect(view.state.doc.toString()).toBe(written)
    expect(view.state.selection.main.head).toBe(written.indexOf(' today'))
    expect(view.state.field(linkEdits)).toBeNull()
    expect(tooltips(view.state)).toEqual([])
    let state = view.state
    expect(undo({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.doc.toString()).toBe(text)
  })

  test('linking selected text and removing a link both produce plain Markdown', () => {
    const view = viewFor(stateFor('- [ ] Read the guide', 11, 20))
    runEditorCommand(view, 'editLink')
    view.dispatch(linkEditSpec(view.state.field(linkEdits)!, 'the guide', 'https://example.com'))
    expect(view.state.doc.toString()).toBe('- [ ] Read [the guide](https://example.com)')
    view.dispatch({ selection: { anchor: 14 } })
    runEditorCommand(view, 'editLink')
    view.dispatch(linkEditSpec(view.state.field(linkEdits)!, 'the guide', ''))
    expect(view.state.doc.toString()).toBe('- [ ] Read the guide')
  })

  test('the open popover follows remote edits elsewhere and closes on local edits, link changes, caret moves, or Escape', () => {
    const text = '- [ ] Read [the guide](https://example.com/guide)\n'
    const view = viewFor(stateFor(text, text.indexOf('guide]')))
    runEditorCommand(view, 'editLink')
    const opened = view.state.field(linkEdits)!
    view.dispatch({
      changes: { from: 0, insert: '# Tasks\n' },
      annotations: [remoteTransaction.of(1), Transaction.addToHistory.of(false)],
    })
    const moved = view.state.field(linkEdits)!
    expect([moved.from, moved.to]).toEqual([opened.from + 8, opened.to + 8])
    expect(moved.tooltip).toBe(opened.tooltip)
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'more\n' }, annotations: remoteTransaction.of(2) })
    expect(view.state.field(linkEdits)!.tooltip).toBe(opened.tooltip)
    view.dispatch({ changes: { from: moved.from + 1, insert: 'x' }, annotations: remoteTransaction.of(3) })
    expect(view.state.field(linkEdits)).toBeNull()

    runEditorCommand(view, 'editLink')
    expect(view.state.field(linkEdits)).not.toBeNull()
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'local\n' } })
    expect(view.state.field(linkEdits)).toBeNull()

    runEditorCommand(view, 'editLink')
    expect(view.state.field(linkEdits)).not.toBeNull()
    view.dispatch({ selection: { anchor: 0 }, userEvent: 'select.pointer' })
    expect(view.state.field(linkEdits)).toBeNull()

    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('guide]') } })
    runEditorCommand(view, 'editLink')
    expect(closeLinkEditor(view)).toBe(true)
    expect(view.state.field(linkEdits)).toBeNull()
    expect(closeLinkEditor(view)).toBe(false)
  })
})
