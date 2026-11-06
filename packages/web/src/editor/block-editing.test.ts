import { describe, expect, test } from 'bun:test'
import { Annotation, EditorSelection, EditorState, StateEffect, Transaction, type TransactionSpec } from '@codemirror/state'
import { deleteCharBackward, redo, undo, undoDepth } from '@codemirror/commands'
import { EditorView, keymap } from '@codemirror/view'

import {
  HtmlSelectionFeedback, blockInput, blockTyping, deleteAdjacentBlock, enterDetailsBody,
  protectBlockSyntax, protectRenderedSyntax,
} from './block-editing'
import { classifiedDocument } from './document'
import { editorExtensions, editorFacts, pasteMarkdown, remoteTransaction } from './extensions'
import { foldState, isFoldOpen, setAllFoldsOpen } from './folds'
import { htmlBlockDecorations } from './html-block'
import { classifyDocument } from './lines'
import type { TextChange } from './syntax'

const details = '<details><summary>Title</summary>\nbody\n</details>'
const html = '```html do-it\n<p>Payload</p>\n```'
const stateFor = (doc: string, anchor = 0, head = anchor, notices: string[] = []): EditorState => EditorState.create({
  doc, selection: { anchor, head }, extensions: [editorExtensions('other'), editorFacts.of(fact => {
    if (fact._tag === 'ShowedEditorNotice') notices.push(fact.text)
  })],
})
const viewFor = (initial: EditorState, composing = false) => {
  let state = initial
  return {
    get state() { return state }, composing,
    plugin() { return null },
    dispatch(spec: Transaction | TransactionSpec) { state = spec instanceof Transaction ? spec.state : state.update(spec).state },
  } as unknown as EditorView
}
const key = (view: EditorView, name: string): boolean => {
  for (const binding of view.state.facet(keymap).flat()) if (binding.key === name && binding.run?.(view)) return true
  return false
}
const apply = (text: string, changes: readonly TextChange[]): string => {
  const state = EditorState.create({ doc: text, extensions: [EditorState.lineSeparator.of('\n')] })
  return state.changes(changes).apply(state.doc).toString()
}
const protect = (text: string, changes: readonly TextChange[]): TextChange[] =>
  protectBlockSyntax(classifyDocument(text).blocks, changes) ?? [...changes]
const openState = (text: string, anchor = 0, head = anchor): EditorState => stateFor(text, anchor, head)
  .update({ effects: setAllFoldsOpen.of(true) }).state

describe('block syntax protection', () => {
  test('deleting any details delimiter unwraps tags while retaining title body and whitespace', () => {
    for (const text of [details, '  <details>\r\n  <summary>Title</summary>\r\n  body\r\n  </details>']) {
      const block = classifyDocument(text).blocks.details[0]!
      for (const delimiter of block.delimiters) {
        const changes = protect(text, [{ from: delimiter.from, to: delimiter.from + 1, insert: '' }])
        expect(apply(text, changes)).toBe(text.replace(/<details>|<summary>|<\/summary>|<\/details>/g, ''))
        expect(protectBlockSyntax(classifyDocument(text).blocks, changes)).toBeUndefined()
      }
    }
  })

  test('outer and inner unwrapping leave untouched nested delimiters intact', () => {
    const text = '<details><summary>Outer</summary>\n' + details + '\n</details>'
    const blocks = classifyDocument(text).blocks.details
    for (const index of [0, 1]) {
      const block = blocks[index]!
      const result = apply(text, protect(text, [{ from: block.from, to: block.from + 1, insert: '' }]))
      expect(classifyDocument(result).blocks.details).toHaveLength(1)
      expect(result).toContain(index === 0 ? details : '<details><summary>Outer</summary>')
      if (index === 1) expect(result).toContain('Title\nbody')
    }
  })

  test('title deletion keeps an empty summary valid and a whole section selection deletes normally', () => {
    const block = classifyDocument(details).blocks.details[0]!
    const title = [{ ...block.title, insert: '' }]
    expect(protectBlockSyntax(classifyDocument(details).blocks, title)).toBeUndefined()
    expect(apply(details, title)).toContain('<summary></summary>')
    const whole = [{ from: block.from, to: block.to, insert: 'replacement' }]
    expect(protectBlockSyntax(classifyDocument(details).blocks, whole)).toBeUndefined()
    expect(apply(details, whole)).toBe('replacement')
  })

  test('partial HTML deletion widens through the fence and retains each insertion once', () => {
    const text = 'before\n' + html + '\nafter'
    const changes = [
      { from: text.indexOf('Payload'), to: text.indexOf('Payload') + 1, insert: 'one' },
      { from: text.indexOf('</p>'), to: text.indexOf('</p>') + 1, insert: 'two' },
    ]
    const protectedChanges = protect(text, changes)
    expect(apply(text, protectedChanges)).toBe('before\nonetwo\nafter')
    expect(protectBlockSyntax(classifyDocument(text).blocks, protectedChanges)).toBeUndefined()
    const unclosed = html.slice(0, -3)
    expect(protectBlockSyntax(classifyDocument(unclosed).blocks, [{ from: 15, to: 16, insert: '' }])).toBeUndefined()
  })

  test('line joins unwrap details without stranding their delimiters', () => {
    for (const text of ['before\n' + details, details + '\nafter', details]) {
      const at = text.startsWith('before') ? 6 : text.endsWith('after') ? details.length : text.indexOf('\nbody')
      const result = apply(text, protect(text, [{ from: at, to: at + 1, insert: '' }]))
      expect(result).not.toContain('<details>')
      expect(result).not.toContain('</details>')
      expect(result).toContain('body')
    }
    const beforeCloser = details.lastIndexOf('\n')
    expect(apply(details, protect(details, [{ from: beforeCloser, to: beforeCloser + 1, insert: '' }]))).toBe('Title\nbody')
  })

  test('deleting only a separator beside HTML preserves the fence and the next task prefix', () => {
    for (const eol of ['\n', '\r\n']) {
      const text = 'before' + eol + html.replaceAll('\n', eol) + eol + '- [ ] After'
      const initial = stateFor(text)
      const document = initial.field(classifiedDocument)
      const block = document.blocks.html[0]!
      const before = { from: document.lines[block.startLine - 1]!.to, to: block.from }
      const after = { from: block.to, to: document.lines[block.endLine]!.from }
      for (const change of [before, after, { from: before.from, to: before.from + 1 }, { from: after.to - 1, to: after.to }]) {
        const transaction = initial.update({ changes: change, userEvent: 'delete.selection' })
        expect(transaction.docChanged).toBe(false)
        expect(transaction.state.doc.toString()).toBe(text)
        expect(transaction.state.field(htmlBlockDecorations)).toBe(initial.field(htmlBlockDecorations))
        expect(undoDepth(transaction.state)).toBe(0)
      }
    }
  })

  test('separator protection keeps the rest of a deletion and its metadata in one undoable change', () => {
    for (const eol of ['\n', '\r\n']) {
      const fence = html.replaceAll('\n', eol)
      const text = 'before' + eol + fence + eol + '- [ ] After'
      const initial = stateFor(text)
      const block = initial.field(classifiedDocument).blocks.html[0]!
      const marker = Annotation.define<string>()
      const transaction = initial.update({
        changes: [{ from: 2, to: block.from }, { from: block.to, to: block.to + eol.length + 7 }],
        userEvent: 'delete.selection', annotations: marker.of('kept'),
      })
      expect(transaction.newDoc.toString()).toBe('be' + eol + fence + eol + 'fter')
      expect(transaction.annotation(marker)).toBe('kept')
      expect(transaction.state.field(classifiedDocument).blocks.html[0]!.closed).toBe(true)
      const view = viewFor(transaction.state)
      expect(undoDepth(view.state)).toBe(1)
      expect(undo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe(text)
      expect(redo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe('be' + eol + fence + eol + 'fter')
    }
  })

  test('real HTML fence overlaps still widen and remote separator deletions remain untouched', () => {
    const text = 'before\n' + html + '\n- [ ] After'
    const initial = stateFor(text)
    const block = initial.field(classifiedDocument).blocks.html[0]!
    const local = initial.update({ changes: { from: block.from - 1, to: block.from + 1 }, userEvent: 'delete.selection' }).state
    expect(local.doc.toString()).toBe('before\n- [ ] After')
    expect(local.field(classifiedDocument).blocks.html).toEqual([])
    const remote = initial.update({
      changes: { from: block.from - 1, to: block.from }, userEvent: 'delete.backward', annotations: remoteTransaction.of(1),
    }).state
    expect(remote.doc.toString()).toBe('before' + html + '\n- [ ] After')
  })

  test('more than four nested sections and inline syntax reach a stable cleanup', () => {
    const depth = 9
    const text = Array.from({ length: depth }, (_, i) => `<details><summary>**Title${i}**</summary>`).join('\n') +
      '\nbody\n' + Array.from({ length: depth }, () => '</details>').join('\n')
    const document = classifyDocument(text)
    const changes = [{ from: 1, to: document.blocks.details.at(-1)!.title.from + 1, insert: 'once' }]
    const protectedChanges = protectRenderedSyntax(document, changes)!
    const result = apply(text, protectedChanges)
    expect(result).not.toContain('<details>')
    expect(result).not.toContain('</details>')
    expect(result).not.toContain('**')
    expect(result.match(/once/g)).toHaveLength(1)
    expect(protectRenderedSyntax(document, protectedChanges)).toBeUndefined()
  })

  test('guarded edits preserve metadata replacement carets and undo as one change', () => {
    const text = 'before\n' + html + '\nafter'
    const from = text.indexOf('Payload')
    const marker = Annotation.define<string>()
    const position = StateEffect.define<number>({ map: (value, changes) => changes.mapPos(value) })
    const initial = stateFor(text, from, from + 1)
    const transaction = initial.update({
      changes: { from, to: from + 1, insert: 'new' }, selection: { anchor: from + 3 }, userEvent: 'input.type',
      annotations: marker.of('kept'), effects: position.of(from + 3), scrollIntoView: true,
    })
    expect(transaction.newDoc.toString()).toBe('before\nnew\nafter')
    expect(transaction.newSelection.main.head).toBe('before\nnew'.length)
    expect(transaction.annotation(marker)).toBe('kept')
    expect(transaction.annotation(Transaction.userEvent)).toBe('input.type')
    expect(transaction.effects.find(effect => effect.is(position))?.value).toBe('before\nnew'.length)
    expect(transaction.scrollIntoView).toBe(true)
    const view = viewFor(transaction.state)
    expect(undoDepth(view.state)).toBe(1)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(text)
    expect(redo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('before\nnew\nafter')
  })
})

describe('Find and Replace in sections', () => {
  test('payload and ordinary replacements apply exactly without widening', () => {
    for (const event of ['input.replace', 'input.replace.all']) {
      const text = '<details open><summary>Title</summary>\n' + html + '\nbody\n</details>\n**bold**'
      const from = text.indexOf('Payload')
      let state = stateFor(text).update({ changes: { from, to: from + 7, insert: 'New' }, userEvent: event }).state
      expect(state.doc.toString()).toBe(text.replace('Payload', 'New'))
      const body = state.doc.toString().indexOf('body')
      state = state.update({ changes: { from: body, to: body + 1, insert: 'B' }, userEvent: event }).state
      expect(state.doc.toString()).toContain('\nBody\n')
      const star = state.doc.toString().indexOf('**bold**')
      state = state.update({ changes: { from: star, to: star + 1, insert: '' }, userEvent: event }).state
      expect(state.doc.toString()).toContain('*bold**')
    }
  })

  test('fence and details markup replacements refuse the entire transaction with a notice', () => {
    for (const text of [html, details]) {
      const blocks = classifyDocument(text).blocks
      const delimiters = blocks.html[0]?.delimiters ?? blocks.details[0]!.delimiters
      for (const delimiter of delimiters) {
        const notices: string[] = []
        const initial = stateFor(text, 0, 0, notices)
        const transaction = initial.update({ changes: { from: delimiter.from, to: delimiter.from + 1, insert: 'x' }, userEvent: 'input.replace.all' })
        expect(transaction.docChanged).toBe(false)
        expect(transaction.newDoc.toString()).toBe(text)
        expect(notices).toEqual(['Edit the section markup with do-it edit'])
      }
    }
    const notices: string[] = []
    const text = html + '\nordinary'
    const state = stateFor(text, 0, 0, notices).update({ changes: [
      { from: 1, to: 2, insert: 'x' }, { from: text.indexOf('ordinary'), to: text.length, insert: 'changed' },
    ], userEvent: 'input.replace.all' }).state
    expect(state.doc.toString()).toBe(text)
    expect(notices).toHaveLength(1)
  })

  test('zero width replacements allow title and payload boundaries but reject fence lines', () => {
    const text = '<details open><summary>Title</summary>\n' + html + '\n</details>'
    const document = classifyDocument(text)
    const block = document.blocks.details[0]!
    for (const at of [block.title.from, block.title.to, document.blocks.html[0]!.body.from]) {
      const state = stateFor(text).update({ changes: { from: at, insert: 'x' }, userEvent: 'input.replace' }).state
      expect(state.doc.toString()).toBe(text.slice(0, at) + 'x' + text.slice(at))
    }
    const notices: string[] = []
    const at = document.blocks.html[0]!.open.to
    expect(stateFor(text, 0, 0, notices).update({ changes: { from: at, insert: 'x' }, userEvent: 'input.replace' }).docChanged).toBe(false)
    expect(notices).toHaveLength(1)
  })
})

describe('deleting beside rendered blocks', () => {
  test('Delete at the final hidden endpoint reveals every kind without joining the next visible line', () => {
    for (const text of ['# Project\nbody\n# Next', '- [ ] Task\n  note\n- [ ] Peer', details + '\n- [ ] Peer']) {
      const initial = stateFor(text).update({ effects: setAllFoldsOpen.of(false) }).state
      const fold = initial.field(foldState).candidates[0]!
      const view = viewFor(initial.update({ selection: { anchor: fold.hidden.to } }).state)
      expect(view.state.field(foldState).folded.size).toBe(1)
      expect(key(view, 'Delete')).toBe(true)
      expect(view.state.doc.toString()).toBe(text)
      expect(view.state.field(foldState).folded.size).toBe(0)
      expect(undoDepth(view.state)).toBe(0)
    }
  })

  test('typing Enter and paste at a placeholder end reveal the edited section', () => {
    for (const text of ['# Project\nbody\n# Next', '- [ ] Task\n  note\n- [ ] Peer', details + '\nafter']) {
      for (const input of ['typed', '\n', 'one\ntwo']) {
        let state = stateFor(text).update({ effects: setAllFoldsOpen.of(false) }).state
        const fold = state.field(foldState).candidates[0]!
        state = state.update({ selection: { anchor: fold.hidden.to } }).state
        const spec = input.includes('two') ? pasteMarkdown(state, input) : blockInput(state, input)
        state = state.update(spec ?? {
          changes: { from: fold.hidden.to, insert: input }, selection: { anchor: fold.hidden.to + input.length },
          userEvent: input.includes('two') ? 'input.paste' : 'input.type',
        }).state
        expect(state.field(foldState).candidates.some(candidate => candidate.key === fold.key)).toBe(true)
        expect(state.field(foldState).folded.size).toBe(0)
        if (input !== '\n') for (const line of input.split('\n')) expect(state.doc.toString()).toContain(line)
      }
    }
  })

  test('remote appends keep a placeholder end caret beyond the grown folded task', () => {
    let state = stateFor('- [ ] Task\n  note\n- [ ] Peer').update({ effects: setAllFoldsOpen.of(false) }).state
    const before = state.field(foldState).candidates[0]!
    state = state.update({ selection: EditorSelection.create([EditorSelection.cursor(before.hidden.to, -1)]) }).state
    state = state.update({ changes: { from: before.hidden.to, insert: '\n  remote' }, annotations: remoteTransaction.of(1) }).state
    const after = state.field(foldState).candidates[0]!
    expect(after.hiddenLines).toBe(before.hiddenLines + 1)
    expect(state.selection.main.head).toBe(after.hidden.to)
    expect(state.field(foldState).folded.size).toBe(1)
    expect(state.doc.toString()).toBe('- [ ] Task\n  note\n  remote\n- [ ] Peer')
  })

  test('Backspace after or Delete before each folded body unfolds without deleting text', () => {
    for (const text of ['# Project\nbody\n# Next', '- [ ] Task\n  note\n- [ ] Next', details + '\nafter']) {
      for (const forward of [false, true]) {
        const initial = stateFor(text).update({ effects: setAllFoldsOpen.of(false) }).state
        const fold = initial.field(foldState).candidates[0]!
        const position = forward ? fold.hidden.from : initial.doc.lineAt(fold.hidden.to).to + 1
        const view = viewFor(initial.update({ selection: { anchor: position } }).state)
        expect(key(view, forward ? 'Delete' : 'Backspace')).toBe(true)
        expect(view.state.doc.toString()).toBe(text)
        expect(isFoldOpen(view.state.field(foldState), view.state.field(foldState).candidates[0]!)).toBe(true)
        expect(undoDepth(view.state)).toBe(0)
      }
    }
  })

  test('a whole folded block selection deletes normally and undo restores it', () => {
    const text = details + '\nafter'
    const view = viewFor(stateFor(text, 0, details.length))
    expect(deleteAdjacentBlock(false)(view)).toBe(false)
    expect(deleteCharBackward(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('\nafter')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(text)
  })

  test('Delete at the visible details title end reveals the fold before touching hidden summary tags', () => {
    const at = details.indexOf('</summary>')
    const view = viewFor(stateFor(details, at))
    expect(key(view, 'Delete')).toBe(true)
    expect(view.state.doc.toString()).toBe(details)
    expect(view.state.field(foldState).folded.size).toBe(0)
  })

  test('HTML takes two deletion presses and one undo restores the fence', () => {
    const text = 'before\n' + html + '\nafter'
    const block = classifyDocument(text).blocks.html[0]!
    for (const [forward, position] of [[true, 6], [true, block.from], [false, block.to], [false, block.to + 1]] as const) {
      const view = viewFor(stateFor(text, position))
      const decorations = view.state.field(htmlBlockDecorations)
      expect(key(view, forward ? 'Delete' : 'Backspace')).toBe(true)
      expect(view.state.doc.toString()).toBe(text)
      expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([block.from, block.to])
      expect(view.state.field(htmlBlockDecorations)).toBe(decorations)
      expect(undoDepth(view.state)).toBe(0)
      expect(key(view, forward ? 'Delete' : 'Backspace')).toBe(true)
      expect(view.state.doc.toString()).toBe('before\n\nafter')
      expect(undoDepth(view.state)).toBe(1)
      expect(undo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe(text)
    }
    expect(deleteAdjacentBlock(true)(viewFor(stateFor(text, 2)))).toBe(false)
  })

  test('multiple carets reveal their folds without deleting at other carets', () => {
    const text = '# One\nbody\n# Two\nbody\n# Leaf'
    let state = stateFor(text).update({ effects: setAllFoldsOpen.of(false) }).state
    const positions = state.field(foldState).candidates.map(candidate => candidate.hidden.from)
    state = state.update({ selection: EditorSelection.create(positions.map(position => EditorSelection.cursor(position))) }).state
    const view = viewFor(state)
    expect(deleteAdjacentBlock(true)(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(text)
    expect(view.state.field(foldState).folded.size).toBe(0)
  })

  test('composition and read only views do not run the block commands', () => {
    const state = stateFor(html)
    expect(deleteAdjacentBlock(true)(viewFor(state, true))).toBe(false)
    expect(enterDetailsBody(viewFor(stateFor(details, details.indexOf('</summary>')), true))).toBe(false)
    const readonly = EditorState.create({ doc: html, extensions: [editorExtensions('other'), EditorState.readOnly.of(true)] })
    expect(deleteAdjacentBlock(true)(viewFor(readonly))).toBe(false)
  })

  test('removing an ordinary folded header prefix reveals its body', () => {
    const text = '# Project\nbody'
    const initial = stateFor(text).update({ effects: setAllFoldsOpen.of(false) }).state
    const view = viewFor(initial.update({ selection: { anchor: 0, head: 2 } }).state)
    expect(key(view, 'Backspace')).toBe(true)
    expect(view.state.doc.toString()).toBe('Project\nbody')
    expect(view.state.field(foldState).folded.size).toBe(0)
  })
})

describe('typing around details', () => {
  test('typing before and after the end marker creates lines on the correct side including EOF', () => {
    const text = '  <details open><summary>Title</summary>\r\n    body\r\n  </details>'
    const block = classifyDocument(text).blocks.details[0]!
    for (const before of [true, false]) {
      const at = before ? block.close.from : block.to
      const state = openState(text, at).update(blockTyping(openState(text, at), at, at, 'new')!).state
      expect(state.doc.toString()).toBe(before ? text.replace('  </details>', '    new\r\n  </details>') : text + '\r\n  new')
      expect(state.doc.sliceString(state.selection.main.head - 3, state.selection.main.head)).toBe('new')
      expect(state.field(classifiedDocument).blocks.details).toHaveLength(1)
    }
  })

  test('Enter anywhere from the title end through the hidden suffix enters the body and opens details', () => {
    for (const text of [details, '<details>\n<summary>Title</summary>\n</details>']) {
      const block = classifyDocument(text).blocks.details[0]!
      const headerEnd = classifyDocument(text).lines[block.summaryLine]!.to
      for (const at of [block.title.to, block.title.to + 2, headerEnd]) {
        const view = viewFor(stateFor(text, at))
        expect(key(view, 'Enter')).toBe(true)
        expect(view.state.doc.toString()).toBe(text.slice(0, headerEnd) + '\n' + text.slice(headerEnd))
        expect(view.state.selection.main.head).toBe(headerEnd + 1)
        expect(view.state.field(foldState).folded.size).toBe(0)
      }
    }
  })

  test('multiline summary paste preserves the title and inserts indented body lines once', () => {
    const text = '  <details><summary>Title</summary>\n    body\n  </details>'
    const at = text.indexOf('Title') + 2
    const initial = stateFor(text, at, at + 1)
    const spec = pasteMarkdown(initial, 'first\nsecond')!
    const state = initial.update(spec).state
    expect(state.doc.toString()).toBe(text.replace('</summary>', '</summary>\n    first\n    second'))
    expect(state.doc.sliceString(state.selection.main.head - 6, state.selection.main.head)).toBe('second')
    expect(state.field(foldState).folded.size).toBe(0)
    const view = viewFor(state)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(text)
  })

  test('direct paste and composition input transactions route before syntax cleanup', () => {
    for (const event of ['input.paste', 'input.type.compose']) {
      const at = details.indexOf('Title') + 2
      const state = stateFor(details, at).update({
        changes: { from: at, insert: 'one\ntwo' }, selection: { anchor: at + 7 }, userEvent: event,
      }).state
      expect(state.doc.toString()).toBe(details.replace('</summary>', '</summary>\none\ntwo'))
      expect(state.doc.sliceString(state.selection.main.head - 3, state.selection.main.head)).toBe('two')
    }
  })

  test('multiple summary carets insert body text with mapped selections', () => {
    const text = details + '\n' + details
    const positions = [text.indexOf('Title'), text.lastIndexOf('Title')]
    const state = stateFor(text).update({ selection: EditorSelection.create(positions.map(position => EditorSelection.cursor(position))) }).state
    const result = state.update(blockInput(state, 'a\nb')!).state
    expect(result.doc.toString()).toBe(text.replaceAll('</summary>', '</summary>\na\nb'))
    expect(result.selection.ranges).toHaveLength(2)
    for (const range of result.selection.ranges) expect(result.doc.sliceString(range.head - 1, range.head)).toBe('b')
  })

  test('ordinary folded task Enter continues after its block and Shift Enter reveals a new note', () => {
    const text = '- [ ] Task\n  note\n- [ ] Next'
    for (const shift of [false, true]) {
      const initial = stateFor(text, 10).update({ effects: setAllFoldsOpen.of(false) }).state
      const view = viewFor(initial)
      expect(key(view, shift ? 'Shift-Enter' : 'Enter')).toBe(true)
      expect(view.state.doc.toString()).toBe(shift ? '- [ ] Task\n    \n  note\n- [ ] Next' : '- [ ] Task\n  note\n- [ ] \n- [ ] Next')
      if (shift) expect(view.state.field(foldState).folded.size).toBe(0)
    }
  })

  test('deleting the final title character keeps balanced tags and an editable empty title', () => {
    const text = details.replace('Title', 'X')
    const at = text.indexOf('</summary>')
    const view = viewFor(stateFor(text, at))
    expect(key(view, 'Backspace')).toBe(true)
    expect(view.state.doc.toString()).toBe(text.replace('X', ''))
    expect(view.state.field(classifiedDocument).blocks.details).toHaveLength(1)
    expect(view.state.selection.main.head).toBe(text.indexOf('X'))
  })

  test('pointer and keyboard carets skip hidden tags while title and boundary positions stay editable', () => {
    const text = '<details open>\n<summary>Title</summary>\nbody\n</details>'
    const block = classifyDocument(text).blocks.details[0]!
    const title = block.title
    for (const [at, expected] of [[2, title.from], [title.to + 2, title.to], [block.close.from + 2, block.close.from]]) {
      const state = stateFor(text).update({ selection: { anchor: at! }, userEvent: 'select.pointer' }).state
      expect(state.selection.main.head).toBe(expected!)
    }
    const left = stateFor(text, title.from).update({ selection: { anchor: title.from - 1 }, userEvent: 'select' }).state
    expect(left.selection.main.head).toBe(block.from)
    for (const at of [title.from, title.to, block.close.from, block.to]) {
      expect(stateFor(text).update({ selection: { anchor: at }, userEvent: 'select' }).state.selection.main.head).toBe(at)
    }
  })

  test('remote transactions bypass widening replacement refusal typing redirection and caret filters', () => {
    for (const event of ['delete.backward', 'input.type', 'input.replace.all', 'input.paste']) {
      const notices: string[] = []
      const state = stateFor(details, 0, 0, notices).update({
        changes: { from: 1, to: 2, insert: 'X' }, selection: { anchor: 3 }, userEvent: event,
        annotations: remoteTransaction.of(1),
      }).state
      expect(state.doc.toString()).toBe(details.slice(0, 1) + 'X' + details.slice(2))
      expect(state.selection.main.head).toBe(3)
      expect(notices).toEqual([])
    }
    const at = details.indexOf('Title')
    const state = stateFor(details).update({ changes: { from: at, insert: 'a\nb' }, annotations: remoteTransaction.of(1), userEvent: 'input.paste' }).state
    expect(state.doc.toString()).toBe(details.slice(0, at) + 'a\nb' + details.slice(at))
    expect(stateFor(details).update({ selection: { anchor: 2 }, userEvent: 'select', annotations: remoteTransaction.of(1) }).state.selection.main.head).toBe(2)
  })
})

describe('HTML selection feedback', () => {
  test('selection toggles the visible host class without rebuilding widget decorations', () => {
    const initial = stateFor(html)
    const target = viewFor(initial)
    const classes = new Set<string>()
    const host = { classList: { toggle(name: string, force: boolean) { if (force) classes.add(name); else classes.delete(name) } } }
    const view = {
      get state() { return target.state },
      contentDOM: { querySelectorAll: () => [host] }, posAtDOM: () => 0,
      requestMeasure(request: { write(): void }) { request.write() },
    } as unknown as EditorView
    const plugin = new HtmlSelectionFeedback(view)
    const decorations = target.state.field(htmlBlockDecorations)
    expect(classes.has('pt-html-section-selected')).toBe(false)
    expect(deleteAdjacentBlock(true)(target)).toBe(true)
    plugin.refresh()
    expect(classes.has('pt-html-section-selected')).toBe(true)
    expect(target.state.field(htmlBlockDecorations)).toBe(decorations)
    target.dispatch({ selection: { anchor: 0 } })
    plugin.refresh()
    expect(classes.has('pt-html-section-selected')).toBe(false)
    plugin.destroy()
  })
})
