import { Option } from 'effect'
import { all, expect, expectAll, given, label, placeholder, scene, selector, tap, text, textContent } from 'foldkit/scene'
import { describe, expect as bunExpect, test } from 'bun:test'

import { ConnectionState, DocumentState, type Model } from './model'
import { update } from './update'
import { view } from './view'

const readyModel = (text: string): Model => ({
  document: DocumentState.Ready({
    document: {
      path: '/tmp/DEMO.md',
      base: { version: 1, text },
      draft: text,
      inFlight: Option.none(),
      draftRevision: 0,
      watchKey: 0,
      resumeFrom: Option.none(),
      reconnectAttempt: 0,
      connection: ConnectionState.Live(),
      selection: { start: 0, end: 0 },
    },
  }),
  mode: 'Tasks',
  taskInputs: [],
  activity: [],
  highlightedTodos: [],
})

describe('Tasks view', () => {
  test('renders task details, stateful checkboxes, and the add field', () => {
    const sample = `## Tasks
- [ ] Ship the editor
  - **t1** M, planning with \`Fable\`
- [x] Write the design
- [ ] Add a TUI later
`

    scene(
      { update, view },
      given(readyModel(sample)),
      expect(selector('strong')).toHaveText('t1'),
      expect(selector('code')).toHaveText('Fable'),
      expect(text('t1 M, planning with Fable')).toExist(),
      expect(label('Reopen Write the design')).toBeChecked(),
      expect(placeholder('Add a task')).toExist(),
      expectAll(all.selector('.task-row')).toHaveCount(3),
      tap(({ html }) => {
        const visibleText = textContent(html)
        bunExpect(visibleText.match(/Ship the editor/g) ?? []).toHaveLength(1)
        bunExpect(visibleText.match(/t1 M, planning with Fable/g) ?? []).toHaveLength(1)
      }),
    )
  })

  test('omits empty task rows and disables cancelled tasks', () => {
    const sample = `## Tasks
- [ ] 
- [-] Cancelled
`

    scene(
      { update, view },
      given(readyModel(sample)),
      expectAll(all.selector('.task-row')).toHaveCount(1),
      expect(label('Cancelled Cancelled')).toBeDisabled(),
      expect(placeholder('Add a task')).toExist(),
    )
  })
})
