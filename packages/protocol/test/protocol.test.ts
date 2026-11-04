import { describe, expect, it } from 'bun:test'
import { Schema } from 'effect'
import { RpcSchema } from 'effect/rpc'

import {
  Agent,
  APP_VERSION,
  Author,
  Change,
  Deleted,
  DiffPayload,
  DiffSuccess,
  DocumentGone,
  EditPayload,
  EditSuccess,
  Forgotten,
  NothingYet,
  PROTOCOL_VERSION,
  Refused,
  Resync,
  RpcFailure,
  SectionsPayload,
  SectionsSuccess,
  StatusPayload,
  StatusSuccess,
  StopPayload,
  StopSuccess,
  SyncPayload,
  SyncSuccess,
  Todo,
  TodoAdd,
  TodoChange,
  TodoSet,
  TodosPayload,
  TodosSuccess,
  Unauthorized,
  User,
  VersionMismatch,
  WatchEvent,
  WatchPayload,
  Watching,
  Append,
  File,
  OpenPayload,
  OpenSuccess,
  ReadPayload,
  ReadSuccess,
  Replace,
  Section,
  Change as ChangeSchema,
  Deleted as DeletedSchema,
  Resync as ResyncSchema,
  Watching as WatchingSchema,
  DoItRpcs,
  diffRpc,
  editRpc,
  exitCodeFor,
  formatTodoChange,
  formatVersionHeader,
  describeAuthor,
  watchRpc,
} from '../src/index.js'

const author = { _tag: 'User' } as const
const agent = { _tag: 'Agent', name: 't3' } as const
const file = { _tag: 'File' } as const
const todo = { number: 3, line: 7, state: 'open' as const, text: 'Ship', indent: 0, section: 'tasks' }
const todoChange = { kind: 'checked' as const, number: 3, text: 'Ship', line: 7, oldLine: 7 }
const section = { id: 'tasks', title: 'Tasks', level: 2 as const, line: 3 }

const roundTrip = (schema: any, value: any): unknown => {
  const json = JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value)))
  return Schema.decodeUnknownSync(schema)(json)
}

describe('protocol schemas', () => {
  it('accepts explicit undefined for optional payload fields', () => {
    const madeRead = Schema.make(ReadPayload.ast)
    const madeWatch = Schema.make(WatchPayload.ast)
    expect(Schema.decodeUnknownSync(madeRead)({ path: '/TODO.md', section: undefined })).toMatchObject({ path: '/TODO.md', section: undefined })
    expect(Schema.decodeUnknownSync(madeWatch)({ path: '/TODO.md', since: undefined, text: false })).toMatchObject({ path: '/TODO.md', since: undefined, text: false })
    expect(Schema.decodeUnknownSync(ReadPayload)({ path: '/TODO.md', section: undefined })).toMatchObject({ path: '/TODO.md', section: undefined })
  })

  it('round trips every payload and success schema through JSON', () => {
    const samples: Array<readonly [any, any]> = [
      [StatusPayload, {}],
      [StatusSuccess, { pid: 10, appVersion: APP_VERSION, port: 3210, startedAt: 123, documents: [{ path: '/TODO.md', version: 1, watchers: 0 }] }],
      [StopPayload, {}],
      [StopSuccess, {}],
      [OpenPayload, { path: '/TODO.md', create: true }],
      [OpenSuccess, { path: '/TODO.md', version: 1, url: 'http://127.0.0.1:3210/?path=%2FTODO.md', created: true }],
      [ReadPayload, { path: '/TODO.md' }],
      [ReadSuccess, { version: 1, text: '# TODO\n' }],
      [SectionsPayload, { path: '/TODO.md' }],
      [SectionsSuccess, { version: 1, sections: [section] }],
      [TodosPayload, { path: '/TODO.md', section: 'tasks' }],
      [TodosSuccess, { version: 1, todos: [todo] }],
      [EditPayload, { path: '/TODO.md', author, version: 1, op: { _tag: 'Replace', old: 'old', new: 'new' } }],
      [EditSuccess, { version: 2, changed: true, section: 'tasks', others: { since: 1, diff: null } }],
      [SyncPayload, { path: '/TODO.md', base: 1, text: '# TODO\n' }],
      [SyncSuccess, { version: 2, text: '# TODO\n' }],
      [DiffPayload, { path: '/TODO.md', since: 1, wait: 60 }],
      [DiffSuccess, { from: 1, to: 2, by: [agent], diff: '--- 1\n+++ 2\n', todos: [todoChange] }],
      [WatchPayload, { path: '/TODO.md', text: true }],
    ]

    for (const [schema, value] of samples) {
      expect(roundTrip(schema, value)).toEqual(value)
    }
  })

  it('round trips every error and watch event schema through JSON', () => {
    const errors = [
      new VersionMismatch({ latest: 4, since: 2, diff: null, forgotten: false }),
      new Refused({ code: 'invalid', message: 'bad request' }),
      new Forgotten({ latest: 4 }),
      new NothingYet({}),
      new DocumentGone({ path: '/TODO.md' }),
      new Unauthorized({}),
    ]
    for (const error of errors) {
      expect(roundTrip(RpcFailure, error)).toMatchObject(error)
    }

    const events = [
      { _tag: 'Watching', version: 1, text: '# TODO\n' },
      { _tag: 'Change', from: 1, to: 2, by: [author], diff: null, todos: [todoChange], text: '# TODO\n' },
      { _tag: 'Resync', version: 2 },
      { _tag: 'Deleted' },
    ]
    for (const event of events) {
      expect(roundTrip(WatchEvent, event)).toEqual(event)
    }
  })

  it('rejects invalid author names and over-cap text', () => {
    expect(() => Schema.decodeUnknownSync(Author)({ _tag: 'Agent', name: 'not valid' })).toThrow()
    expect(() => Schema.decodeUnknownSync(Author)({ _tag: 'Agent', name: '' })).toThrow()
    expect(() => Schema.decodeUnknownSync(ReadSuccess)({ version: 1, text: 'x'.repeat(2 * 1024 * 1024 + 1) })).toThrow()
    expect(() => Schema.decodeUnknownSync(Todo)({ ...todo, text: 'x'.repeat(4097) })).toThrow()
  })

  it('defines exactly ten rpcs and makes watch a stream', () => {
    expect([...DoItRpcs.requests.keys()]).toEqual([
      'status', 'stop', 'open', 'read', 'sections', 'todos', 'edit', 'sync', 'diff', 'watch',
    ])
    expect(editRpc.errorSchema).toBe(RpcFailure)
    expect(diffRpc.errorSchema).toBe(RpcFailure)
    expect(RpcSchema.isStreamSchema(watchRpc.successSchema)).toBe(true)
    expect((watchRpc.successSchema as any).success).toBe(WatchEvent)
    expect((watchRpc.successSchema as any).error).toBe(RpcFailure)
  })
})

describe('protocol formatting', () => {
  it('formats authors, todo changes, and version headers exactly', () => {
    expect(describeAuthor(author)).toBe('the user')
    expect(describeAuthor(agent)).toBe('t3')
    expect(describeAuthor(file)).toBe('file')
    expect(formatTodoChange(todoChange)).toBe('checked 3. Ship')
    expect(formatVersionHeader(7, 7, [author])).toBe('Version 7 by the user')
    expect(formatVersionHeader(6, 7, [author])).toBe('Version 7 by the user')
    expect(formatVersionHeader(4, 7, [author, agent])).toBe('Versions 5-7 by the user, t3')
    expect(formatVersionHeader(6, 7, [])).toBe('Version 7')
    expect(formatVersionHeader(4, 7, [])).toBe('Versions 5-7')
  })

  it('maps every failure to its documented exit code', () => {
    expect(exitCodeFor(new Refused({ code: 'invalid', message: 'bad' }))).toBe(2)
    expect(exitCodeFor(new Refused({ code: 'not-found', message: 'missing' }))).toBe(1)
    expect(exitCodeFor(new VersionMismatch({ latest: 2, since: 1, diff: null, forgotten: false }))).toBe(1)
    expect(exitCodeFor(new Forgotten({ latest: 2 }))).toBe(1)
    expect(exitCodeFor(new NothingYet({}))).toBe(4)
    expect(exitCodeFor(new DocumentGone({ path: '/TODO.md' }))).toBe(9)
    expect(exitCodeFor(new Unauthorized({}))).toBe(3)
  })
})

void [
  Agent, ChangeSchema, DeletedSchema, ResyncSchema, WatchingSchema, File, OpenSuccess, ReadSuccess,
  Replace, Append, TodoAdd, TodoSet, Section, SectionsSuccess, SyncPayload, TodosSuccess,
]

expect(PROTOCOL_VERSION).toBe(1)
