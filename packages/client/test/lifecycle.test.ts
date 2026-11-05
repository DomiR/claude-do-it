import { afterAll, expect, test } from "bun:test"
import { APP_VERSION } from "@do-it/protocol"
import { Effect, Stream } from "effect"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureDaemon, paths, readDaemonInfo, stopDaemon, withClient } from "../src"
import { isolateDaemonEnvironment, runClient } from "./environment"

const defaultHome = isolateDaemonEnvironment()
const homes: string[] = []
const pids = new Set<number>()
function home() { const dir = mkdtempSync(join(tmpdir(), "do-it-client-")); homes.push(dir); return dir }
const info = (dir?: string) => runClient(readDaemonInfo(dir))
const pathsOf = (dir?: string) => runClient(paths(dir))
async function start(dir: string, env: Record<string, string> = {}, port = 0) {
  const started = await runClient(ensureDaemon({ home: dir, port, env }))
  pids.add(started.pid)
  return started
}
async function eventually(f: () => boolean | Promise<boolean>, timeout = 5000) {
  const until = Date.now() + timeout
  while (!(await f()) && Date.now() < until) await Bun.sleep(25)
  expect(await f()).toBe(true)
}
afterAll(async () => {
  for (const dir of homes) await runClient(stopDaemon(dir))
  for (const pid of pids) { try { process.kill(pid, "SIGTERM") } catch {} }
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

test("omitting home uses the isolated DO_IT_HOME for every lifecycle operation", async () => {
  expect((await pathsOf()).home).toBe(defaultHome)
  const started = await runClient(ensureDaemon())
  pids.add(started.pid)
  expect(started.home).toBe(defaultHome)
  expect(await info()).toEqual(started)
  expect(await runClient(stopDaemon())).toBe(true)
  await eventually(async () => await info() === null)
}, 10000)

test("spawns, reuses, reports status, and stops a daemon in a private home", async () => {
  const dir = home()
  const p = await pathsOf(dir)
  expect(await info(dir)).toBeNull()
  const started = await start(dir)
  expect(started.home).toBe(dir)
  expect(started.baseUrl).toBe(`http://127.0.0.1:${started.port}`)
  expect(started.token).toMatch(/^[a-f0-9]{64}$/)
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(p.daemon).mode & 0o777).toBe(0o600)
  expect(statSync(p.token).mode & 0o777).toBe(0o600)
  expect(statSync(p.log).mode & 0o777).toBe(0o600)
  expect(await runClient(ensureDaemon({ home: dir, port: 0 }))).toEqual(started)
  expect(await (await fetch(`${started.baseUrl}/health`)).json()).toEqual({ ok: true, pid: started.pid, appVersion: started.appVersion })
  const status = await Effect.runPromise(withClient(started, client => client.status({})))
  expect(status).toEqual({ pid: started.pid, port: started.port, appVersion: started.appVersion, startedAt: started.startedAt, documents: [] })
  expect(await runClient(stopDaemon(dir))).toBe(true)
  await eventually(async () => await info(dir) === null)
  expect(await runClient(stopDaemon(dir))).toBe(false)
}, 15000)

test("a daemon that exits at startup fails fast and leaves its error output in the log", async () => {
  const dir = home()
  const p = await pathsOf(dir)
  const began = Date.now()
  const result = await runClient(ensureDaemon({ home: dir, port: 0, env: { DO_IT_IDLE_MS: "-1" } }).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.message).toBe(`The daemon did not start, see ${p.log}`)
  expect(Date.now() - began).toBeLessThan(4000)
  expect(readFileSync(p.log, "utf8")).toContain("DO_IT_IDLE_MS")
}, 15000)

test("concurrent callers share a daemon and recover a dead startup lock", async () => {
  const dir = home()
  const p = await pathsOf(dir)
  mkdirSync(p.lock)
  writeFileSync(p.lockPid, "2147483647")
  const infos = await Promise.all([start(dir), start(dir), start(dir)])
  expect(new Set(infos.map(item => item.pid)).size).toBe(1)
  expect(await runClient(stopDaemon(dir))).toBe(true)
}, 15000)

test("an old lock stays owned while its creator is alive", async () => {
  const dir = home()
  const p = await pathsOf(dir)
  mkdirSync(p.lock)
  writeFileSync(p.lockPid, String(process.pid))
  const old = new Date(Date.now() - 11000)
  utimesSync(p.lock, old, old)
  const held = statSync(p.lock)
  const result = await runClient(ensureDaemon({ home: dir, port: 0 }).pipe(Effect.timeoutOption(250)))
  if (result._tag === "Some") pids.add(result.value.pid)
  expect(result._tag).toBe("None")
  expect(await info(dir)).toBeNull()
  expect(statSync(p.lock).ino).toBe(held.ino)
  expect(statSync(p.lock).mtimeMs).toBe(held.mtimeMs)
  expect(readFileSync(p.lockPid, "utf8")).toBe(String(process.pid))
}, 15000)

test("an old lock without a pid file is recovered", async () => {
  const dir = home()
  const p = await pathsOf(dir)
  mkdirSync(p.lock)
  const old = new Date(Date.now() - 11000)
  utimesSync(p.lock, old, old)
  const started = await start(dir)
  expect(started.pid).not.toBe(process.pid)
  await runClient(stopDaemon(dir))
}, 15000)

for (const [label, contents] of [["empty", ""], ["garbage", "not a pid"]] as const) {
  test(`lock recovery for ${label} pid files waits until the lock is old`, async () => {
    const dir = home()
    const p = await pathsOf(dir)
    mkdirSync(p.lock)
    writeFileSync(p.lockPid, contents)
    const held = statSync(p.lock)
    const result = await runClient(ensureDaemon({ home: dir, port: 0 }).pipe(Effect.timeoutOption(250)))
    if (result._tag === "Some") pids.add(result.value.pid)
    expect(result._tag).toBe("None")
    expect(await info(dir)).toBeNull()
    expect(statSync(p.lock).ino).toBe(held.ino)
    expect(statSync(p.lock).mtimeMs).toBe(held.mtimeMs)
    expect(readFileSync(p.lockPid, "utf8")).toBe(contents)
    const old = new Date(Date.now() - 11000)
    utimesSync(p.lock, old, old)
    const started = await start(dir)
    expect(await info(dir)).toEqual(started)
    expect(await runClient(stopDaemon(dir))).toBe(true)
  }, 15000)
}

test("a mismatched app version is stopped and replaced, preserving its token", async () => {
  const dir = home()
  const p = await pathsOf(dir)
  const first = await start(dir)
  const record = JSON.parse(readFileSync(p.daemon, "utf8"))
  writeFileSync(p.daemon, JSON.stringify({ ...record, appVersion: "old" }))
  const second = await start(dir)
  expect(second.pid).not.toBe(first.pid)
  expect(second.token).toBe(first.token)
  await runClient(stopDaemon(dir))
}, 15000)

/** Writes daemon.json and the token for a daemon record the test controls. */
async function writeRecord(dir: string, record: { pid: number; port: number }) {
  const p = await pathsOf(dir)
  writeFileSync(p.daemon, JSON.stringify({ ...record, appVersion: APP_VERSION, startedAt: Date.now() }), { mode: 0o600 })
  writeFileSync(p.token, "a".repeat(64), { mode: 0o600 })
  return p
}

test("a live daemon whose health checks are slow is reused, not replaced", async () => {
  // The fake daemon is this test process, so it stays out of `homes` and `pids`.
  const dir = mkdtempSync(join(tmpdir(), "do-it-client-slow-"))
  let healthChecks = 0
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (new URL(request.url).pathname !== "/health") return new Response("not found", { status: 404 })
    // The first two checks answer after the 500 ms probe timeout, as on a busy machine.
    if (healthChecks++ < 2) await Bun.sleep(800)
    return Response.json({ ok: true, pid: process.pid, appVersion: APP_VERSION })
  } })
  try {
    const p = await writeRecord(dir, { pid: process.pid, port: fake.port! })
    const record = readFileSync(p.daemon, "utf8")
    const reused = await runClient(ensureDaemon({ home: dir, port: 0 }))
    expect(reused.pid).toBe(process.pid)
    expect(reused.port).toBe(fake.port!)
    expect(healthChecks).toBe(3)
    expect(readFileSync(p.daemon, "utf8")).toBe(record)
  } finally {
    fake.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 10000)

test("a daemon record with a dead pid is replaced", async () => {
  const dir = home()
  const p = await writeRecord(dir, { pid: 2147483647, port: 1 })
  const started = await start(dir)
  expect(started.pid).not.toBe(2147483647)
  expect(started.token).toBe("a".repeat(64))
  expect(await info(dir)).toEqual(started)
  expect(JSON.parse(readFileSync(p.daemon, "utf8")).pid).toBe(started.pid)
  expect(await runClient(stopDaemon(dir))).toBe(true)
}, 15000)

test("port collision falls back to an available loopback port", async () => {
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") })
  try {
    const started = await start(home(), {}, occupied.port!)
    expect(started.port).not.toBe(occupied.port)
    await runClient(stopDaemon(started.home))
  } finally { occupied.stop(true) }
}, 15000)

test("spawn false returns a typed error and does not start a process", async () => {
  const dir = home()
  const result = await runClient(ensureDaemon({ home: dir, port: 0, spawn: false }).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure._tag).toBe("DaemonUnavailable")
  expect(await info(dir)).toBeNull()
})

test("a corrupted runtime record can be replaced", async () => {
  const dir = home()
  writeFileSync((await pathsOf(dir)).daemon, "{broken")
  const started = await start(dir)
  expect(await info(dir)).toEqual(started)
  await runClient(stopDaemon(dir))
})

test("idle shutdown removes the runtime record", async () => {
  const dir = home()
  const started = await start(dir, { DO_IT_IDLE_MS: "250" })
  await eventually(async () => await info(dir) === null)
  await expect(fetch(`${started.baseUrl}/health`)).rejects.toBeDefined()
}, 10000)

test("an open stream prevents idle exit and releasing it allows shutdown", async () => {
  const dir = home()
  const path = join(dir, "watched.md")
  writeFileSync(path, "watch me\n")
  const started = await start(dir, { DO_IT_IDLE_MS: "250" })
  await Effect.runPromise(Effect.scoped(withClient(started, client => Effect.gen(function* () {
    const pull = yield* Stream.toPull(client.watch({ path, text: false }))
    expect((yield* pull)[0]._tag).toBe("Watching")
    yield* Effect.sleep(650)
    expect((yield* client.status({})).documents).toContainEqual({ path, version: 1, watchers: 1 })
  }))))
  await eventually(async () => await info(dir) === null)
}, 10000)

test("stop replies and shuts down even with an open watch stream", async () => {
  const dir = home()
  const path = join(dir, "watched.md")
  writeFileSync(path, "watch me\n")
  const started = await start(dir)
  await Effect.runPromise(Effect.scoped(withClient(started, client => Effect.gen(function* () {
    const pull = yield* Stream.toPull(client.watch({ path, text: false }))
    expect((yield* pull)[0]._tag).toBe("Watching")
    expect(yield* client.stop({})).toEqual({})
    yield* Effect.promise(() => eventually(async () => await info(dir) === null))
  }))).pipe(Effect.timeout(5000)))
  await expect(fetch(`${started.baseUrl}/health`)).rejects.toBeDefined()
}, 10000)

test("stop falls back to SIGTERM when RPC authentication fails", async () => {
  const dir = home()
  await start(dir)
  writeFileSync((await pathsOf(dir)).token, "0".repeat(64))
  expect(await runClient(stopDaemon(dir))).toBe(true)
  await eventually(async () => await info(dir) === null)
}, 10000)

test("SIGTERM and SIGINT perform graceful cleanup and exit zero", async () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const dir = home()
    const child = Bun.spawn([process.execPath, "packages/server/src/main.ts"], {
      env: { ...process.env, DO_IT_HOME: dir, DO_IT_PORT: "0" }, stdout: "ignore", stderr: "pipe",
    })
    pids.add(child.pid)
    await eventually(async () => await info(dir) !== null)
    child.kill(signal)
    expect(await child.exited).toBe(0)
    expect(await info(dir)).toBeNull()
  }
}, 15000)
