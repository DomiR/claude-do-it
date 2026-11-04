import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { Option } from 'effect'
import { Command, given, message, model, story, type StorySimulation } from 'foldkit/story'

import {
  ApplyRemoteText, FocusEditor, RevealEditorPosition, RunEditorAction, SyncDraft,
  WaitBeforeReconnect, WaitBeforeRemoteRetry, WaitBeforeSync, WaitBeforeSyncRetry,
} from './command'
import { rebaseRemote } from './editor/changes'
import { Message } from './message'
import { DocumentState, makeInitialModel, saveStatus, type Model, type ReadyDocument } from './model'
import { subscriptions } from './subscription'
import { update } from './update'
import { paletteItems } from './view/palette'

const path = '/tmp/TODO.md'
const session = `${path}:0`
const original = '- [ ] Ship\n'
const sent = '- [x] Ship\n'
const readyModel = (text = original): Model => update(makeInitialModel(path, 'mac'), Message.ReceivedWatchEvent({
  event: { _tag: 'Watching', version: 1, text },
})).model
const documentOf = (model: Model): ReadyDocument => {
  if (model.document._tag !== 'Ready') throw new Error('Expected a ready document')
  return model.document.document
}
const edited = (text: string, origin: 'Input' | 'Action' = 'Input') => Message.UpdatedEditor({
  session, text, anchor: text.length, head: text.length, origin, token: null,
})
const remote = (token: number, text: string) => Message.UpdatedEditor({ session, token, text, anchor: 0, head: 0, origin: 'Remote' })
const changed = (to: number, text: string) => Message.ReceivedWatchEvent({
  event: { _tag: 'Change', from: 1, to, by: [{ _tag: 'Agent', name: 't3' }], diff: null, todos: [], text },
})
const reply = (base: number, requestText: string, version: number, text = requestText) =>
  Message.SucceededSync({ request: { base, text: requestText }, version, text })
const merged = (from: string, to: string, live: string) => rebaseRemote(from, to, live)
  .apply(EditorState.create({ doc: live, extensions: [EditorState.lineSeparator.of('\n')] }).doc).toString()

// Story normally settles Commands before the next Message. These races need
// a Mount or watch fact while a Command remains outstanding, retaining every
// pending Command so Story still verifies and resolves all of them.
const whilePending = (fact: Message) => (simulation: StorySimulation<Model, Message>): StorySimulation<Model, Message> => {
  const next = update(simulation.model, fact)
  return { ...simulation, model: next.model, commands: [...simulation.commands, ...(next.commands ?? [])] }
}

describe('editor synchronization', () => {
  test('debounces typing and ignores an older revision timer', () => {
    const first = `${original}a`
    const second = `${original}ab`
    story(update, given(readyModel()),
      message(edited(first)),
      whilePending(edited(second)),
      Command.expectExact(WaitBeforeSync({ session, revision: 1 }), WaitBeforeSync({ session, revision: 2 })),
      Command.resolve(WaitBeforeSync({ session, revision: 1 }), Message.CompletedWaitBeforeSync({ session, revision: 1 })),
      Command.expectExact(WaitBeforeSync({ session, revision: 2 })),
      Command.resolve(WaitBeforeSync, Message.CompletedWaitBeforeSync({ session, revision: 2 })),
      Command.expectExact(SyncDraft({ path, base: 1, text: second })),
      Command.resolve(SyncDraft, reply(1, second, 2)),
      model(next => {
        expect(documentOf(next).draftRevision).toBe(2)
        expect(saveStatus(documentOf(next))).toBe('Saved')
      }),
    )
  })

  test('flushes an action immediately with the exact text from the editor', () => {
    story(update, given(readyModel()), message(edited(sent, 'Action')),
      Command.expectExact(SyncDraft({ path, base: 1, text: sent })),
      model(next => expect(documentOf(next).draft).toBe(sent)),
      Command.resolve(SyncDraft, reply(1, sent, 2)),
      model(next => expect(documentOf(next).base).toEqual({ version: 2, text: sent })),
    )
  })

  test('adopts a clean Change only when the remote editor fact arrives', () => {
    story(update, given(readyModel()), message(changed(2, sent)),
      Command.expectExact(ApplyRemoteText({ session, token: 1, from: original, to: sent })),
      model(next => {
        expect(documentOf(next).draft).toBe(original)
        expect(documentOf(next).base.version).toBe(1)
      }),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
      model(next => expect(documentOf(next).pendingRemote._tag).toBe('Some')),
      message(remote(1, sent)),
      model(next => {
        expect(documentOf(next).draft).toBe(sent)
        expect(documentOf(next).base).toEqual({ version: 2, text: sent })
        expect(saveStatus(documentOf(next))).toBe('Saved')
        expect(next.activity).toHaveLength(1)
      }),
    )
  })

  test('keeps typing that races with clean remote application', () => {
    const live = `${original}local\n`
    const combined = merged(original, sent, live)
    story(update, given(readyModel()), message(changed(2, sent)),
      whilePending(edited(live)),
      Command.resolve(WaitBeforeSync, Message.CompletedWaitBeforeSync({ session, revision: 1 })),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
      message(remote(1, combined)),
      Command.expectExact(SyncDraft({ path, base: 2, text: combined })),
      Command.resolve(SyncDraft, reply(2, combined, 3)),
      model(next => expect(documentOf(next).draft).toBe('- [x] Ship\nlocal\n')),
    )
  })

  test('drops an old snapshot and a sync echo while still recording Activity', () => {
    story(update, given(readyModel()), message(edited(sent, 'Action')),
      whilePending(changed(2, sent)),
      Command.resolve(SyncDraft, reply(1, sent, 2)),
      Command.expectNone(),
      message(changed(2, original)), message(changed(1, original)),
      model(next => {
        expect(documentOf(next).base).toEqual({ version: 2, text: sent })
        expect(documentOf(next).draft).toBe(sent)
        expect(documentOf(next).latestRemote._tag).toBe('None')
        expect(next.activity).toHaveLength(3)
      }),
    )
  })

  test('starts a merge sync from the original base when a Change arrives while dirty', () => {
    const live = `${original}local\n`
    const combined = `${sent}local\n`
    story(update, given(readyModel()), message(edited(live)), whilePending(changed(2, sent)),
      Command.expectExact(WaitBeforeSync({ session, revision: 1 }), SyncDraft({ path, base: 1, text: live })),
      Command.resolve(WaitBeforeSync, Message.CompletedWaitBeforeSync({ session, revision: 1 })),
      Command.resolve(SyncDraft, reply(1, live, 3, combined)),
      Command.expectExact(ApplyRemoteText({ session, token: 1, from: live, to: combined })),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
      message(remote(1, combined)), Command.expectNone(),
      model(next => expect(documentOf(next).base.version).toBe(3)),
    )
  })

  test('rebases a sync reply over later typing before sending all three contributions exactly once', () => {
    const typedMore = `${sent}- [ ] Local\n`
    const withAgent = `${sent}- [ ] Agent\n`
    const combined = merged(sent, withAgent, typedMore)
    expect(combined).toBe(`${sent}- [ ] Agent\n- [ ] Local\n`)
    story(update, given(readyModel()), message(edited(sent, 'Action')),
      whilePending(edited(typedMore)),
      Command.resolve(WaitBeforeSync, Message.CompletedWaitBeforeSync({ session, revision: 2 })),
      Command.resolve(SyncDraft, reply(1, sent, 3, withAgent)),
      Command.expectExact(ApplyRemoteText({ session, token: 1, from: sent, to: withAgent })),
      model(next => {
        expect(documentOf(next).draft).toBe(typedMore)
        expect(documentOf(next).base.version).toBe(1)
      }),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
      message(remote(1, combined)),
      Command.expectExact(SyncDraft({ path, base: 3, text: combined })),
      Command.resolve(SyncDraft, reply(3, combined, 4)),
      model(next => {
        expect(documentOf(next).draft).toBe(combined)
        for (const label of ['Ship', 'Agent', 'Local']) expect(documentOf(next).draft.split(label)).toHaveLength(2)
        expect(saveStatus(documentOf(next))).toBe('Saved')
      }),
    )
  })

  test('coalesces newer Changes while a sync is in flight and applies the newest after its reply', () => {
    const newest = `${sent}- [ ] Agent\n- [ ] Newest\n`
    story(update, given(readyModel()), message(edited(sent, 'Action')),
      whilePending(changed(3, `${sent}- [ ] Agent\n`)), whilePending(changed(4, newest)),
      whilePending(changed(2, original)),
      model(next => expect(Option.getOrThrow(documentOf(next).latestRemote).version).toBe(4)),
      Command.resolve(SyncDraft, reply(1, sent, 2)),
      Command.expectExact(ApplyRemoteText({ session, token: 1, from: sent, to: newest })),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
      message(remote(1, newest)),
      model(next => {
        expect(documentOf(next).base.version).toBe(4)
        expect(documentOf(next).draft).toBe(newest)
      }),
    )
  })

  test('coalesces a newer snapshot while a remote transaction is pending', () => {
    const newest = `${sent}agent\n`
    story(update, given(readyModel()), message(changed(2, sent)), whilePending(changed(3, newest)),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
      message(remote(1, sent)),
      Command.expectExact(ApplyRemoteText({ session, token: 2, from: sent, to: newest })),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 2 })),
      message(remote(2, newest)),
      model(next => expect(documentOf(next).draft).toBe(newest)),
    )
  })

  for (const dirty of [false, true]) {
    test(`rebases a ${dirty ? 'dirty' : 'clean'} Resync even at the current version`, () => {
      const live = dirty ? `${original}local\n` : original
      const snapshot = `agent\n${original}`
      const combined = merged(original, snapshot, live)
      const initial = readyModel()
      const withDraft = { ...initial, document: DocumentState.Ready({ document: { ...documentOf(initial), draft: live } }) }
      story(update, given(withDraft),
        message(Message.ReceivedWatchEvent({ event: { _tag: 'Resync', version: 1, text: snapshot } })),
        Command.expectExact(ApplyRemoteText({ session, token: 1, from: original, to: snapshot })),
        model(next => expect(documentOf(next).draft).toBe(live)),
        Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
        message(remote(1, combined)),
        ...(dirty ? [
          Command.expectExact(SyncDraft({ path, base: 1, text: combined })),
          Command.resolve(SyncDraft, reply(1, combined, 2)),
        ] : [Command.expectNone()]),
        model(next => expect(documentOf(next).draft).toBe(combined)),
      )
    })
  }

  test('Forgotten bumps the watch key and holds edits until Resync supplies a new base', () => {
    const snapshot = `agent\n${original}`
    const combined = merged(original, snapshot, sent)
    story(update, given(readyModel()), message(edited(sent, 'Action')),
      Command.resolve(SyncDraft, Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Forgotten' })),
      Command.expectNone(),
      model(next => {
        expect(documentOf(next).inFlight._tag).toBe('None')
        expect(documentOf(next).watchKey).toBe(1)
        expect(Option.getOrThrow(documentOf(next).resumeFrom)).toBe(1)
        expect(documentOf(next).base.version).toBe(1)
      }),
      message(Message.CompletedWaitBeforeSync({ session, revision: 1 })), Command.expectNone(),
      message(Message.ReceivedWatchEvent({ event: { _tag: 'Watching', version: 10, text: snapshot } })),
      Command.expectNone(),
      model(next => expect(documentOf(next).connection).toEqual({ _tag: 'Reconnecting', awaitingResync: true })),
      message(Message.ReceivedWatchEvent({ event: { _tag: 'Resync', version: 10, text: snapshot } })),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
      message(remote(1, combined)),
      Command.expectExact(SyncDraft({ path, base: 10, text: combined })),
      Command.resolve(SyncDraft, reply(10, combined, 11)),
    )
  })

  test('retries a Transient failure after a delay and resets the attempt on success', () => {
    story(update, given(readyModel()), message(edited(sent, 'Action')),
      Command.resolve(SyncDraft, Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Transient' })),
      Command.expectExact(WaitBeforeSyncRetry({ session, attempt: 1 })),
      Command.resolve(WaitBeforeSyncRetry, Message.CompletedWaitBeforeSyncRetry({ session, attempt: 1 })),
      Command.expectExact(SyncDraft({ path, base: 1, text: sent })),
      Command.resolve(SyncDraft, reply(1, sent, 2)),
      model(next => expect(documentOf(next).retryAttempt).toBe(0)),
    )
  })

  test('a failed Resync application after Forgotten cannot send edits from the forgotten base', () => {
    const snapshot = `agent\n${original}`
    const live = `${sent}local\n`
    const combined = merged(original, snapshot, live)
    story(update, given(readyModel()), message(edited(sent, 'Action')),
      Command.resolve(SyncDraft, Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Forgotten' })),
      message(Message.ReceivedWatchEvent({ event: { _tag: 'Watching', version: 10, text: snapshot } })),
      message(Message.ReceivedWatchEvent({ event: { _tag: 'Resync', version: 10, text: snapshot } })),
      Command.resolve(ApplyRemoteText, Message.FailedApplyRemoteText({ token: 1, reason: 'Composition did not finish in time' })),
      whilePending(edited(live, 'Action')),
      Command.expectExact(WaitBeforeRemoteRetry({ session, token: 1 })),
      Command.resolve(WaitBeforeRemoteRetry, Message.CompletedWaitBeforeRemoteRetry({ session, token: 1 })),
      Command.expectExact(ApplyRemoteText({ session, token: 2, from: original, to: snapshot })),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 2 })),
      message(remote(2, combined)),
      Command.expectExact(SyncDraft({ path, base: 10, text: combined })),
      Command.resolve(SyncDraft, reply(10, combined, 11)),
      model(next => expect(documentOf(next).connection._tag).toBe('Live')),
    )
  })

  test('stops scheduling retries after five attempts', () => {
    const initial = readyModel()
    story(update, given({ ...initial, document: DocumentState.Ready({ document: {
      ...documentOf(initial), draft: sent, retryAttempt: 5, inFlight: Option.some({ base: 1, text: sent }),
    } }) }),
      message(Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Transient' })),
      Command.expectNone(), model(next => expect(documentOf(next).retryAttempt).toBe(6)),
    )
  })

  test('keeps a failed remote snapshot and settles again after 500 ms', () => {
    story(update, given(readyModel()), message(changed(2, sent)),
      Command.resolve(ApplyRemoteText, Message.FailedApplyRemoteText({ token: 1, reason: 'Editor is not mounted' })),
      model(next => {
        expect(documentOf(next).draft).toBe(original)
        expect(documentOf(next).pendingRemote._tag).toBe('None')
        expect(Option.getOrThrow(documentOf(next).latestRemote).text).toBe(sent)
      }),
      Command.expectExact(WaitBeforeRemoteRetry({ session, token: 1 })),
      Command.resolve(WaitBeforeRemoteRetry, Message.CompletedWaitBeforeRemoteRetry({ session, token: 1 })),
      Command.expectExact(ApplyRemoteText({ session, token: 2, from: original, to: sent })),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 2 })),
      message(remote(1, 'stale')), model(next => expect(documentOf(next).draft).toBe(original)),
      message(remote(2, sent)), model(next => expect(documentOf(next).draft).toBe(sent)),
    )
  })

  test('ignores facts from another session and stale sync replies', () => {
    story(update, given(readyModel()),
      message(Message.UpdatedEditor({ session: 'old', text: 'wrong', anchor: 1, head: 1, origin: 'Action', token: null })),
      message(reply(1, 'not sent', 20)),
      model(next => expect(documentOf(next).draft).toBe(original)),
    )
  })

  test('reconnect keeps watch dependencies stable through typing and resumes from the acknowledged version', () => {
    const initialDependencies = subscriptions.watch.modelToDependencies(readyModel())
    story(update, given(readyModel()), message(edited(sent, 'Action')),
      Command.resolve(SyncDraft, reply(1, sent, 2)),
      model(next => expect(subscriptions.watch.modelToDependencies(next)).toEqual(initialDependencies)),
      message(Message.FailedWatch({ unauthorized: false })),
      Command.expectExact(WaitBeforeReconnect({ attempt: 1 })),
      Command.resolve(WaitBeforeReconnect, Message.CompletedWaitBeforeReconnect()),
      model(next => {
        const dependencies = subscriptions.watch.modelToDependencies(next)
        expect(Option.getOrThrow(dependencies.maybeWatch)).toEqual({ path, watchKey: 1, resumeFrom: Option.some(2) })
      }),
      message(Message.ReceivedWatchEvent({ event: { _tag: 'Watching', version: 3, text: `${sent}agent\n` } })),
      Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token: 1 })),
      message(remote(1, `${sent}agent\n`)),
      model(next => {
        expect(documentOf(next).session).toBe(session)
        expect(documentOf(next).connection._tag).toBe('Live')
      }),
    )
  })

  test('Deleted and Unauthorized stop editing', () => {
    story(update, given(readyModel()), message(Message.ReceivedWatchEvent({ event: { _tag: 'Deleted' } })),
      model(next => expect(next.document._tag).toBe('Deleted')))
    story(update, given(readyModel()), message(edited(sent, 'Action')),
      Command.resolve(SyncDraft, Message.FailedSync({ request: { base: 1, text: sent }, kind: 'Unauthorized' })),
      model(next => expect(next.document._tag).toBe('Unauthorized')))
  })
})

describe('palette update', () => {
  test('opens the Shortcuts palette from the help key fact', () => {
    story(update, given(readyModel()), message(Message.PressedHelpKey()),
      model(next => {
        expect(next.palette).toEqual({ _tag: 'Open', kind: 'Shortcuts', query: '', active: 0 })
        expect(paletteItems(next, original).some(item => item.title === 'Continue task')).toBe(true)
      }),
    )
  })

  test('opens, filters by subsequence, and chooses a command against the live editor', () => {
    story(update, given(readyModel()), message(Message.ClickedCommands()),
      message(Message.UpdatedPaletteQuery({ query: 'tGdn' })),
      model(next => expect(paletteItems(next, original).map(item => item.title)).toEqual(['Toggle done'])),
      message(Message.PressedPaletteKey({ key: 'Enter' })),
      Command.expectExact(RunEditorAction({ session, action: 'toggleDone' })),
      Command.resolve(RunEditorAction, Message.CompletedRunEditorAction()),
      model(next => {
        expect(next.palette._tag).toBe('Closed')
        expect(documentOf(next).draft).toBe(original)
      }),
    )
  })

  test('Escape closes the palette and restores editor focus', () => {
    story(update, given(readyModel()), message(Message.ClickedCommands()),
      message(Message.PressedPaletteKey({ key: 'ArrowDown' })),
      model(next => expect(next.palette._tag === 'Open' && next.palette.active).toBe(1)),
      message(Message.PressedPaletteKey({ key: 'ArrowUp' })),
      model(next => expect(next.palette._tag === 'Open' && next.palette.active).toBe(0)),
      message(Message.PressedPaletteKey({ key: 'Escape' })),
      Command.expectExact(FocusEditor({ session })),
      Command.resolve(FocusEditor, Message.CompletedFocusEditor()),
      model(next => expect(next.palette._tag).toBe('Closed')),
    )
  })

  test('navigates projects and exposes shortcuts through the palette', () => {
    const text = '# First\n\n## Second\n'
    story(update, given(readyModel(text)), message(Message.PressedEditorCommand({ command: 'gotoProject' })),
      message(Message.UpdatedPaletteQuery({ query: 'scd' })),
      message(Message.ClickedPaletteItem({ index: 0 })),
      Command.expectExact(RevealEditorPosition({ session, offset: text.indexOf('Second') })),
      Command.resolve(RevealEditorPosition, Message.CompletedRevealEditorPosition()),
      message(Message.PressedEditorCommand({ command: 'showShortcuts' })),
      model(next => expect(paletteItems(next, text).some(item => item.title === 'Continue task')).toBe(true)),
    )
  })
})
