import { Match, Option } from 'effect'
import { Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import {
  ApplyRemoteText, FocusEditor, OpenEditorLink, RevealEditorPosition, RunEditorAction, SyncDraft,
  WaitBeforeReconnect, WaitBeforeRemoteRetry, WaitBeforeSync, WaitBeforeSyncRetry,
} from './command'
import { Message } from './message'
import {
  ConnectionState, DocumentState, Model, Palette, type PaletteKind, type ReadyDocument,
  type RemoteSnapshot, type SyncRequest,
} from './model'
import { paletteItems } from './view/palette'

type UpdateReturn = Update.Return<Model, Message, import('./rpc').DoItClient>
const isDirty = (document: ReadyDocument): boolean => document.draft !== document.base.text
const isBusy = (document: ReadyDocument): boolean => Option.isSome(document.inFlight) || Option.isSome(document.pendingRemote)
const withDocument = (model: Model, document: ReadyDocument): Model =>
  modifyFields(model, { document: () => DocumentState.Ready({ document }) })
const whenReady = (model: Model, step: (document: ReadyDocument) => UpdateReturn): UpdateReturn =>
  DocumentState.matchOrElse<UpdateReturn>(model.document, { Ready: ({ document }) => step(document) }, () => ({ model }))
const matchesRequest = (document: ReadyDocument, request: SyncRequest): boolean =>
  Option.isSome(document.inFlight) && document.inFlight.value.base === request.base && document.inFlight.value.text === request.text

const keepNewest = (current: Option.Option<RemoteSnapshot>, incoming: RemoteSnapshot): Option.Option<RemoteSnapshot> => {
  if (Option.isNone(current)) return Option.some(incoming)
  if (incoming.version > current.value.version) return Option.some({ ...incoming, resync: incoming.resync || current.value.resync })
  if (incoming.version === current.value.version) return Option.some({ ...incoming, resync: incoming.resync || current.value.resync })
  return Option.some({ ...current.value, resync: current.value.resync || incoming.resync })
}

const startSync = (model: Model, document: ReadyDocument): UpdateReturn => {
  // Forgotten must wait for Resync, including when Watching arrives first.
  const awaitingResync = document.connection._tag === 'Reconnecting' && document.connection.awaitingResync
  if (!isDirty(document) || isBusy(document) || awaitingResync) {
    return { model: withDocument(model, document) }
  }
  const request = { base: document.base.version, text: document.draft }
  return {
    model: withDocument(model, modifyFields(document, { inFlight: () => Option.some(request) })),
    commands: [SyncDraft({ path: document.path, ...request })],
  }
}

const applyRemote = (model: Model, document: ReadyDocument, snapshot: RemoteSnapshot, from: string): UpdateReturn => {
  const token = document.nextToken
  return {
    model: withDocument(model, modifyFields(document, {
      pendingRemote: () => Option.some({ token, version: snapshot.version, to: snapshot.text, resync: snapshot.resync }),
      nextToken: value => value + 1,
    })),
    commands: [ApplyRemoteText({ session: document.session, token, from, to: snapshot.text })],
  }
}

const receiveRemote = (model: Model, document: ReadyDocument, snapshot: RemoteSnapshot): UpdateReturn => {
  if (!snapshot.resync && snapshot.version <= document.base.version) return { model: withDocument(model, document) }
  if (isBusy(document)) {
    return { model: withDocument(model, modifyFields(document, {
      latestRemote: current => keepNewest(current, snapshot),
    })) }
  }
  if (snapshot.resync || !isDirty(document)) return applyRemote(model, document, snapshot, document.base.text)
  return startSync(model, modifyFields(document, { latestRemote: current => keepNewest(current, snapshot) }))
}

const settle = (model: Model, document: ReadyDocument): UpdateReturn => {
  if (isBusy(document)) return { model: withDocument(model, document) }
  if (Option.isSome(document.latestRemote)) {
    const snapshot = document.latestRemote.value
    const nextDocument = modifyFields(document, { latestRemote: () => Option.none() })
    if (snapshot.resync || snapshot.version > document.base.version) return receiveRemote(model, nextDocument, snapshot)
    return startSync(model, nextDocument)
  }
  return startSync(model, document)
}

const readyFromWatching = (model: Model, version: number, text: string, resync: boolean): UpdateReturn =>
  DocumentState.matchOrElse<UpdateReturn>(model.document, {
    Connecting: ({ path, watchKey, resumeFrom }) => ({
      model: withDocument(model, {
        path, session: `${path}:${watchKey}`, base: { version, text }, draft: text,
        draftRevision: 0, selection: { anchor: 0, head: 0 }, inFlight: Option.none(),
        pendingRemote: Option.none(), latestRemote: Option.none(), nextToken: 1, retryAttempt: 0,
        watchKey, resumeFrom,
        reconnectAttempt: 0, connection: ConnectionState.Live(),
      }),
    }),
    Ready: ({ document }) => {
      if (!resync && document.connection._tag === 'Reconnecting' && document.connection.awaitingResync) {
        return { model: withDocument(model, modifyFields(document, {
          latestRemote: current => keepNewest(current, { version, text, resync: false }),
        })) }
      }
      const nextDocument = modifyFields(document, {
        connection: connection => connection._tag === 'Reconnecting' && connection.awaitingResync
          ? connection : ConnectionState.Live(),
        reconnectAttempt: () => 0,
      })
      if (!resync && version <= document.base.version) return { model: withDocument(model, nextDocument) }
      return receiveRemote(model, nextDocument, { version, text, resync })
    },
  }, () => ({ model }))

const reconnect = (model: Model): UpdateReturn =>
  DocumentState.matchOrElse(model.document, {
    Ready: ({ document }) => {
      const attempt = document.reconnectAttempt + 1
      return {
        model: withDocument(model, modifyFields(document, {
          connection: () => ConnectionState.Reconnecting({
            awaitingResync: document.connection._tag === 'Reconnecting' && document.connection.awaitingResync,
          }),
          reconnectAttempt: () => attempt,
        })),
        commands: [WaitBeforeReconnect({ attempt })],
      }
    },
    Connecting: state => {
      const attempt = state.reconnectAttempt + 1
      return {
        model: modifyFields(model, { document: () => modifyFields(state, { reconnectAttempt: () => attempt }) }),
        commands: [WaitBeforeReconnect({ attempt })],
      }
    },
  }, () => ({ model }))

const terminal = (model: Model, kind: 'Deleted' | 'Unauthorized'): UpdateReturn =>
  DocumentState.matchOrElse(model.document, {
    Ready: ({ document }) => ({ model: modifyFields(model, {
      document: () => DocumentState[kind]({ path: document.path }), palette: () => Palette.Closed(),
    }) }),
    Connecting: ({ path }) => ({ model: modifyFields(model, { document: () => DocumentState[kind]({ path }) }) }),
  }, () => ({ model }))

const openPalette = (model: Model, kind: PaletteKind): UpdateReturn => whenReady(model, () => ({
  model: modifyFields(model, { palette: () => Palette.Open({ kind, query: '', active: 0 }) }),
}))

const closePalette = (model: Model): UpdateReturn => whenReady(model, document => ({
  model: modifyFields(model, { palette: () => Palette.Closed() }),
  commands: [FocusEditor({ session: document.session })],
}))

const choosePalette = (model: Model, index: number): UpdateReturn => whenReady(model, document => {
  const items = paletteItems(model, document.draft)
  const item = items[Math.max(0, Math.min(index, items.length - 1))]
  if (!item) return { model }
  const closed = modifyFields(model, { palette: () => Palette.Closed() })
  if (item.kind === 'Project') return {
    model: closed, commands: [RevealEditorPosition({ session: document.session, offset: item.offset })],
  }
  if (item.command === 'gotoProject') return openPalette(model, 'Projects')
  if (item.command === 'showShortcuts') return openPalette(model, 'Shortcuts')
  if (item.command === 'commandPalette') return openPalette(model, 'Commands')
  return { model: closed, commands: [RunEditorAction({ session: document.session, action: item.command })] }
})

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  UpdatedEditor: fact => whenReady(model, document => {
    if (fact.session !== document.session) return { model }
    if (fact.origin === 'Remote') {
      if (Option.isNone(document.pendingRemote) || fact.token !== document.pendingRemote.value.token) return { model }
      const pending = document.pendingRemote.value
      return settle(modifyFields(model, { notice: () => Option.none() }), modifyFields(document, {
        base: () => ({ version: pending.version, text: pending.to }),
        draft: () => fact.text,
        selection: () => ({ anchor: fact.anchor, head: fact.head }),
        pendingRemote: () => Option.none(),
        connection: connection => pending.resync ? ConnectionState.Live() : connection,
      }))
    }
    const nextDocument = modifyFields(document, {
      draft: () => fact.text, draftRevision: value => value + 1,
      selection: () => ({ anchor: fact.anchor, head: fact.head }),
    })
    const nextModel = modifyFields(model, { notice: () => Option.none() })
    return fact.origin === 'Action'
      ? startSync(nextModel, nextDocument)
      : {
          model: withDocument(nextModel, nextDocument),
          commands: [WaitBeforeSync({ session: document.session, revision: nextDocument.draftRevision })],
        }
  }),
  MovedEditorSelection: ({ session, anchor, head }) => whenReady(model, document => ({
    model: session === document.session
      ? withDocument(model, modifyFields(document, { selection: () => ({ anchor, head }) })) : model,
  })),
  CompletedWaitBeforeSync: ({ session, revision }) => whenReady(model, document =>
    session === document.session && revision === document.draftRevision ? startSync(model, document) : { model }),
  SucceededSync: ({ request, version, text }) => whenReady(model, document => {
    if (!matchesRequest(document, request)) return { model }
    const nextModel = modifyFields(model, { notice: () => Option.none() })
    const nextDocument = modifyFields(document, { inFlight: () => Option.none(), retryAttempt: () => 0 })
    if (text === request.text) return settle(nextModel, modifyFields(nextDocument, { base: () => ({ version, text }) }))
    return applyRemote(nextModel, nextDocument, { version, text, resync: false }, request.text)
  }),
  FailedSync: ({ request, kind }) => whenReady(model, document => {
    if (!matchesRequest(document, request)) return { model }
    const nextDocument = modifyFields(document, { inFlight: () => Option.none() })
    if (kind === 'Unauthorized' || kind === 'DocumentGone') return terminal(model, kind === 'Unauthorized' ? 'Unauthorized' : 'Deleted')
    if (kind === 'Forgotten') return {
      model: withDocument(model, modifyFields(nextDocument, {
        watchKey: value => value + 1, resumeFrom: () => Option.some(document.base.version),
        connection: () => ConnectionState.Reconnecting({ awaitingResync: true }),
      })),
    }
    const attempt = document.retryAttempt + 1
    const retryDocument = modifyFields(nextDocument, { retryAttempt: () => attempt })
    const nextModel = modifyFields(model, { notice: () => Option.some(attempt <= 5 ? 'Sync interrupted, retrying' : 'Sync interrupted, edit to try again') })
    // Drain a snapshot that can be adopted before the delayed retry. A dirty
    // ordinary Change still needs the sync reply, so leave it queued.
    const drain: UpdateReturn = Option.isSome(retryDocument.latestRemote) && (retryDocument.latestRemote.value.resync || !isDirty(retryDocument))
      ? settle(nextModel, retryDocument) : { model: withDocument(nextModel, retryDocument) }
    return attempt <= 5
      ? { model: drain.model, commands: [...(drain.commands ?? []), WaitBeforeSyncRetry({ session: document.session, attempt })] }
      : drain
  }),
  CompletedWaitBeforeSyncRetry: ({ session, attempt }) => whenReady(model, document =>
    session === document.session && attempt === document.retryAttempt && attempt <= 5 ? settle(model, document) : { model }),
  FailedApplyRemoteText: ({ token, reason }) => whenReady(model, document => {
    if (Option.isNone(document.pendingRemote) || document.pendingRemote.value.token !== token) return { model }
    const pending = document.pendingRemote.value
    return {
      model: withDocument(modifyFields(model, { notice: () => Option.some(reason) }), modifyFields(document, {
        pendingRemote: () => Option.none(),
        latestRemote: current => keepNewest(current, { version: pending.version, text: pending.to, resync: pending.resync }),
      })),
      commands: [WaitBeforeRemoteRetry({ session: document.session, token })],
    }
  }),
  CompletedWaitBeforeRemoteRetry: ({ session, token }) => whenReady(model, document =>
    session === document.session && token === document.nextToken - 1 ? settle(model, document) : { model }),
  ReceivedWatchEvent: ({ event }) => Match.value(event).pipe(
    Match.tag('Watching', ({ version, text }) => text === undefined ? { model } : readyFromWatching(model, version, text, false)),
    Match.tag('Resync', ({ version, text }) => text === undefined ? { model } : readyFromWatching(model, version, text, true)),
    Match.tag('Change', event => {
      const nextModel = modifyFields(model, {
        activity: activity => [{ from: event.from, to: event.to, by: event.by, todos: event.todos }, ...activity].slice(0, 20),
      })
      return whenReady(nextModel, document => event.text === undefined ? { model: nextModel }
        : receiveRemote(nextModel, document, { version: event.to, text: event.text, resync: false }))
    }),
    Match.tag('Deleted', () => terminal(model, 'Deleted')),
    Match.exhaustive,
  ),
  WatchEnded: () => reconnect(model),
  FailedWatch: ({ unauthorized }) => unauthorized ? terminal(model, 'Unauthorized') : reconnect(model),
  CompletedWaitBeforeReconnect: () => DocumentState.matchOrElse(model.document, {
    Ready: ({ document }) => ({ model: withDocument(model, modifyFields(document, {
      watchKey: value => value + 1, resumeFrom: () => Option.some(document.base.version),
    })) }),
    Connecting: state => ({ model: modifyFields(model, {
      document: () => modifyFields(state, { watchKey: value => value + 1 }),
    }) }),
  }, () => ({ model })),
  ClickedActivity: () => ({ model: modifyFields(model, { activityOpen: value => !value }) }),
  ClickedCommands: () => model.palette._tag === 'Open' ? closePalette(model) : openPalette(model, 'Commands'),
  UpdatedPaletteQuery: ({ query }) => ({ model: modifyFields(model, {
    palette: palette => Palette.match(palette, {
      Closed: () => palette, Open: open => modifyFields(open, { query: () => query, active: () => 0 }),
    }),
  }) }),
  PressedPaletteKey: ({ key }) => {
    const palette = model.palette
    if (palette._tag !== 'Open') return { model }
    if (key === 'Escape') return closePalette(model)
    if (key === 'Enter') return choosePalette(model, palette.active)
    const length = model.document._tag === 'Ready' ? paletteItems(model, model.document.document.draft).length : 0
    const active = length ? (palette.active + (key === 'ArrowDown' ? 1 : length - 1)) % length : 0
    return { model: modifyFields(model, { palette: () => Palette.Open({ ...palette, active }) }) }
  },
  ClickedPaletteItem: ({ index }) => choosePalette(model, index),
  PressedEditorCommand: ({ command, link }) => {
    if (command === 'commandPalette') return openPalette(model, 'Commands')
    if (command === 'gotoProject') return openPalette(model, 'Projects')
    if (command === 'showShortcuts') return openPalette(model, 'Shortcuts')
    if (command === 'openLink' && link === undefined) return { model: modifyFields(model, { notice: () => Option.some('No link here') }) }
    return whenReady(model, document => ({
      model,
      commands: [command === 'openLink' && link !== undefined
        ? OpenEditorLink({ session: document.session, url: link })
        : RunEditorAction({ session: document.session, action: command })],
    }))
  },
  OpenedEditorLink: ({ url }) => whenReady(model, document => ({ model, commands: [OpenEditorLink({ session: document.session, url })] })),
  ShowedEditorNotice: ({ text }) => ({ model: modifyFields(model, { notice: () => Option.some(text) }) }),
  SucceededMountEditor: () => ({ model }),
  CompletedApplyRemoteText: () => ({ model }),
  CompletedFocusPaletteInput: () => ({ model }),
  CompletedFocusEditor: () => ({ model }),
  CompletedRunEditorAction: () => ({ model }),
  CompletedRevealEditorPosition: () => ({ model }),
  CompletedOpenEditorLink: () => ({ model }),
})
