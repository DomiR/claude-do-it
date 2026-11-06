import { expect, test } from 'bun:test'
import { Effect, Layer, Option, Stream } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command, given, message, model as assertModel, story } from 'foldkit/story'

import { makeServer } from '../../server/src/http'
import { ServerServices } from '../../server/src/services'
import { ApplyRemoteText } from './command'
import { Message } from './message'
import { makeInitialModel } from './model'
import { DoItClient, DoItClientLive } from './rpc'
import { subscriptions } from './subscription'
import { update } from './update'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

test('the browser subscription omits an absent since on the wire and stays live for changes and sync', async () => {
  const home = mkdtempSync(join(tmpdir(), 'do-it-web-rpc-'))
  const path = join(home, 'TODO.md')
  const original = '# Tasks\n- [ ] Ship the editor\n'
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location')
  writeFileSync(path, original)
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const server = yield* makeServer({ home, port: 0, idleMs: 10000, webDist: join(home, 'dist') })
      const baseUrl = `http://127.0.0.1:${server.port}`
      Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(baseUrl) })
      const code = yield* server.auth.mint(path)
      const auth = yield* Effect.promise(() => fetch(`${baseUrl}/auth?code=${code}&path=${encodeURIComponent(path)}`, { redirect: 'manual' }))
      expect(auth.status).toBe(303)
      const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
      const requests: Array<{ url: string; payload: Record<string, unknown> }> = []

      // Bun needs an absolute URL and a cookie jar. Everything after that uses
      // the actual web client, schemas, ndjson transport, and daemon handlers.
      const browserFetch = Object.assign(async (...[input, init]: Parameters<typeof fetch>) => {
        const url = new URL(String(input), baseUrl)
        const headers = new Headers(init?.headers)
        if (url.origin === baseUrl && init?.credentials !== 'omit') headers.set('cookie', cookie)
        const request = new Request(url, { ...init, headers })
        const body = await request.clone().text()
        for (const line of body.trim().split('\n')) {
          const message = JSON.parse(line)
          requests.push({ url: url.pathname, payload: message.payload })
        }
        return fetch(request)
      }, { preconnect: fetch.preconnect })
      const browser = DoItClientLive.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, browserFetch)))

      yield* Effect.scoped(Effect.gen(function* () {
        const client = yield* DoItClient
        let model = makeInitialModel(path)
        const dependencies = subscriptions.watch.modelToDependencies(model)
        const pull = yield* Stream.toPull(subscriptions.watch.dependenciesToStream(dependencies).pipe(Stream.rechunk(1)))
        const first = (yield* pull)[0]!
        expect(first).toEqual(Message.ReceivedWatchEvent({ event: { _tag: 'Watching', version: 1, hash: sha256(original), text: original } }))
        // Schema.optional permits undefined in memory, but toCodecJson encodes
        // a present undefined as null, which an already running daemon rejects.
        expect(requests[0]).toEqual({ url: '/rpc/', payload: { path, text: true } })
        model = update(model, first).model
        expect(model.document._tag).toBe('Ready')
        if (model.document._tag === 'Ready') expect(model.document.document.connection._tag).toBe('Live')
        yield* Effect.sleep(50)
        expect(server.documents.status()).toContainEqual({ path, version: 1, watchers: 1 })

        const changed = yield* client.edit({ path, version: 1, author: { _tag: 'Agent', name: 'regression' }, op: { _tag: 'TodoAdd', text: 'Added by agent' } })
        expect(changed.version).toBe(2)
        const change = (yield* pull)[0]!
        expect(change._tag).toBe('ReceivedWatchEvent')
        if (change._tag === 'ReceivedWatchEvent') {
          expect(change.event).toMatchObject({ _tag: 'Change', from: 1, to: 2, by: [{ _tag: 'Agent', name: 'regression' }] })
        }
        if (model.document._tag !== 'Ready') throw new Error('The editor did not become ready')
        const session = model.document.document.session
        const token = model.document.document.nextToken
        if (change._tag !== 'ReceivedWatchEvent' || change.event._tag !== 'Change' || change.event.text === undefined) {
          throw new Error('The live Change did not include text')
        }
        const remoteText = change.event.text
        // The Mount owns the editor. Resolve its Command here and deliver the
        // same acknowledgement the Mount emits, without starting a browser.
        story(update, given(model), message(change),
          Command.resolve(ApplyRemoteText, Message.CompletedApplyRemoteText({ token })),
          message(Message.UpdatedEditor({ session, text: remoteText, anchor: 0, head: 0, origin: 'Remote', token })),
          assertModel(next => { model = next }),
        )
        if (model.document._tag !== 'Ready') throw new Error('The subscription did not stay ready')
        expect(model.document.document.draft).toContain('Added by agent')
        const checkedText = model.document.document.draft.replace('- [ ] Ship the editor', '- [x] Ship the editor')
        const action = update(model, Message.UpdatedEditor({ session, text: checkedText, anchor: 0, head: 0, origin: 'Action', token: null }))
        const sync = action.commands?.[0]
        if (!sync || sync.name !== 'SyncDraft') throw new Error('The action did not request sync')
        expect(sync.args).toEqual({ path, base: 2, text: checkedText, baseHash: sha256(remoteText) })
        const synced = yield* sync.effect
        if (synced._tag !== 'SucceededSync') throw new Error('The action sync failed')
        model = update(action.model, synced).model
        expect(synced.text).toContain('- [x] Ship the editor')
        expect(synced.text).toContain('Added by agent')
        expect(requests.at(-1)?.payload).toEqual({ path, base: 2, text: checkedText, baseHash: sha256(remoteText) })
        expect(synced.hash).toBe(sha256(synced.text))
        expect((yield* client.read({ path })).text).toBe(synced.text)
        expect((yield* pull)[0]).toMatchObject({ _tag: 'ReceivedWatchEvent', event: { _tag: 'Change', from: 2, to: 3, by: [{ _tag: 'User' }] } })

        // A reconnect must still carry its concrete resume version and the hash of its text.
        const resume = subscriptions.watch.dependenciesToStream({ maybeWatch: Option.some({ path, watchKey: 1, resumeFrom: Option.some({ version: 2, hash: sha256(remoteText) }) }) })
        const resumed = yield* Stream.toPull(resume.pipe(Stream.rechunk(1)))
        expect((yield* resumed)[0]).toMatchObject({ _tag: 'ReceivedWatchEvent', event: { _tag: 'Watching', version: 3, hash: sha256(synced.text) } })
        expect(requests.at(-1)?.payload).toEqual({ path, since: 2, sinceHash: sha256(remoteText), text: true })
        expect((yield* resumed)[0]).toMatchObject({ _tag: 'ReceivedWatchEvent', event: { _tag: 'Change', from: 2, to: 3 } })

        // A version the daemon gave to another text starts over from its current text.
        const stale = subscriptions.watch.dependenciesToStream({ maybeWatch: Option.some({ path, watchKey: 2, resumeFrom: Option.some({ version: 2, hash: sha256('another text\n') }) }) })
        const restarted = yield* Stream.toPull(stale.pipe(Stream.rechunk(1)))
        expect((yield* restarted)[0]).toMatchObject({ _tag: 'ReceivedWatchEvent', event: { _tag: 'Resync', version: 3, text: synced.text } })
      }).pipe(Effect.provide(browser)))
      const deadline = Date.now() + 1000
      while (server.documents.totalWatchers !== 0 && Date.now() < deadline) yield* Effect.sleep(10)
      expect(server.documents.status()).toContainEqual({ path, version: 3, watchers: 0 })
    })).pipe(Effect.timeout(5000), Effect.provide(ServerServices)))
  } finally {
    if (location) Object.defineProperty(globalThis, 'location', location)
    else Reflect.deleteProperty(globalThis, 'location')
    rmSync(home, { recursive: true, force: true })
  }
}, 10000)
