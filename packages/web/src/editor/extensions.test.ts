import { describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { redo, undo, undoDepth } from '@codemirror/commands'

import { rebaseRemote } from './changes'
import { clearRemoteHighlight, editorExtensions, remoteHighlights, remoteTransaction } from './extensions'

const stateFor = (text: string) => EditorState.create({ doc: text, extensions: [editorExtensions('other')] })
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
    state = state.update({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)], 0) }).state
    expect(classes(state)).toContain('pt-marker-source')
    state = state.update({ changes: { from: 3, to: 4, insert: 'x' }, selection: { anchor: 8 } }).state
    expect(classes(state)).toContain('pt-line-task-done')
    expect(classes(state)).toContain('pt-marker-done')
    expect(classes(state)).not.toContain('pt-marker-source')
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
