import { APP_VERSION } from "@do-it/protocol"
import { spawn } from "node:child_process"
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { alive, DaemonUnavailable, probeHealth, readDaemonInfo, type DaemonInfo } from "./info"
import { paths } from "./paths"
import { withClient } from "./rpc"

const unavailable = (cause: unknown) => cause instanceof DaemonUnavailable ? cause
  : new DaemonUnavailable({ message: cause instanceof Error ? cause.message : String(cause) })
const attempt = <A>(f: () => A) => Effect.try({ try: f, catch: unavailable })

export const stopDaemon = Effect.fn("stopDaemon")(function* (home?: string) {
  const info = readDaemonInfo(home)
  if (!info || !alive(info.pid)) return false
  const stopped = yield* withClient(info, client => client.stop({})).pipe(
    Effect.timeout("500 millis"), Effect.map(() => true), Effect.catch(() => Effect.succeed(false)),
  )
  if (!stopped) {
    const signalled = yield* attempt(() => { if (info.pid !== process.pid && alive(info.pid)) process.kill(info.pid, "SIGTERM") }).pipe(Effect.result)
    if (signalled._tag === "Failure") return false
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!(yield* probeHealth(info))) return true
    yield* Effect.sleep("50 millis")
  }
  return false
})

export interface EnsureOptions {
  home?: string
  port?: number
  env?: Record<string, string>
  spawn?: boolean
}

export const ensureDaemon = Effect.fn("ensureDaemon")(function* (options: EnsureOptions = {}) {
  const p = paths(options.home ?? options.env?.DO_IT_HOME)
  function compatible() {
    return Effect.gen(function* () {
      const info = readDaemonInfo(p.home)
      if (!info || !alive(info.pid)) return null
      const health = yield* probeHealth(info)
      return health && health.appVersion === APP_VERSION && info.appVersion === APP_VERSION ? info : null
    })
  }
  const existing = yield* compatible()
  if (existing) return existing
  if (options.spawn === false) return yield* Effect.fail(new DaemonUnavailable({ message: "No compatible daemon is running" }))
  yield* attempt(() => { mkdirSync(p.home, { recursive: true, mode: 0o700 }); chmodSync(p.home, 0o700) })
  let inode: number | undefined
  const lockDeadline = Date.now() + 12_000
  while (inode === undefined) {
    inode = yield* attempt(() => {
      try {
        mkdirSync(p.lock, { mode: 0o700 })
        writeFileSync(p.lockPid, String(process.pid), { mode: 0o600 })
        return statSync(p.lock).ino
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        try {
          const stat = statSync(p.lock)
          let pid = 0
          try { pid = Number(readFileSync(p.lockPid, "utf8")) } catch { /* A creator may still be writing its pid. */ }
          if ((pid > 0 && !alive(pid)) || Date.now() - stat.mtimeMs > 10_000) rmSync(p.lock, { recursive: true, force: true })
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
        return undefined
      }
    })
    if (inode !== undefined) break
    if (Date.now() > lockDeadline) return yield* Effect.fail(new DaemonUnavailable({ message: "Timed out waiting for the daemon startup lock" }))
    yield* Effect.sleep("50 millis")
  }
  let startingPid: number | undefined
  const run = Effect.gen(function* () {
    const found = yield* compatible()
    if (found) return found
    const old = readDaemonInfo(p.home)
    if (old && alive(old.pid) && !(yield* stopDaemon(p.home))) {
      return yield* Effect.fail(new DaemonUnavailable({ message: "The previous daemon could not be stopped" }))
    }
    const child = yield* attempt(() => {
      try { if (statSync(p.log).size >= 1024 * 1024) renameSync(p.log, `${p.log}.old`) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      const fd = openSync(p.log, "a", 0o600)
      try {
        const env: Record<string, string | undefined> = { ...process.env, ...options.env, DO_IT_HOME: p.home }
        if (options.port !== undefined) env.DO_IT_PORT = String(options.port)
        const child = spawn(process.execPath, [fileURLToPath(new URL("../../server/src/main.ts", import.meta.url))], {
          detached: true, stdio: ["ignore", fd, fd], env,
        })
        startingPid = child.pid
        child.unref()
        return child
      } finally { closeSync(fd) }
    })
    let spawnError: Error | undefined
    child.on("error", error => { spawnError = error })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (spawnError) return yield* Effect.fail(unavailable(spawnError))
      const info = yield* compatible()
      if (info) { startingPid = undefined; return info }
      if (child.exitCode !== null) break
      yield* Effect.sleep("50 millis")
    }
    return yield* Effect.fail(new DaemonUnavailable({ message: `The daemon did not start, see ${p.log}` }))
  })
  return yield* run.pipe(Effect.onError(() => Effect.sync(() => {
    if (startingPid && alive(startingPid)) { try { process.kill(startingPid, "SIGTERM") } catch { /* Already exited. */ } }
  })), Effect.ensuring(Effect.sync(() => {
    try { if (statSync(p.lock).ino === inode) rmSync(p.lock, { recursive: true, force: true }) } catch { /* Already released. */ }
  })))
})
