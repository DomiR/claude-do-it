import { afterAll, beforeAll, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EditOp, WatchEvent } from "@do-it/protocol"
import { ensureDaemon, paths, RpcClient, RpcClientLive, stopDaemon, withClient, type DaemonInfo, type DoItClient } from "../../client/src"
import { TEMPLATE } from "../src/config"
import { isolateDaemonEnvironment } from "../../client/test/environment"

isolateDaemonEnvironment()
const home = mkdtempSync(join(tmpdir(), "do-it-server-"))
const web = join(home, "web")
const pids = new Set<number>()
let info: DaemonInfo
let nextPath = 0
function file(text?: string) {
  const path = join(home, `notes-${nextPath++}.md`)
  if (text !== undefined) writeFileSync(path, text)
  return path
}
const call = <A, E>(f: (client: DoItClient) => Effect.Effect<A, E>) => Effect.runPromise(withClient(info, f))
async function failure<A, E>(f: (client: DoItClient) => Effect.Effect<A, E>) {
  const result = await call(client => f(client).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("Expected an RPC failure")
  return result.failure as E & { _tag: string; code?: string; latest?: number; since?: number; forgotten?: boolean; diff?: string | null }
}
function edit(path: string, version: number, op: EditOp, section?: string) {
  return call(client => client.edit({ path, version, op, author: { _tag: "Agent", name: "tester" }, ...(section ? { section } : {}) }))
}
async function eventually<A>(read: () => Promise<A> | A, check: (value: A) => boolean, timeout = 5000): Promise<A> {
  const until = Date.now() + timeout
  let last: A
  do {
    last = await read()
    if (check(last)) return last
    await Bun.sleep(25)
  } while (Date.now() < until)
  expect(check(last!)).toBe(true)
  return last!
}
async function start() {
  info = await Effect.runPromise(ensureDaemon({ home, port: 0, env: { DO_IT_WEB_DIST: web } }))
  pids.add(info.pid)
}
function watch(path: string, options: { since?: number; text?: boolean; section?: string } = {}) {
  const stream = Stream.unwrap(Effect.map(RpcClient, client => client.watch({ path, text: true, ...options }, { streamBufferSize: 1 })))
    .pipe(Stream.provide(RpcClientLive(info)))
  return Stream.toAsyncIterable(stream)[Symbol.asyncIterator]()
}
async function next(iterator: AsyncIterator<WatchEvent>): Promise<WatchEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([iterator.next(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Watch event did not arrive")), 5000)
    })])
    expect(result.done).not.toBe(true)
    return result.value!
  } finally { if (timer) clearTimeout(timer) }
}
const rawBody = JSON.stringify({ _tag: "Request", id: "1", tag: "status", payload: {}, headers: [] }) + "\n"

beforeAll(async () => {
  mkdirSync(web)
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Do it test</title>")
  writeFileSync(join(web, "app.js"), "console.log('web')")
  writeFileSync(join(web, "app.css"), "body { color: red }")
  await start()
}, 15000)
afterAll(async () => {
  await Effect.runPromise(stopDaemon(home).pipe(Effect.catch(() => Effect.succeed(false))))
  for (const pid of pids) { try { process.kill(pid, "SIGTERM") } catch {} }
  rmSync(home, { recursive: true, force: true })
})

test("HTTP authenticates RPC, checks Host and Origin, and bounds request bodies", async () => {
  expect((await fetch(`${info.baseUrl}/health`)).status).toBe(200)
  expect((await fetch(`${info.baseUrl}/rpc`, { method: "POST", body: rawBody })).status).toBe(401)
  expect((await fetch(`${info.baseUrl}/rpc`, { method: "POST", body: rawBody, headers: { Authorization: "Bearer wrong" } })).status).toBe(401)
  expect((await fetch(`${info.baseUrl}/health`, { headers: { Host: "evil.example" } })).status).toBe(403)
  expect((await fetch(`${info.baseUrl}/health`, { headers: { Origin: "http://evil.example" } })).status).toBe(403)
  expect((await fetch(`${info.baseUrl}/health`, { headers: { Host: `localhost:${info.port}`, Origin: `http://localhost:${info.port}` } })).status).toBe(200)
  expect((await fetch(`${info.baseUrl}/rpc`, { method: "POST", headers: { Authorization: `Bearer ${info.token}` }, body: "x".repeat(4 * 1024 * 1024 + 1) })).status).toBe(413)
  expect((await fetch(`${info.baseUrl}/rpc`, { method: "POST", headers: { Authorization: `Bearer ${info.token}` }, body: rawBody.repeat(65) })).status).toBe(413)
  // A chunked body must obey the same cap without relying on Content-Length.
  const body = new ReadableStream({ start(controller) {
    for (let i = 0; i < 65; i++) controller.enqueue(new Uint8Array(65536))
    controller.close()
  } })
  expect((await fetch(`${info.baseUrl}/rpc`, { method: "POST", headers: { Authorization: `Bearer ${info.token}` }, body })).status).toBe(413)
})

test("open creates the template and issues a single use cookie link", async () => {
  const path = file()
  const opened = await call(client => client.open({ path, create: true }))
  expect(opened).toMatchObject({ path, version: 1, created: true })
  expect(readFileSync(path, "utf8")).toBe(TEMPLATE)
  const url = new URL(opened.url)
  expect(url.hostname).toBe("127.0.0.1")
  expect(url.pathname).toBe("/auth")
  expect(url.searchParams.get("path")).toBe(path)
  expect(opened.url).not.toContain(info.token)
  const auth = await fetch(opened.url, { redirect: "manual" })
  expect(auth.status).toBe(303)
  expect(auth.headers.get("location")).toBe(`/?path=${encodeURIComponent(path)}`)
  const cookie = auth.headers.get("set-cookie")!
  expect(cookie).toContain("HttpOnly")
  expect(cookie).toContain("SameSite=Strict")
  expect(cookie).toContain("Path=/")
  const again = await fetch(opened.url, { redirect: "manual" })
  expect(again.status).toBe(401)
  expect(await again.text()).toContain("do-it open")
  const reply = await fetch(`${info.baseUrl}/rpc`, { method: "POST", headers: { Cookie: cookie.split(";")[0]! }, body: rawBody })
  expect(reply.status).toBe(200)
  expect(JSON.parse(await reply.text()).exit.value.pid).toBe(info.pid)
  expect((await call(client => client.open({ path, create: true }))).created).toBe(false)
})

test("static assets have content types, SPA fallback, and no symlink escape", async () => {
  expect(await (await fetch(`${info.baseUrl}/`)).text()).toContain("Do it test")
  expect(await (await fetch(`${info.baseUrl}/some/route`)).text()).toContain("Do it test")
  expect((await fetch(`${info.baseUrl}/app.js`)).headers.get("content-type")).toContain("javascript")
  expect((await fetch(`${info.baseUrl}/app.css`)).headers.get("content-type")).toContain("text/css")
  symlinkSync(paths(home).token, join(web, "secret"))
  expect((await fetch(`${info.baseUrl}/secret`)).status).toBe(403)
  renameSync(join(web, "index.html"), join(web, "index.saved"))
  try { expect(await (await fetch(`${info.baseUrl}/`)).text()).toContain("bun run build:web") }
  finally { renameSync(join(web, "index.saved"), join(web, "index.html")) }
})

test("read, sections, todos and all edit operations use document versions", async () => {
  const path = file("# Todo\n- [ ] alpha\n## Later\n- [ ] beta\n")
  expect(await call(client => client.read({ path }))).toEqual({ version: 1, text: readFileSync(path, "utf8") })
  expect((await call(client => client.sections({ path }))).sections).toEqual([
    { id: "todo", title: "Todo", level: 1, line: 0 }, { id: "later", title: "Later", level: 2, line: 2 },
  ])
  expect((await call(client => client.read({ path, section: "later" }))).text).toBe("## Later\n- [ ] beta\n")
  expect((await call(client => client.todos({ path, section: "later" }))).todos.map(todo => todo.number)).toEqual([2])
  expect(await edit(path, 1, { _tag: "Replace", old: "alpha", new: "first" })).toMatchObject({ version: 2, changed: true, section: null, others: null })
  expect((await edit(path, 2, { _tag: "Append", text: "Later note" }, "later")).version).toBe(3)
  expect((await edit(path, 3, { _tag: "TodoAdd", text: "ship" }, "later")).version).toBe(4)
  expect((await edit(path, 4, { _tag: "TodoSet", target: "ship", state: "done" })).version).toBe(5)
  expect(await edit(path, 5, { _tag: "TodoSet", target: 3, state: "done" })).toMatchObject({ version: 5, changed: false })
  const list = await call(client => client.todos({ path }))
  expect(list.todos.map(todo => [todo.number, todo.text, todo.state])).toEqual([
    [1, "first", "open"], [2, "beta", "open"], [3, expect.stringMatching(/^ship @done \(\d{2}-\d{2}-\d{2} \d{2}:\d{2}\)$/), "done"],
  ])
  const changes = await call(client => client.diff({ path, since: 1, wait: 0 }))
  expect(changes).toMatchObject({ from: 1, to: 5, by: [{ _tag: "Agent", name: "tester" }] })
  expect(changes.diff).toContain("--- 1\n+++ 5")
  expect(changes.todos.some(todo => todo.kind === "added" && todo.text === "ship")).toBe(true)
  expect((await call(client => client.status({}))).documents).toContainEqual({ path, version: 5, watchers: 0 })
})

test("typed refusals and stale conflicts include the current version and diff", async () => {
  const path = file("# First\nhello\n## Other\nworld\n")
  await call(client => client.read({ path }))
  await edit(path, 1, { _tag: "Replace", old: "world", new: "earth" })
  const conflict = await failure(client => client.edit({ path, version: 1, author: { _tag: "Agent", name: "stale" }, op: { _tag: "Append", text: "no" } }))
  expect(conflict).toMatchObject({ _tag: "VersionMismatch", latest: 2, since: 1, forgotten: false })
  expect(conflict.diff).toContain("+earth")
  // A level 1 section includes subsections; use two peer headings for independent scopes.
  const scoped = file("## First\nhello\n## Other\nworld\n")
  await call(client => client.read({ path: scoped }))
  await edit(scoped, 1, { _tag: "Replace", old: "world", new: "earth" }, "other")
  expect(await edit(scoped, 1, { _tag: "Replace", old: "hello", new: "hi" }, "first")).toMatchObject({ version: 3, section: "first", others: { since: 1 } })
  const staleSection = await failure(client => client.edit({ path: scoped, version: 1, section: "other", author: { _tag: "Agent", name: "stale" }, op: { _tag: "Append", text: "no" } }))
  expect(staleSection._tag).toBe("VersionMismatch")
  expect((await failure(client => client.read({ path, section: "absent" }))).code).toBe("not-found")
  expect((await failure(client => client.read({ path: join(home, "no.txt") }))).code).toBe("invalid")
  expect((await failure(client => client.open({ path: join(home, "absent", "no.md"), create: true }))).code).toBe("invalid")
  expect((await failure(client => client.open({ path: file(), create: false }))).code).toBe("invalid")
  const duplicate = file("same same\n")
  expect((await failure(client => client.edit({ path: duplicate, version: 1, author: { _tag: "Agent", name: "test" }, op: { _tag: "Replace", old: "same", new: "x" } }))).code).toBe("ambiguous")
})

test("stale browser sync and agent edits both survive, attributed to User and Agent", async () => {
  const base = "# Todo\n- [ ] alpha\n- [ ] beta\n"
  const path = file(base)
  await call(client => client.read({ path }))
  await edit(path, 1, { _tag: "Replace", old: "beta", new: "beta AGENT" })
  expect(await call(client => client.sync({ path, base: 1, text: base.replace("alpha", "alpha USER") }))).toEqual({
    version: 3, text: "# Todo\n- [ ] alpha USER\n- [ ] beta AGENT\n",
  })
  expect((await call(client => client.diff({ path, since: 1, wait: 0 }))).by).toEqual([{ _tag: "Agent", name: "tester" }, { _tag: "User" }])
})

test("long poll waits for a change and NothingYet means its deadline expired", async () => {
  const path = file("before\n")
  await call(client => client.read({ path }))
  expect((await failure(client => client.diff({ path, since: 1, wait: 0.05 })))._tag).toBe("NothingYet")
  const pending = call(client => client.diff({ path, since: 1, wait: 2 }))
  await Bun.sleep(50)
  await edit(path, 1, { _tag: "Replace", old: "before", new: "after" })
  expect(await pending).toMatchObject({ from: 1, to: 2 })
})

test("watch emits Watching, Change with authors and todos, file Change, and Deleted", async () => {
  const path = file("# Todo\n- [ ] ship\n")
  const iterator = watch(path)
  try {
    expect(await next(iterator)).toEqual({ _tag: "Watching", version: 1, text: "# Todo\n- [ ] ship\n" })
    await eventually(() => call(client => client.status({})), status => status.documents.some(doc => doc.path === path && doc.watchers === 1))
    await edit(path, 1, { _tag: "TodoSet", target: 1, state: "done" })
    const changed = await next(iterator)
    expect(changed).toMatchObject({ _tag: "Change", from: 1, to: 2, by: [{ _tag: "Agent", name: "tester" }], text: expect.stringMatching(/^# Todo\n- \[x\] ship @done \(\d{2}-\d{2}-\d{2} \d{2}:\d{2}\)\n$/) })
    if (changed._tag === "Change") expect(changed.todos).toContainEqual({ kind: "checked", number: 1, text: "ship", line: 1, oldLine: 1 })
    await eventually(() => readFileSync(path, "utf8"), text => text.includes("[x]"))
    const replacement = `${path}.tmp`
    writeFileSync(replacement, "# Todo\n- [x] ship\n- [ ] external\n")
    renameSync(replacement, path)
    expect(await next(iterator)).toMatchObject({ _tag: "Change", from: 2, to: 3, by: [{ _tag: "File" }], text: "# Todo\n- [x] ship\n- [ ] external\n" })
    unlinkSync(path)
    expect(await next(iterator)).toEqual({ _tag: "Deleted" })
    expect((await failure(client => client.read({ path })))._tag).toBe("DocumentGone")
    expect((await iterator.next()).done).toBe(true)
  } finally { await iterator.return?.() }
})

test("atomic writes keep disk format and mode and their echoes take no version", async () => {
  const path = file("\ufeff# Todo\r\n- [ ] ship\r\n")
  chmodSync(path, 0o640)
  await call(client => client.read({ path }))
  await edit(path, 1, { _tag: "TodoSet", target: 1, state: "done" })
  await eventually(() => readFileSync(path, "utf8"), text => /^\ufeff# Todo\r\n- \[x\] ship @done \(\d{2}-\d{2}-\d{2} \d{2}:\d{2}\)\r\n$/.test(text))
  expect(statSync(path).mode & 0o777).toBe(0o640)
  await Bun.sleep(125)
  expect((await call(client => client.read({ path }))).version).toBe(2)
})

test("many live streams leave RPC capacity available, and excess document streams are refused", async () => {
  const files = Array.from({ length: 9 }, () => file("# Watched\n"))
  await Effect.runPromise(Effect.scoped(withClient(info, client => Effect.gen(function* () {
    for (const [index, path] of files.entries()) {
      for (let i = 0; i < (index === 0 ? 32 : 8); i++) {
        const pull = yield* Stream.toPull(client.watch({ path, text: false }, { streamBufferSize: 1 }))
        expect((yield* pull)[0]).toEqual({ _tag: "Watching", version: 1 })
      }
    }
    const status = yield* client.status({})
    expect(status.documents.reduce((sum, doc) => sum + doc.watchers, 0)).toBe(96)
    const extra = yield* Stream.toPull(client.watch({ path: files[0]!, text: false }))
    const refused = yield* extra.pipe(Effect.result)
    expect(refused._tag).toBe("Failure")
    if (refused._tag === "Failure") expect(refused.failure).toMatchObject({ _tag: "Refused", code: "too-large" })
  }))).pipe(Effect.timeout(10000)))
  await eventually(() => call(client => client.status({})), status => status.documents.every(doc => doc.watchers === 0))
}, 15000)

test("restart preserves versions and cookies, while offline file edits take the next version", async () => {
  const path = file("before\n")
  const opened = await call(client => client.open({ path, create: false }))
  const cookie = (await fetch(opened.url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!
  await edit(path, 1, { _tag: "Replace", old: "before", new: "after" })
  const token = info.token
  await Effect.runPromise(stopDaemon(home))
  expect(readFileSync(path, "utf8")).toBe("after\n")
  expect(existsSync(paths(home).versions)).toBe(true)
  await start()
  expect(info.token).toBe(token)
  expect(await call(client => client.read({ path }))).toEqual({ version: 2, text: "after\n" })
  const reply = await fetch(`${info.baseUrl}/rpc`, { method: "POST", headers: { Cookie: cookie }, body: rawBody })
  expect(JSON.parse(await reply.text()).exit.value.pid).toBe(info.pid)
  expect((await failure(client => client.diff({ path, since: 1, wait: 0 })))._tag).toBe("Forgotten")
  expect((await failure(client => client.sync({ path, base: 1, text: "stale\n" })))._tag).toBe("Forgotten")
  const conflict = await failure(client => client.edit({ path, version: 1, author: { _tag: "Agent", name: "old" }, op: { _tag: "Append", text: "x" } }))
  expect(conflict).toMatchObject({ _tag: "VersionMismatch", latest: 2, forgotten: true, diff: null })
  await Effect.runPromise(stopDaemon(home))
  writeFileSync(path, "offline edit\n")
  await start()
  expect(await call(client => client.read({ path }))).toEqual({ version: 3, text: "offline edit\n" })
})
