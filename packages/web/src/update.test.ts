import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'

import type { SyncRequest } from './model'

import { ApplySelection, SyncDraft, WaitBeforeReconnect } from './command'
import { Message } from './message'
import { ConnectionState, DocumentState, makeInitialModel, Model } from './model'
import { subscriptions } from './subscription'
import { update } from './update'

const readyModel = (draft = '- [ ] Ship\n', inFlight?: SyncRequest): Model => ({
  document: DocumentState.Ready({
    document: {
      path: '/tmp/TODO.md',
      base: { version: 1, text: '- [ ] Ship\n' },
      draft,
      inFlight: Option.fromNullishOr(inFlight),
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

describe('sync update state machine', () => {
  test('checkbox edits send one sync from the current base', () => {
    story(
      update,
      given(readyModel()),
      message(Message.ClickedTodo({ number: 1 })),
      Command.expectExact(SyncDraft),
      Command.resolve(SyncDraft, Message.FailedSync({ unauthorized: false })),
      model(next => {
        expect(next.document._tag).toBe('Ready')
        if (next.document._tag === 'Ready') {
          expect(next.document.document.draft).toBe('- [x] Ship\n')
          expect(next.document.document.inFlight._tag).toBe('None')
        }
      }),
    )
  })

  test('a reply adopts the sent draft when it did not change', () => {
    const sending = readyModel('- [x] Ship\n', { path: '/tmp/TODO.md', base: 1, text: '- [x] Ship\n' })
    story(
      update,
      given(sending),
      message(Message.SucceededSync({ request: { base: 1, text: '- [x] Ship\n' }, version: 2, text: '- [x] Ship\n' })),
      Command.resolve(ApplySelection, Message.CompletedApplySelection()),
      model(next => {
        if (next.document._tag === 'Ready') {
          expect(next.document.document.base.version).toBe(2)
          expect(next.document.document.draft).toBe('- [x] Ship\n')
          expect(next.document.document.inFlight._tag).toBe('None')
        }
      }),
    )
  })

  test('a reply keeps a dirty draft and sends it again from the reply base', () => {
    const sending = readyModel('- [x] Ship\n- [ ] Test\n', { path: '/tmp/TODO.md', base: 1, text: '- [x] Ship\n' })
    story(
      update,
      given(sending),
      message(Message.SucceededSync({ request: { base: 1, text: '- [x] Ship\n' }, version: 2, text: '- [x] Ship\n' })),
      Command.expectHas(SyncDraft),
      Command.resolve(ApplySelection, Message.CompletedApplySelection()),
      Command.resolve(SyncDraft, Message.FailedSync({ unauthorized: false })),
      model(next => {
        if (next.document._tag === 'Ready') {
          expect(next.document.document.draft).toBe('- [x] Ship\n- [ ] Test\n')
          expect(next.document.document.base.version).toBe(2)
        }
      }),
    )
  })

  test('a Change while dirty keeps the draft and starts a merge sync', () => {
    story(
      update,
      given(readyModel('- [ ] Ship\n- [ ] Test\n')),
      message(
        Message.ReceivedWatchEvent({
          event: { from: 1, to: 2, by: [{ _tag: 'Agent', name: 't3' }], diff: null, todos: [], text: '- [x] Ship\n', _tag: 'Change' },
        }),
      ),
      Command.expectExact(SyncDraft),
      Command.resolve(SyncDraft, Message.FailedSync({ unauthorized: false })),
      model(next => {
        if (next.document._tag === 'Ready') {
          expect(next.document.document.draft).toBe('- [ ] Ship\n- [ ] Test\n')
          expect(next.document.document.inFlight._tag).toBe('None')
        }
        expect(next.activity).toHaveLength(1)
      }),
    )
  })

  test('a failed watch enters reconnecting with a backoff command', () => {
    story(
      update,
      given(readyModel()),
      message(Message.FailedWatch({ unauthorized: false })),
      Command.expectExact(WaitBeforeReconnect),
      Command.resolve(WaitBeforeReconnect, Message.CompletedWaitBeforeReconnect()),
      model(next => {
        if (next.document._tag === 'Ready') expect(next.document.document.connection._tag).toBe('Reconnecting')
      }),
    )
  })

  test('a Change keeps watch dependencies stable, reconnect resumes from the last version', () => {
    const initial = readyModel()
    const initialDependencies = subscriptions.watch.modelToDependencies(initial)
    let changedModel: Model | undefined

    story(
      update,
      given(initial),
      message(
        Message.ReceivedWatchEvent({
          event: {
            _tag: 'Change',
            from: 1,
            to: 2,
            by: [{ _tag: 'User' }],
            diff: null,
            todos: [],
            text: '- [x] Ship\n',
          },
        }),
      ),
      Command.resolve(ApplySelection, Message.CompletedApplySelection()),
      model(next => {
        changedModel = next
        expect(subscriptions.watch.modelToDependencies(next)).toEqual(initialDependencies)
      }),
    )

    if (changedModel === undefined) throw new Error('Change story did not produce a model')
    const beforeReconnect = subscriptions.watch.modelToDependencies(changedModel)

    story(
      update,
      given(changedModel),
      message(Message.WatchEnded()),
      Command.expectExact(WaitBeforeReconnect),
      Command.resolve(WaitBeforeReconnect, Message.CompletedWaitBeforeReconnect()),
      model(next => {
        const afterReconnect = subscriptions.watch.modelToDependencies(next)
        expect(afterReconnect).not.toEqual(beforeReconnect)
        if (afterReconnect.maybeWatch._tag === 'Some') {
          expect(afterReconnect.maybeWatch.value.watchKey).toBe(1)
          expect(Option.getOrThrow(afterReconnect.maybeWatch.value.resumeFrom)).toBe(2)
        }
      }),
    )
  })

  test('Deleted stops editing', () => {
    const initial = makeInitialModel('/tmp/TODO.md')
    story(
      update,
      given(initial),
      message(Message.ReceivedWatchEvent({ event: { _tag: 'Deleted' } })),
      model(next => expect(next.document._tag).toBe('Deleted')),
    )
  })
})
