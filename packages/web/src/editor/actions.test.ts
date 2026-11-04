import { describe, expect, test } from 'bun:test'

import { applyEdits } from '@do-it/doc/text'

import { runAction } from './actions'
import type { ActionResult, ActionId, TextSelection } from './types'

const NOW = new Date(2026, 10, 4, 21, 32)
const STAMP = '26-11-04 21:32'

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

function action(text: string, selection: TextSelection, id: ActionId, now = NOW): ActionResult {
  return runAction(text, selection, id, now)
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
    applied(text, action(text, caret(text.indexOf('Open')), 'toggleDone'), `- [x] Open @done (${STAMP})\n- [x] Done\n- [X] Upper\n- [-] Cancelled`, caret(text.indexOf('Open')))
    applied(text, action(text, caret(text.indexOf('Done')), 'toggleDone'), '- [ ] Open\n- [ ] Done\n- [X] Upper\n- [-] Cancelled', caret(text.indexOf('Done')))
    applied(text, action(text, caret(text.indexOf('Upper')), 'toggleDone'), '- [ ] Open\n- [x] Done\n- [ ] Upper\n- [-] Cancelled', caret(text.indexOf('Upper')))
    applied(text, action(text, caret(text.indexOf('Cancelled')), 'toggleDone'), `- [ ] Open\n- [x] Done\n- [X] Upper\n- [x] Cancelled @done (${STAMP})`, caret(text.indexOf('Cancelled')))
  })

  test('uses the owning task when the caret is on a status line', () => {
    const text = '- [ ] Plan\n  - **t1** M, planning'
    applied(text, action(text, caret(text.indexOf('planning')), 'toggleDone'), `- [x] Plan @done (${STAMP})\n  - **t1** M, planning`, caret(text.indexOf('planning') + ` @done (${STAMP})`.length))
  })

  test('toggles every task intersected by multiple ranges and excludes a range ending at a line start', () => {
    const text = '- [ ] One\n- [ ] Two\n- [ ] Three'
    const selection: TextSelection = {
      ranges: [range(0, text.indexOf('\n')), range(text.indexOf('Two'), text.indexOf('- [ ] Three'))],
      main: 1,
    }
    const next = `- [x] One @done (${STAMP})\n- [x] Two @done (${STAMP})\n- [ ] Three`
    const shift = ` @done (${STAMP})`.length
    applied(text, action(text, selection, 'toggleDone'), next, {
      ranges: [range(0, text.indexOf('\n') + shift), range(text.indexOf('Two') + shift, text.indexOf('- [ ] Three') + shift * 2)],
      main: 1,
    })
  })

  test('reports no task on prose', () => {
    unavailable(action('A paragraph', caret(3), 'toggleDone'), 'No task on this line')
  })
})

describe('toggleCancelled', () => {
  test('cycles open and cancelled while leaving completed tasks unchanged', () => {
    const text = '- [ ] Open\n- [-] Cancelled\n- [x] Done'
    applied(text, action(text, caret(text.indexOf('Open')), 'toggleCancelled'), `- [-] Open @cancelled (${STAMP})\n- [-] Cancelled\n- [x] Done`, caret(text.indexOf('Open')))
    applied(text, action(text, caret(text.indexOf('Cancelled')), 'toggleCancelled'), '- [ ] Open\n- [ ] Cancelled\n- [x] Done', caret(text.indexOf('Cancelled')))
    unavailable(action(text, caret(text.indexOf('Done')), 'toggleCancelled'), 'Reopen completed tasks before cancelling')
  })

  test('swaps a stale done stamp and keeps the started stamp', () => {
    const text = `- [ ] Work @started(${STAMP}) @done (${STAMP})`
    const next = `- [-] Work @started(${STAMP}) @cancelled (${STAMP})`
    applied(text, action(text, caret(text.indexOf('Work')), 'toggleCancelled'), next, caret(text.indexOf('Work')))
  })
})

describe('archive', () => {
  test('creates an archive without a final newline and moves a resolved task', () => {
    const text = `# Work\n- [x] Ship @done (${STAMP})`
    const next = `# Work\n\n## Archive\n\n- [x] Ship @done (${STAMP}) @project(Work)`
    applied(text, action(text, caret(text.indexOf('Ship')), 'archive'), next, caret(lastLabel(next, '- [x] ')))
  })

  test('keeps a blank separator after a block before the next heading', () => {
    const text = '# Now\n- [x] Shipped\n\n# Later'
    const next = '# Now\n\n# Later\n\n## Archive\n\n- [x] Shipped @project(Now)'
    applied(text, action(text, caret(text.indexOf('Shipped')), 'archive'), next, caret(next.indexOf('Shipped')))
  })

  test('removes the leading blank when a block already follows one', () => {
    const text = '# Now\n\n- [x] Shipped\n\n# Later'
    const next = '# Now\n\n# Later\n\n## Archive\n\n- [x] Shipped @project(Now)'
    applied(text, action(text, caret(text.indexOf('Shipped')), 'archive'), next, caret(next.indexOf('Shipped')))
  })

  test('swallows the following blank for a block at the document start', () => {
    const text = '- [x] Shipped\n\n# Later'
    const next = '# Later\n\n## Archive\n\n- [x] Shipped'
    applied(text, action(text, caret(text.indexOf('Shipped')), 'archive'), next, caret(next.indexOf('Shipped')))
  })

  test('keeps separators when several archived blocks are adjacent', () => {
    const text = '# Now\n- [x] One\n- [x] Two\n- [x] Three\n\n# Later'
    const next = '# Now\n\n# Later\n\n## Archive\n\n- [x] Three @project(Now)\n- [x] Two @project(Now)\n- [x] One @project(Now)'
    applied(text, action(text, caret(text.indexOf('One')), 'archive'), next, caret(next.indexOf('One')))
  })

  test('places a newly archived task at the top of an archive', () => {
    const text = '## Archive\n- [x] Old\n# Work\n- [x] Ship'
    const next = '## Archive\n- [x] Ship @project(Work)\n- [x] Old\n# Work\n'
    const result = action(text, caret(text.indexOf('Ship')), 'archive')
    applied(text, result, next, caret(next.indexOf('Ship')))
  })

  test('archives multiple tasks newest first and tags each nearest project', () => {
    const text = '# Alpha\n- [x] One\n## Beta\n- [-] Two'
    const next = '# Alpha\n## Beta\n\n## Archive\n\n- [-] Two @project(Beta)\n- [x] One @project(Alpha)'
    applied(text, action(text, caret(text.indexOf('One')), 'archive'), next, caret(next.indexOf('One')))
  })

  test('does not add a project tag when the task has no heading or already has one', () => {
    const text = '- [x] Plain\n- [x] Tagged @project(Existing)'
    const next = '## Archive\n\n- [x] Tagged @project(Existing)\n- [x] Plain'
    applied(text, action(text, caret(text.indexOf('Plain')), 'archive'), next, caret(next.indexOf('Plain')))
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

  test('skips an empty resolved task', () => {
    const text = '- [x] \n- [x] Ship'
    const selection: TextSelection = { ranges: [range(0, text.indexOf('\n'))], main: 0 }
    unavailable(action(text, selection, 'archive'), 'No completed or cancelled tasks to archive')
  })
})

describe('moveUp and moveDown', () => {
  test('moves a task block down across a blank and a heading, then back up', () => {
    const text = '- [ ] A\n  - **t1** planning\n\n## Notes\n- [ ] B'
    const afterBlank = '\n- [ ] A\n  - **t1** planning\n## Notes\n- [ ] B'
    applied(text, action(text, caret(text.indexOf('A')), 'moveDown'), afterBlank, caret(afterBlank.indexOf('A')))

    const afterHeading = '\n## Notes\n- [ ] A\n  - **t1** planning\n- [ ] B'
    applied(afterBlank, action(afterBlank, caret(afterBlank.indexOf('A')), 'moveDown'), afterHeading, caret(afterHeading.indexOf('A')))
    applied(afterHeading, action(afterHeading, caret(afterHeading.indexOf('A')), 'moveUp'), afterBlank, caret(afterBlank.indexOf('A')))
    applied(afterBlank, action(afterBlank, caret(afterBlank.indexOf('A')), 'moveUp'), text, caret(text.indexOf('A')))
  })

  test('moves a prose line down past a complete task block', () => {
    const text = 'Intro\n- [ ] Task\n  - **t1** planning\nTail'
    const next = '- [ ] Task\n  - **t1** planning\nIntro\nTail'
    applied(text, action(text, caret(text.indexOf('Intro')), 'moveDown'), next, caret(next.indexOf('Intro')))
  })

  test('moves a heading up past a complete task block', () => {
    const text = '- [ ] Task\n  - **t1** planning\n## Notes'
    const next = '## Notes\n- [ ] Task\n  - **t1** planning'
    applied(text, action(text, caret(text.indexOf('Notes')), 'moveUp'), next, caret(next.indexOf('Notes')))
  })

  test('reports the first line up and last line down as unavailable', () => {
    const text = 'First\nLast'
    unavailable(action(text, caret(text.indexOf('First')), 'moveUp'), 'Already at the top')
    unavailable(action(text, caret(text.indexOf('Last')), 'moveDown'), 'Already at the bottom')
  })

  test('moves a nested child task up past its parent line', () => {
    const text = '- [ ] Parent\n  - [ ] Child\nAfter'
    const next = '  - [ ] Child\n- [ ] Parent\nAfter'
    applied(text, action(text, caret(text.indexOf('Child')), 'moveUp'), next, caret(next.indexOf('Child')))
  })

  test('moves two selected task blocks down past a status-bearing task block and back up', () => {
    const downText = '- [ ] A\n  - **t1** one\n- [ ] B\n  - **t2** two\n- [ ] C\n  - **t3** three'
    const downSelection: TextSelection = {
      ranges: [range(0, downText.indexOf('  - **t2** two') + '  - **t2** two'.length)],
      main: 0,
    }
    const downNext = '- [ ] C\n  - **t3** three\n- [ ] A\n  - **t1** one\n- [ ] B\n  - **t2** two'
    applied(downText, action(downText, downSelection, 'moveDown'), downNext, {
      ranges: [range(downNext.indexOf('- [ ] A'), downNext.indexOf('  - **t2** two') + '  - **t2** two'.length)],
      main: 0,
    })

    const upSelection: TextSelection = {
      ranges: [range(downNext.indexOf('- [ ] A'), downNext.indexOf('  - **t2** two') + '  - **t2** two'.length)],
      main: 0,
    }
    applied(downNext, action(downNext, upSelection, 'moveUp'), downText, downSelection)
  })

  test('moves line units without changing CRLF separators', () => {
    const text = 'Intro\r\n- [ ] Task\r\n  - **t1** planning\r\nTail'
    const next = '- [ ] Task\r\n  - **t1** planning\r\nIntro\r\nTail'
    applied(text, action(text, caret(text.indexOf('Intro')), 'moveDown'), next, caret(next.indexOf('Intro')))
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

  test('indents only a status or note line under its task', () => {
    const status = '- [ ] Parent\n  - **t1** status\n  note'
    applied(status, action(status, caret(status.indexOf('status')), 'indent'), '- [ ] Parent\n    - **t1** status\n  note', caret(status.indexOf('status') + 2))

    const note = '- [ ] Parent\n  - **t1** status\n  note'
    applied(note, action(note, caret(note.indexOf('note')), 'indent'), '- [ ] Parent\n  - **t1** status\n    note', caret(note.indexOf('note') + 2))
  })

  test('outdents only a status or note line under its task', () => {
    const status = '  - [ ] Parent\n    - **t1** status\n    note'
    applied(status, action(status, caret(status.indexOf('status')), 'outdent'), '  - [ ] Parent\n  - **t1** status\n    note', caret(status.indexOf('status') - 2))

    const note = '  - [ ] Parent\n    - **t1** status\n    note'
    applied(note, action(note, caret(note.indexOf('note')), 'outdent'), '  - [ ] Parent\n    - **t1** status\n  note', caret(note.indexOf('note') - 2))
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

describe('tab', () => {
  test('inserts every PlainTasks tag completion', () => {
    const cases = [
      ['s', '@started'],
      ['t', '@today'],
      ['c', '@critical'],
      ['h', '@high'],
      ['l', '@low'],
      ['cr', '@created'],
      ['d', '@due( )'],
      ['@s', `@started(${STAMP})`],
    ] as const
    for (const [trigger, replacement] of cases) {
      const text = `- [ ] ${trigger}`
      const next = `- [ ] ${replacement}`
      const expectedCaret = trigger === 'd' ? next.length - 1 : next.length
      applied(text, action(text, caret(text.length), 'tab'), next, caret(expectedCaret))
    }
  })

  test('adds a date after bare started and created tags', () => {
    for (const tag of ['@started', '@created']) {
      const text = `- [ ] ${tag}`
      const next = `- [ ] ${tag}(${STAMP})`
      applied(text, action(text, caret(text.length), 'tab'), next, caret(next.length))
    }
  })

  test('completes tags at label start and after an opening parenthesis', () => {
    const started = '- [ ] @started'
    const startedNext = `- [ ] @started(${STAMP})`
    applied(started, action(started, caret(started.length), 'tab'), startedNext, caret(startedNext.length))

    const parenthesized = '- [ ] (s'
    const parenthesizedNext = '- [ ] (@started'
    applied(parenthesized, action(parenthesized, caret(parenthesized.length), 'tab'), parenthesizedNext, caret(parenthesizedNext.length))
  })

  test('does not treat uppercase S as a tag completion', () => {
    const text = '- [ ] S'
    applied(text, action(text, caret(text.length), 'tab'), '  - [ ] S', caret(text.length + 2))
  })

  test('indents instead of completing an ordinary word or a task block', () => {
    const bus = '- [ ] bus'
    applied(bus, action(bus, caret(bus.length), 'tab'), '  - [ ] bus', caret(bus.length + 2))

    const block = '- [ ] Task\n  note'
    applied(block, action(block, caret(block.indexOf('Task')), 'tab'), '  - [ ] Task\n    note', caret(block.indexOf('Task') + 2))
  })

  test('is unavailable on a code line when no snippet applies', () => {
    unavailable(action('```\ncode\n```', caret(4), 'tab'), 'Nothing to change')
  })
})
