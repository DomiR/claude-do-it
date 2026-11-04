import { describe, expect, test } from 'bun:test'

import { addTaskText, toggleTodoText } from './sync'
import { mapSelection } from './selection'

describe('selection mapping', () => {
  test('maps offsets through a changed middle', () => {
    expect(mapSelection('before after', 'before very after', { start: 7, end: 7 })).toEqual({ start: 7, end: 7 })
    expect(mapSelection('before after', 'before very after', { start: 12, end: 12 })).toEqual({ start: 17, end: 17 })
  })

  test('preserves a selection in the common suffix', () => {
    expect(mapSelection('alpha beta', 'alpha new beta', { start: 8, end: 10 })).toEqual({ start: 12, end: 14 })
  })
})

describe('todo text edits', () => {
  test('toggles an open task to done', () => {
    expect(toggleTodoText('- [ ] Ship\n', 1)).toBe('- [x] Ship\n')
  })

  test('adds a task to a section', () => {
    expect(addTaskText('# Work\n\n- [ ] Ship\n', 'Write tests', 'work')).toBe('# Work\n\n- [ ] Ship\n- [ ] Write tests\n')
  })
})
