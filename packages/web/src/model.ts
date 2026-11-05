import { Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { Author, TodoChange, Version } from '@do-it/protocol'

export const Platform = Schema.Literals(['mac', 'other'])
export const EditorAction = Schema.Literals([
  'newTask', 'toggleDone', 'toggleCancelled', 'archive', 'moveUp', 'moveDown',
  'continueTask', 'indent', 'outdent', 'tab',
  'bold', 'italic', 'strike', 'code', 'toggleTask', 'toggleBullet', 'toggleHeading',
])
export const EditorCommandName = Schema.Union([
  EditorAction,
  Schema.Literals(['openLink', 'editLink', 'gotoProject', 'commandPalette', 'find', 'showShortcuts', 'toggleFold', 'foldAll', 'unfoldAll']),
])
export const Selection = Schema.Struct({ anchor: Schema.Number, head: Schema.Number })
export type Selection = typeof Selection.Type

export const Base = Schema.Struct({ version: Version, text: Schema.String })
export type Base = typeof Base.Type
export const SyncRequest = Schema.Struct({ base: Version, text: Schema.String })
export type SyncRequest = typeof SyncRequest.Type
export const RemoteSnapshot = Schema.Struct({ version: Version, text: Schema.String, resync: Schema.Boolean })
export type RemoteSnapshot = typeof RemoteSnapshot.Type
export const PendingRemote = Schema.Struct({
  token: Schema.Number, version: Version, to: Schema.String, resync: Schema.Boolean,
})

export const ConnectionState = defineTaggedUnion({
  Live: {},
  Reconnecting: { awaitingResync: Schema.Boolean },
})
export type ConnectionState = typeof ConnectionState.Type
export const ReadyDocument = Schema.Struct({
  path: Schema.String,
  session: Schema.String,
  base: Base,
  draft: Schema.String,
  draftRevision: Schema.Number,
  selection: Selection,
  inFlight: Schema.Option(SyncRequest),
  pendingRemote: Schema.Option(PendingRemote),
  latestRemote: Schema.Option(RemoteSnapshot),
  nextToken: Schema.Number,
  retryAttempt: Schema.Number,
  watchKey: Schema.Number,
  resumeFrom: Schema.Option(Version),
  reconnectAttempt: Schema.Number,
  connection: ConnectionState,
})
export type ReadyDocument = typeof ReadyDocument.Type

export const DocumentState = defineTaggedUnion({
  NoPath: {},
  Connecting: {
    path: Schema.String,
    watchKey: Schema.Number,
    resumeFrom: Schema.Option(Version),
    reconnectAttempt: Schema.Number,
  },
  Ready: { document: ReadyDocument },
  Deleted: { path: Schema.String },
  Unauthorized: { path: Schema.String },
})
export type DocumentState = typeof DocumentState.Type

export const PaletteKind = Schema.Literals(['Commands', 'Projects', 'Shortcuts'])
export type PaletteKind = typeof PaletteKind.Type
export const Palette = defineTaggedUnion({
  Closed: {},
  Open: { kind: PaletteKind, query: Schema.String, active: Schema.Number },
})
export type Palette = typeof Palette.Type
export const Activity = Schema.Struct({
  from: Version,
  to: Version,
  by: Schema.Array(Author),
  todos: Schema.Array(TodoChange),
})
export type Activity = typeof Activity.Type

export const Model = Schema.Struct({
  document: DocumentState,
  activity: Schema.Array(Activity),
  activityOpen: Schema.Boolean,
  platform: Platform,
  palette: Palette,
  notice: Schema.Option(Schema.String),
  /** Whether long lines wrap. Off means they scroll horizontally. */
  wrap: Schema.Boolean,
})
export type Model = typeof Model.Type

export const makeInitialModel = (path: string, platform: typeof Platform.Type = 'other', wrap = false): Model => ({
  document: path.length === 0
    ? DocumentState.NoPath()
    : DocumentState.Connecting({ path, watchKey: 0, resumeFrom: Option.none(), reconnectAttempt: 0 }),
  activity: [],
  activityOpen: false,
  platform,
  palette: Palette.Closed(),
  notice: Option.none(),
  wrap,
})

export const saveStatus = (document: ReadyDocument): 'Saved' | 'Saving' | 'Reconnecting' =>
  document.connection._tag === 'Reconnecting'
    ? 'Reconnecting'
    : document.draft !== document.base.text || Option.isSome(document.inFlight) || Option.isSome(document.pendingRemote)
      ? 'Saving'
      : 'Saved'
