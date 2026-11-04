import { afterAll, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureDaemon, paths, readDaemonInfo, stopDaemon, withClient } from "../src"
import { isolateDaemonEnvironment } from "./environment"

const defaultHome = isolateDaemonEnvironment()
const homes: string[] = []
const pids = new Set<number>()
function home() { const dir = mkdtempSync(join(tmpdir(), "do-it-client-")); homes.push(dir); return dir }
async function start(dir: string, env: Record<string, string> = {}, port = 0) {
  const info = await Effect.runPromise(ensureDaemon({ home: dir, port, env }))
  pids.add(info.pid)
  return info
}
async function eventually(f: () => boolean, timeout = 5000) {
  const until = Date.now() + timeout
  while (!f() && Date.now() < until) await Bun.sleep(25)
  expect(f()).toBe(true)
}
afterAll(async () => {
  for (const dir of homes) await Effect.runPromise(stopDaemon(dir).pipe(Effect.catch(() => Effect.succeed(false))))
  for (const pid of pids) { try { process.kill(pid, "SIGTERM") } catch {} }
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

test("omitting home uses the isolated DO_IT_HOME for every lifecycle operation", async () => {
  expect(paths().home).toBe(defaultHome)
  const info = await Effect.runPromise(ensureDaemon())
  pids.add(info.pid)
  expect(info.home).toBe(defaultHome)
  expect(readDaemonInfo()).toEqual(info)
  expect(await Effect.runPromise(stopDaemon())).toBe(true)
  await eventually(() => readDaemonInfo() === null)
}, 10000)

test("spawns, reuses, reports status, and stops a daemon in a private home", async () => {
  const dir = home()
  expect(readDaemonInfo(dir)).toBeNull()
  const info = await start(dir)
  expect(info.home).toBe(dir)
  expect(info.baseUrl).toBe(`http://127.0.0.1:${info.port}`)
  expect(info.token).toMatch(/^[a-f0-9]{64}$/)
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(paths(dir).daemon).mode & 0o777).toBe(0o600)
  expect(statSync(paths(dir).token).mode & 0o777).toBe(0o600)
  expect(await Effect.runPromise(ensureDaemon({ home: dir, port: 0 }))).toEqual(info)
  expect(await (await fetch(`${info.baseUrl}/health`)).json()).toEqual({ ok: true, pid: info.pid, appVersion: info.appVersion })
  const status = await Effect.runPromise(withClient(info, client => client.status({})))
  expect(status).toEqual({ pid: info.pid, port: info.port, appVersion: info.appVersion, startedAt: info.startedAt, documents: [] })
  expect(await Effect.runPromise(stopDaemon(dir))).toBe(true)
  await eventually(() => readDaemonInfo(dir) === null)
  expect(await Effect.runPromise(stopDaemon(dir))).toBe(false)
}, 15000)

test("concurrent callers share a daemon and recover a dead startup lock", async () => {
  const dir = home()
  mkdirSync(paths(dir).lock)
  writeFileSync(paths(dir).lockPid, "2147483647")
  const infos = await Promise.all([start(dir), start(dir), start(dir)])
  expect(new Set(infos.map(info => info.pid)).size).toBe(1)
  expect(await Effect.runPromise(stopDaemon(dir))).toBe(true)
}, 15000)

test("an old lock stays owned while its creator is alive", async () => {
  const dir = home()
  const p = paths(dir)
  mkdirSync(p.lock)
  writeFileSync(p.lockPid, String(process.pid))
  const old = new Date(Date.now() - 11000)
  utimesSync(p.lock, old, old)
  const held = statSync(p.lock)
  const result = await Effect.runPromise(ensureDaemon({ home: dir, port: 0 }).pipe(Effect.timeoutOption(250)))
  if (result._tag === "Some") pids.add(result.value.pid)
  expect(result._tag).toBe("None")
  expect(readDaemonInfo(dir)).toBeNull()
  expect(statSync(p.lock).ino).toBe(held.ino)
  expect(statSync(p.lock).mtimeMs).toBe(held.mtimeMs)
  expect(readFileSync(p.lockPid, "utf8")).toBe(String(process.pid))
}, 15000)

test("an old lock without a pid file is recovered", async () => {
  const dir = home()
  mkdirSync(paths(dir).lock)
  const old = new Date(Date.now() - 11000)
  utimesSync(paths(dir).lock, old, old)
  const info = await start(dir)
  expect(info.pid).not.toBe(process.pid)
  await Effect.runPromise(stopDaemon(dir))
}, 15000)

test("a mismatched app version is stopped and replaced, preserving its token", async () => {
  const dir = home()
  const first = await start(dir)
  const record = JSON.parse(readFileSync(paths(dir).daemon, "utf8"))
  writeFileSync(paths(dir).daemon, JSON.stringify({ ...record, appVersion: "old" }))
  const second = await start(dir)
  expect(second.pid).not.toBe(first.pid)
  expect(second.token).toBe(first.token)
  await Effect.runPromise(stopDaemon(dir))
}, 15000)

test("port collision falls back to an available loopback port", async () => {
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") })
  try {
    const info = await start(home(), {}, occupied.port!)
    expect(info.port).not.toBe(occupied.port)
    await Effect.runPromise(stopDaemon(info.home))
  } finally { occupied.stop(true) }
}, 15000)

test("spawn false returns a typed error and does not start a process", async () => {
  const dir = home()
  const result = await Effect.runPromise(ensureDaemon({ home: dir, port: 0, spawn: false }).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure._tag).toBe("DaemonUnavailable")
  expect(readDaemonInfo(dir)).toBeNull()
})

test("a corrupted runtime record can be replaced", async () => {
  const dir = home()
  writeFileSync(paths(dir).daemon, "{broken")
  const info = await start(dir)
  expect(readDaemonInfo(dir)).toEqual(info)
  await Effect.runPromise(stopDaemon(dir))
})

test("idle shutdown removes the runtime record", async () => {
  const dir = home()
  const info = await start(dir, { DO_IT_IDLE_MS: "250" })
  await eventually(() => readDaemonInfo(dir) === null)
  await expect(fetch(`${info.baseUrl}/health`)).rejects.toBeDefined()
}, 10000)

test("an open stream prevents idle exit and releasing it allows shutdown", async () => {
  const dir = home()
  const path = join(dir, "watched.md")
  writeFileSync(path, "watch me\n")
  const info = await start(dir, { DO_IT_IDLE_MS: "250" })
  await Effect.runPromise(Effect.scoped(withClient(info, client => Effect.gen(function* () {
    const pull = yield* Stream.toPull(client.watch({ path, text: false }))
    expect((yield* pull)[0]._tag).toBe("Watching")
    yield* Effect.sleep(650)
    expect((yield* client.status({})).documents).toContainEqual({ path, version: 1, watchers: 1 })
  }))))
  await eventually(() => readDaemonInfo(dir) === null)
}, 10000)

test("stop replies and shuts down even with an open watch stream", async () => {
  const dir = home()
  const path = join(dir, "watched.md")
  writeFileSync(path, "watch me\n")
  const info = await start(dir)
  await Effect.runPromise(Effect.scoped(withClient(info, client => Effect.gen(function* () {
    const pull = yield* Stream.toPull(client.watch({ path, text: false }))
    expect((yield* pull)[0]._tag).toBe("Watching")
    expect(yield* client.stop({})).toEqual({})
    yield* Effect.promise(() => eventually(() => readDaemonInfo(dir) === null))
  }))).pipe(Effect.timeout(5000)))
  await expect(fetch(`${info.baseUrl}/health`)).rejects.toBeDefined()
}, 10000)

test("stop falls back to SIGTERM when RPC authentication fails", async () => {
  const dir = home()
  await start(dir)
  writeFileSync(paths(dir).token, "0".repeat(64))
  expect(await Effect.runPromise(stopDaemon(dir))).toBe(true)
  await eventually(() => readDaemonInfo(dir) === null)
}, 10000)

test("SIGTERM and SIGINT perform graceful cleanup and exit zero", async () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const dir = home()
    const child = Bun.spawn([process.execPath, "packages/server/src/main.ts"], {
      env: { ...process.env, DO_IT_HOME: dir, DO_IT_PORT: "0" }, stdout: "ignore", stderr: "pipe",
    })
    pids.add(child.pid)
    await eventually(() => readDaemonInfo(dir) !== null)
    child.kill(signal)
    expect(await child.exited).toBe(0)
    expect(readDaemonInfo(dir)).toBeNull()
  }
}, 15000)
