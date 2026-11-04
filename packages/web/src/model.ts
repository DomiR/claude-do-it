import { Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { Author, TodoChange, Version } from '@do-it/protocol'

export const Mode = Schema.Literals(['Tasks', 'Markdown'])
export type Mode = typeof Mode.Type

export const Selection = Schema.Struct({ start: Schema.Number, end: Schema.Number })
export type Selection = typeof Selection.Type

export const Base = Schema.Struct({ version: Version, text: Schema.String })
export type Base = typeof Base.Type

export const SyncRequest = Schema.Struct({ path: Schema.String, base: Version, text: Schema.String })
export type SyncRequest = typeof SyncRequest.Type

export const ConnectionState = defineTaggedUnion({ Live: {}, Reconnecting: {} })
export type ConnectionState = typeof ConnectionState.Type

export const ReadyDocument = Schema.Struct({
  path: Schema.String,
  base: Base,
  draft: Schema.String,
  inFlight: Schema.Option(SyncRequest),
  draftRevision: Schema.Number,
  watchKey: Schema.Number,
  resumeFrom: Schema.Option(Version),
  reconnectAttempt: Schema.Number,
  connection: ConnectionState,
  selection: Selection,
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

export const TaskInput = Schema.Struct({ section: Schema.NullOr(Schema.String), text: Schema.String })
export type TaskInput = typeof TaskInput.Type

export const Activity = Schema.Struct({
  from: Version,
  to: Version,
  by: Schema.Array(Author),
  todos: Schema.Array(TodoChange),
})
export type Activity = typeof Activity.Type

export const Model = Schema.Struct({
  document: DocumentState,
  mode: Mode,
  taskInputs: Schema.Array(TaskInput),
  activity: Schema.Array(Activity),
  highlightedTodos: Schema.Array(Schema.Number),
})
export type Model = typeof Model.Type

export const makeInitialModel = (path: string): Model => ({
  document: path.length === 0
    ? DocumentState.NoPath()
    : DocumentState.Connecting({ path, watchKey: 0, resumeFrom: Option.none(), reconnectAttempt: 0 }),
  mode: 'Tasks',
  taskInputs: [],
  activity: [],
  highlightedTodos: [],
})
