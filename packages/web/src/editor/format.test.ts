import { describe, expect, test } from 'bun:test'
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { undo, undoDepth } from '@codemirror/commands'

import { runAction } from './actions'
import { applyEdits } from '@do-it/doc/text'
import { editorExtensions, runEditorCommand } from './extensions'
import type { ActionId } from './types'

/** Runs an action on one range and returns the new text, the selected text, and the caret. */
const run =(text: string, anchor: number, head: number, action: ActionId) => {
  const result = runAction(text, { ranges: [{ anchor, head }], main: 0 }, action)
  if (result._tag !== 'Applied') return { text, reason: result.reason }
  const next = applyEdits(text, result.edits)
  const range = result.selection.ranges[0]!
  return { text: next, selected: next.slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head)), head: range.head }
}

describe('formatting actions', () => {
  test('bold, italic, strikethrough and code wrap the selection and keep it selected', () => {
    const text = '- [ ] Ship the release'
    const from = text.indexOf('the')
    const to = text.length
    for (const [action, marker] of [['bold', '**'], ['italic', '*'], ['strike', '~~'], ['code', '`']] as const) {
      const result = run(text, from, to, action)
      expect(result.text).toBe(`- [ ] Ship ${marker}the release${marker}`)
      expect(result.selected).toBe('the release')
    }
  })

  test('the same action inside a styled run unwraps it, keeping the selection on the text', () => {
    for (const [action, source] of [['bold', '**the release**'], ['italic', '*the release*'], ['italic', '_the release_'],
      ['strike', '~~the release~~'], ['code', '`the release`']] as const) {
      const text = `Ship ${source} now`
      const inside = text.indexOf('release')
      const result = run(text, inside, inside + 3, action)
      expect(result.text).toBe('Ship the release now')
      expect(result.selected).toBe('rel')
    }
  })

  test('a caret formats the word it is in, and stays where it was in the word', () => {
    const text = 'Ship the release now'
    const caret = text.indexOf('lease')
    const result = run(text, caret, caret, 'bold')
    expect(result.text).toBe('Ship the **release** now')
    expect(result.head).toBe(caret + 2)
    const again = run(result.text, result.head!, result.head!, 'bold')
    expect(again.text).toBe(text)
    expect(again.head).toBe(caret)
  })

  test('a caret outside any word inserts empty delimiters with the caret between them', () => {
    const result = run('Ship  now', 5, 5, 'code')
    expect(result.text).toBe('Ship `` now')
    expect(result.head).toBe(6)
  })

  test('wrapping trims surrounding spaces and never wraps a line prefix', () => {
    const text = '- [ ] Ship it '
    const result = run(text, 0, text.length, 'bold')
    expect(result.text).toBe('- [ ] **Ship it** ')
    expect(run('## Title', 0, 8, 'italic').text).toBe('## *Title*')
  })

  test('task, bullet and heading turn lines into each kind and back, keeping indentation and text', () => {
    expect(run('Ship it', 3, 3, 'toggleTask').text).toBe('- [ ] Ship it')
    expect(run('- [x] Ship it @done (26-11-05 10:00)', 8, 8, 'toggleTask').text).toBe('Ship it @done (26-11-05 10:00)')
    expect(run('- Ship it', 3, 3, 'toggleTask').text).toBe('- [ ] Ship it')
    expect(run('## Ship it', 4, 4, 'toggleTask').text).toBe('- [ ] Ship it')
    expect(run('- [ ] Parent\n  planning note', 20, 20, 'toggleTask').text).toBe('- [ ] Parent\n  - [ ] planning note')
    expect(run('- [ ] Parent\n  - [ ] child', 20, 20, 'toggleTask').text).toBe('- [ ] Parent\n  child')
    expect(run('Ship it', 0, 0, 'toggleBullet').text).toBe('- Ship it')
    expect(run('- Ship it', 4, 4, 'toggleBullet').text).toBe('Ship it')
    expect(run('- [ ] Ship it', 8, 8, 'toggleBullet').text).toBe('- Ship it')
    expect(run('- [ ] Parent\n  - status', 18, 18, 'toggleBullet').text).toBe('- [ ] Parent\n  status')
    expect(run('Ship it', 2, 2, 'toggleHeading').text).toBe('## Ship it')
    expect(run('## Ship it', 4, 4, 'toggleHeading').text).toBe('Ship it')
    expect(run('  - [ ] Ship it', 9, 9, 'toggleHeading').text).toBe('## Ship it')
  })

  test('line toggles cover every selected line, removing only when all lines already have the kind', () => {
    const text = 'one\ntwo\nthree'
    expect(run(text, 1, text.length, 'toggleTask').text).toBe('- [ ] one\n- [ ] two\n- [ ] three')
    expect(run('- [ ] one\ntwo', 0, 12, 'toggleTask').text).toBe('- [ ] one\n- [ ] two')
    expect(run('- [ ] one\n- [ ] two', 0, 17, 'toggleTask').text).toBe('one\ntwo')
  })

  test('the caret follows a line toggle to the same place in its text', () => {
    const result = run('- [ ] Ship it', 8, 8, 'toggleTask')
    expect(result.text).toBe('Ship it')
    expect(result.head).toBe(2)
    expect(run('Ship it', 2, 2, 'toggleTask').head).toBe(8)
  })

  test('code blocks and rules are left alone', () => {
    expect(run('```\ncode\n```', 5, 5, 'bold').reason).toBe('Nothing to format here')
    expect(run('---', 1, 1, 'toggleTask').reason).toBe('Nothing to format here')
  })

  test('a formatting command is one undoable change through the editor', () => {
    let state = EditorState.create({ doc: 'Ship it', selection: { anchor: 0, head: 4 }, extensions: [editorExtensions('mac')] })
    const view = {
      get state() { return state },
      dispatch(spec: TransactionSpec | Transaction) { state = spec instanceof Transaction ? spec.state : state.update(spec).state },
    } as unknown as EditorView
    expect(runEditorCommand(view, 'bold')).toBe(true)
    expect(runEditorCommand(view, 'toggleTask')).toBe(true)
    expect(state.doc.toString()).toBe('- [ ] **Ship** it')
    expect(undoDepth(state)).toBe(2)
    expect(undo({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(state.doc.toString()).toBe('**Ship** it')
  })
})
