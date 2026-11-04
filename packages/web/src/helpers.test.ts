import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'

import { DocumentGone, Forgotten, Unauthorized, VersionMismatch } from '@do-it/protocol'
import { syncFailureKind } from './command'
import { Message } from './message'
import { ConnectionState, makeInitialModel, saveStatus, type ReadyDocument } from './model'
import { update } from './update'
import { cursorLabel } from './view/editor'
import { matchesSubsequence } from './view/palette'

const ready = (): ReadyDocument => {
  const next = update(makeInitialModel('/tmp/TODO.md'), Message.ReceivedWatchEvent({
    event: { _tag: 'Watching', version: 1, text: '- [ ] Ship\n' },
  })).model
  if (next.document._tag !== 'Ready') throw new Error('Expected a ready document')
  return next.document.document
}

describe('editor status', () => {
  test('distinguishes a saved draft, unsent edits, requests, remote application, and reconnecting', () => {
    const document = ready()
    expect(saveStatus(document)).toBe('Saved')
    expect(saveStatus({ ...document, draft: 'local' })).toBe('Saving')
    expect(saveStatus({ ...document, inFlight: Option.some({ base: 1, text: document.draft }) })).toBe('Saving')
    expect(saveStatus({ ...document, pendingRemote: Option.some({ token: 1, version: 2, to: 'remote', resync: false }) })).toBe('Saving')
    expect(saveStatus({ ...document, connection: ConnectionState.Reconnecting({ awaitingResync: false }) })).toBe('Reconnecting')
  })

  test('shows grapheme columns while preserving UTF-16 selection offsets', () => {
    const prefix = '# Tasks\n👩‍💻e\u0301'
    expect(cursorLabel(prefix, prefix.length)).toBe('Ln 2, Col 3')
    expect(cursorLabel('text\n', 5)).toBe('Ln 2, Col 1')
    expect(cursorLabel('', 100)).toBe('Ln 1, Col 1')
  })
})

describe('command helpers', () => {
  test('matches case insensitive subsequences in order', () => {
    expect(matchesSubsequence('Toggle done', 'TgDn')).toBe(true)
    expect(matchesSubsequence('Toggle done', 'dt')).toBe(false)
    expect(matchesSubsequence('Toggle done', '')).toBe(true)
  })

  test('classifies typed RPC failures before the update decides how to recover', () => {
    expect(syncFailureKind(new Unauthorized({}))).toBe('Unauthorized')
    expect(syncFailureKind(new Forgotten({ latest: 12 }))).toBe('Forgotten')
    expect(syncFailureKind(new DocumentGone({ path: '/tmp/TODO.md' }))).toBe('DocumentGone')
    expect(syncFailureKind(new VersionMismatch({ latest: 12, since: 1, diff: null, forgotten: true }))).toBe('Forgotten')
    expect(syncFailureKind(new VersionMismatch({ latest: 12, since: 11, diff: null, forgotten: false }))).toBe('Transient')
    expect(syncFailureKind({ _tag: 'RpcClientError' })).toBe('Transient')
  })
})
