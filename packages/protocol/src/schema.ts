import { Schema } from 'effect'

export const MAX_TEXT_LENGTH = 2 * 1024 * 1024
export const MAX_TASK_TEXT_LENGTH = 4096

export const Text = Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_TEXT_LENGTH)))
export const TaskText = Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_TASK_TEXT_LENGTH)))
export const Path = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.length > 0 && value.startsWith('/')
        ? undefined
        : 'an absolute, non-empty path is required',
    ),
    Schema.isMaxLength(MAX_TEXT_LENGTH),
  ),
)

export const Version = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
export type Version = typeof Version.Type

/**
 * The lowercase hex SHA-256 of a whole document text. A restarted daemon can
 * give a version number to a different text, so a hash names the text itself.
 */
export const Hash = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)))
export type Hash = typeof Hash.Type

export const User = Schema.TaggedStruct('User', {})
export type User = typeof User.Type

export const Agent = Schema.TaggedStruct('Agent', {
  name: Schema.String.pipe(
    Schema.check(Schema.isBetweenLength(1, 64), Schema.isPattern(/^[A-Za-z0-9._-]+$/)),
  ),
})
export type Agent = typeof Agent.Type

export const File = Schema.TaggedStruct('File', {})
export type File = typeof File.Type

export const Author = Schema.Union([User, Agent, File])
export type Author = typeof Author.Type

export const TaskState = Schema.Literals(['open', 'done', 'cancelled'])
export type TaskState = typeof TaskState.Type

export const Todo = Schema.Struct({
  number: Schema.Number,
  line: Schema.Number,
  state: TaskState,
  text: TaskText,
  indent: Schema.Number,
  section: Schema.NullOr(Text),
})
export type Todo = typeof Todo.Type

export const TodoChange = Schema.Struct({
  kind: Schema.Literals([
    'added',
    'removed',
    'checked',
    'unchecked',
    'cancelled',
    'uncancelled',
    'edited',
  ]),
  number: Schema.Number,
  text: TaskText,
  line: Schema.Number,
  oldLine: Schema.Number,
})
export type TodoChange = typeof TodoChange.Type

export const Section = Schema.Struct({
  id: Text,
  title: Text,
  level: Schema.Literals([1, 2, 3]),
  line: Schema.Number,
})
export type Section = typeof Section.Type

export const Others = Schema.Struct({
  since: Version,
  diff: Schema.NullOr(Text),
})
export type Others = typeof Others.Type

export const Replace = Schema.TaggedStruct('Replace', {
  old: Text,
  new: Text,
})
export type Replace = typeof Replace.Type

export const Append = Schema.TaggedStruct('Append', {
  text: Text,
})
export type Append = typeof Append.Type

export const TodoAdd = Schema.TaggedStruct('TodoAdd', {
  text: TaskText,
})
export type TodoAdd = typeof TodoAdd.Type

export const TodoSet = Schema.TaggedStruct('TodoSet', {
  target: Schema.Union([Schema.Number, Text]),
  state: TaskState,
})
export type TodoSet = typeof TodoSet.Type

export const TodoStart = Schema.TaggedStruct('TodoStart', {
  target: Schema.Union([Schema.Number, Text]),
})
export type TodoStart = typeof TodoStart.Type

export const EditOp = Schema.Union([Replace, Append, TodoAdd, TodoSet, TodoStart])
export type EditOp = typeof EditOp.Type

const SectionId = Schema.optional(Text)

export const StatusPayload = Schema.Struct({})
export const StatusDocument = Schema.Struct({
  path: Path,
  version: Version,
  watchers: Schema.Number,
})
export const StatusSuccess = Schema.Struct({
  pid: Schema.Number,
  appVersion: Text,
  port: Schema.Number,
  startedAt: Schema.Number,
  build: Schema.optionalKey(Text),
  documents: Schema.Array(StatusDocument),
})

export const StopPayload = Schema.Struct({})
export const StopSuccess = Schema.Struct({})

export const OpenPayload = Schema.Struct({
  path: Path,
  create: Schema.Boolean,
})
export const OpenSuccess = Schema.Struct({
  path: Path,
  version: Version,
  url: Text,
  created: Schema.Boolean,
})

export const ReadPayload = Schema.Struct({
  path: Path,
  section: SectionId,
})
export const ReadSuccess = Schema.Struct({
  version: Version,
  text: Text,
  /** Names the whole document at `version`, also when `text` is one section. */
  hash: Schema.optionalKey(Hash),
})

export const SectionsPayload = Schema.Struct({ path: Path })
export const SectionsSuccess = Schema.Struct({
  version: Version,
  sections: Schema.Array(Section),
})

export const TodosPayload = Schema.Struct({
  path: Path,
  section: SectionId,
})
export const TodosSuccess = Schema.Struct({
  version: Version,
  todos: Schema.Array(Todo),
})

export const EditPayload = Schema.Struct({
  path: Path,
  author: Author,
  version: Version,
  section: SectionId,
  op: EditOp,
})
export const EditSuccess = Schema.Struct({
  version: Version,
  changed: Schema.Boolean,
  section: Schema.NullOr(Text),
  others: Schema.NullOr(Others),
})

export const SyncPayload = Schema.Struct({
  path: Path,
  base: Version,
  text: Text,
  /** The hash of the text the sender holds as `base`. A different text at that version fails with Forgotten. */
  baseHash: Schema.optionalKey(Hash),
})
export const SyncSuccess = Schema.Struct({
  version: Version,
  text: Text,
  hash: Schema.optionalKey(Hash),
})

export const DiffPayload = Schema.Struct({
  path: Path,
  since: Version,
  wait: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 600 }))),
})
export const DiffSuccess = Schema.Struct({
  from: Version,
  to: Version,
  by: Schema.Array(Author),
  diff: Schema.NullOr(Text),
  todos: Schema.Array(TodoChange),
})

export const WatchPayload = Schema.Struct({
  path: Path,
  since: Schema.optional(Version),
  /** The hash of the text the watcher holds at `since`. A different text at that version starts with Resync. */
  sinceHash: Schema.optionalKey(Hash),
  section: SectionId,
  text: Schema.Boolean,
})

export const Watching = Schema.TaggedStruct('Watching', {
  version: Version,
  hash: Schema.optionalKey(Hash),
  text: Schema.optionalKey(Text),
})
export type Watching = typeof Watching.Type

export const Change = Schema.TaggedStruct('Change', {
  from: Version,
  to: Version,
  by: Schema.Array(Author),
  diff: Schema.NullOr(Text),
  todos: Schema.Array(TodoChange),
  /** Names the document at `to`. */
  hash: Schema.optionalKey(Hash),
  text: Schema.optionalKey(Text),
})
export type Change = typeof Change.Type

export const Resync = Schema.TaggedStruct('Resync', {
  version: Version,
  hash: Schema.optionalKey(Hash),
  text: Schema.optionalKey(Text),
})
export type Resync = typeof Resync.Type

export const Deleted = Schema.TaggedStruct('Deleted', {})
export type Deleted = typeof Deleted.Type

export const WatchEvent = Schema.Union([Watching, Change, Resync, Deleted])
export type WatchEvent = typeof WatchEvent.Type

export type StatusPayload = typeof StatusPayload.Type
export type StatusDocument = typeof StatusDocument.Type
export type StatusSuccess = typeof StatusSuccess.Type
export type StopPayload = typeof StopPayload.Type
export type StopSuccess = typeof StopSuccess.Type
export type OpenPayload = typeof OpenPayload.Type
export type OpenSuccess = typeof OpenSuccess.Type
export type ReadPayload = typeof ReadPayload.Type
export type ReadSuccess = typeof ReadSuccess.Type
export type SectionsPayload = typeof SectionsPayload.Type
export type SectionsSuccess = typeof SectionsSuccess.Type
export type TodosPayload = typeof TodosPayload.Type
export type TodosSuccess = typeof TodosSuccess.Type
export type EditPayload = typeof EditPayload.Type
export type EditSuccess = typeof EditSuccess.Type
export type SyncPayload = typeof SyncPayload.Type
export type SyncSuccess = typeof SyncSuccess.Type
export type DiffPayload = typeof DiffPayload.Type
export type DiffSuccess = typeof DiffSuccess.Type
export type WatchPayload = typeof WatchPayload.Type
