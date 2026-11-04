import { describe, expect, test } from 'bun:test'

import { applyEdits } from '@do-it/doc/text'

import { runAction } from './actions'
import type { ActionResult, ActionId, TextSelection } from './types'

function caret(at: number): TextSelection {
  return { ranges: [{ anchor: at, head: at }], main: 0 }
}

function range(anchor: number, head: number): { anchor: number; head: number } {
  return { anchor, head }
}

function applied(text: string, result: ActionResult, expectedText: string, expectedSelection: TextSelection): void {
  expect(result._tag).toBe('Applied')
  if (result._tag !== 'Applied') return
  expect(applyEdits(text, result.edits)).toBe(expectedText)
  expect(result.selection).toEqual(expectedSelection)
}

function unavailable(result: ActionResult, reason: string): void {
  expect(result).toEqual({ _tag: 'Unavailable', reason })
}

function lastLabel(text: string, marker = '- [ ] '): number {
  return text.lastIndexOf(marker) + marker.length
}

function action(text: string, selection: TextSelection, id: ActionId): ActionResult {
  return runAction(text, selection, id)
}

describe('newTask', () => {
  test('adds a sibling after an attached status line and preserves the marker', () => {
    const text = '* [ ] Plan\n  - **t1** M, planning'
    const next = '* [ ] Plan\n  - **t1** M, planning\n* [ ] '
    applied(text, action(text, caret(text.indexOf('Plan')), 'newTask'), next, caret(lastLabel(next, '* [ ] ')))
  })

  test('converts prose and maps the caret into the label', () => {
    const text = 'Write docs'
    const next = '- [ ] Write docs'
    applied(text, action(text, caret(3), 'newTask'), next, caret(9))
  })

  test('converts an ordinary list item with its existing content', () => {
    const text = '* item'
    const next = '- [ ] item'
    applied(text, action(text, caret(3), 'newTask'), next, caret(7))
  })

  test('creates a task on a blank line, a heading, and an empty document', () => {
    const blank = '  '
    const blankNext = '  - [ ] '
    applied(blank, action(blank, caret(0), 'newTask'), blankNext, caret(8))

    const heading = '# Work'
    const headingNext = '# Work\n- [ ] '
    applied(heading, action(heading, caret(2), 'newTask'), headingNext, caret(lastLabel(headingNext)))

    const emptyNext = '- [ ] '
    applied('', action('', caret(0), 'newTask'), emptyNext, caret(6))
  })
})

describe('toggleDone', () => {
  test('toggles open, completed, uppercase completed, and cancelled tasks', () => {
    const text = '- [ ] Open\n- [x] Done\n- [X] Upper\n- [-] Cancelled'
    const next = '- [x] Open\n- [ ] Done\n- [ ] Upper\n- [x] Cancelled'
    applied(text, action(text, caret(text.indexOf('Open')), 'toggleDone'), '- [x] Open\n- [x] Done\n- [X] Upper\n- [-] Cancelled', caret(text.indexOf('Open')))
    applied(text, action(text, caret(text.indexOf('Done')), 'toggleDone'), '- [ ] Open\n- [ ] Done\n- [X] Upper\n- [-] Cancelled', caret(text.indexOf('Done')))
    applied(text, action(text, caret(text.indexOf('Upper')), 'toggleDone'), '- [ ] Open\n- [x] Done\n- [ ] Upper\n- [-] Cancelled', caret(text.indexOf('Upper')))
    applied(text, action(text, caret(text.indexOf('Cancelled')), 'toggleDone'), '- [ ] Open\n- [x] Done\n- [X] Upper\n- [x] Cancelled', caret(text.indexOf('Cancelled')))
  })

  test('uses the owning task when the caret is on a status line', () => {
    const text = '- [ ] Plan\n  - **t1** M, planning'
    const next = '- [x] Plan\n  - **t1** M, planning'
    applied(text, action(text, caret(text.indexOf('planning')), 'toggleDone'), next, caret(text.indexOf('planning')))
  })

  test('toggles every task intersected by multiple ranges and excludes a range ending at a line start', () => {
    const text = '- [ ] One\n- [ ] Two\n- [ ] Three'
    const selection: TextSelection = {
      ranges: [range(0, text.indexOf('\n')), range(text.indexOf('Two'), text.indexOf('- [ ] Three'))],
      main: 1,
    }
    const next = '- [x] One\n- [x] Two\n- [ ] Three'
    applied(text, action(text, selection, 'toggleDone'), next, selection)
  })

  test('reports no task on prose', () => {
    unavailable(action('A paragraph', caret(3), 'toggleDone'), 'No task on this line')
  })
})

describe('toggleCancelled', () => {
  test('cycles open and cancelled while leaving completed tasks unchanged', () => {
    const text = '- [ ] Open\n- [-] Cancelled\n- [x] Done'
    applied(text, action(text, caret(text.indexOf('Open')), 'toggleCancelled'), '- [-] Open\n- [-] Cancelled\n- [x] Done', caret(text.indexOf('Open')))
    applied(text, action(text, caret(text.indexOf('Cancelled')), 'toggleCancelled'), '- [ ] Open\n- [ ] Cancelled\n- [x] Done', caret(text.indexOf('Cancelled')))
    unavailable(action(text, caret(text.indexOf('Done')), 'toggleCancelled'), 'Reopen completed tasks before cancelling')
  })
})

describe('archive', () => {
  test('creates an archive without a final newline and moves a resolved task', () => {
    const text = '# Work\n- [x] Ship'
    const next = '# Work\n\n## Archive\n\n- [x] Ship'
    applied(text, action(text, caret(text.indexOf('Ship')), 'archive'), next, caret(lastLabel(next, '- [x] ')))
  })

  test('appends to an archive at offset zero before the next project', () => {
    const text = '## Archive\n- [x] Old\n# Work\n- [x] Ship'
    const next = '## Archive\n- [x] Old\n- [x] Ship\n# Work\n'
    const result = action(text, caret(text.indexOf('Ship')), 'archive')
    applied(text, result, next, caret(next.indexOf('Ship')))
  })

  test('keeps a resolved descendant eligible when its parent has an open child', () => {
    const text = '- [x] Parent\n  - [ ] Open child\n  - [x] Done child'
    const next = '- [x] Parent\n  - [ ] Open child\n\n## Archive\n\n- [x] Done child'
    applied(text, action(text, caret(text.indexOf('Done child')), 'archive'), next, caret(next.lastIndexOf('Done child')))
  })

  test('does not archive a resolved parent containing an open child', () => {
    const text = '- [x] Parent\n  - [ ] Open child'
    unavailable(action(text, caret(text.indexOf('Parent')), 'archive'), 'No completed or cancelled tasks to archive')
  })

  test('moves attached status lines with the task and respects a nonempty selection', () => {
    const text = '- [x] Ship\n  - **t1** M, planning\n- [x] Other'
    const next = '- [x] Other\n\n## Archive\n\n- [x] Ship\n  - **t1** M, planning'
    const selection: TextSelection = { ranges: [range(0, text.indexOf('\n'))], main: 0 }
    const result = action(text, selection, 'archive')
    applied(text, result, next, {
      ranges: [range(next.lastIndexOf('- [x] Ship'), next.lastIndexOf('- [x] Ship') + text.indexOf('\n'))],
      main: 0,
    })
  })

  test('archives only the selected resolved task, preserves CRLF, and is unavailable on repeat', () => {
    const text = '- [x] One\r\n- [x] Two\r\n'
    const selection: TextSelection = { ranges: [range(0, text.indexOf('\r\n'))], main: 0 }
    const next = '- [x] Two\r\n\r\n## Archive\r\n\r\n- [x] One\r\n'
    const result = action(text, selection, 'archive')
    applied(text, result, next, {
      ranges: [range(next.lastIndexOf('- [x] One'), next.lastIndexOf('- [x] One') + text.indexOf('\r\n'))],
      main: 0,
    })
    const alreadyArchived = '## Archive\r\n\r\n- [x] One\r\n- [x] Two\r\n'
    unavailable(action(alreadyArchived, caret(alreadyArchived.indexOf('One')), 'archive'), 'No completed or cancelled tasks to archive')
  })
})

describe('moveUp and moveDown', () => {
  test('moves sibling blocks with their blank separator and maps the caret', () => {
    const text = '- [ ] A\n\n- [ ] B\n'
    const up = '- [ ] B\n\n- [ ] A\n'
    applied(text, action(text, caret(text.indexOf('B')), 'moveUp'), up, caret(up.indexOf('B')))

    const down = '- [ ] B\n\n- [ ] A\n'
    applied(text, action(text, caret(text.indexOf('A')), 'moveDown'), down, caret(down.indexOf('A')))
  })

  test('reports the edges and never crosses a heading', () => {
    const text = '- [ ] A\n- [ ] B'
    unavailable(action(text, caret(text.indexOf('A')), 'moveUp'), 'Already at the top')
    unavailable(action(text, caret(text.indexOf('B')), 'moveDown'), 'Already at the bottom')

    const separated = '- [ ] A\n# Next\n- [ ] B'
    unavailable(action(separated, caret(separated.indexOf('B')), 'moveUp'), 'Already at the top')
  })

  test('moves nested siblings without moving their parent', () => {
    const text = '- [ ] Parent\n  - [ ] A\n\n  - [ ] B'
    const next = '- [ ] Parent\n  - [ ] B\n\n  - [ ] A'
    applied(text, action(text, caret(text.indexOf('B')), 'moveUp'), next, caret(next.indexOf('B')))
  })
})

describe('continueTask', () => {
  test('splits a nonempty label at the caret', () => {
    const text = '- [ ] Alpha Beta'
    const next = '- [ ] Alpha \n- [ ] Beta'
    const at = text.indexOf('Alpha') + 'Alpha '.length
    applied(text, action(text, caret(at), 'continueTask'), next, caret(lastLabel(next)))
  })

  test('places a sibling after attached children at the end of a label', () => {
    const text = '- [ ] Parent\n  note'
    const next = '- [ ] Parent\n  note\n- [ ] '
    applied(text, action(text, caret(text.indexOf('\n')), 'continueTask'), next, caret(lastLabel(next)))
  })

  test('exits an empty task and falls back for a non task line', () => {
    const text = '  * [ ] '
    applied(text, action(text, caret(text.length), 'continueTask'), '  ', caret(2))
    unavailable(action('Plain text', caret(4), 'continueTask'), 'Not a task')
  })
})

describe('indent and outdent', () => {
  test('indents a task block including its attached note', () => {
    const text = '- [ ] Parent\n  note'
    const next = '  - [ ] Parent\n    note'
    applied(text, action(text, caret(text.indexOf('Parent')), 'indent'), next, caret(next.indexOf('Parent')))
  })

  test('outdents a task block by two spaces', () => {
    const text = '  - [ ] Parent\n    note'
    const next = '- [ ] Parent\n  note'
    applied(text, action(text, caret(text.indexOf('Parent')), 'outdent'), next, caret(next.indexOf('Parent')))
  })

  test('indents selected ordinary lines and leaves code unchanged', () => {
    const text = 'one\ntwo'
    const selection: TextSelection = { ranges: [range(0, text.length)], main: 0 }
    const next = '  one\n  two'
    applied(text, action(text, selection, 'indent'), next, { ranges: [range(2, 11)], main: 0 })

    const code = '```\ncode\n```'
    unavailable(action(code, caret(code.indexOf('code')), 'indent'), 'Nothing to change')
  })
})
