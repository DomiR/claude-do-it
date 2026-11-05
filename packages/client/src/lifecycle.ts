import { APP_VERSION } from "@do-it/protocol"
import { Effect, FileSystem, Option, Path, PlatformError, Semaphore } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { alive, DaemonUnavailable, probeHealth, readDaemonInfo } from "./info"
import { paths } from "./paths"
import { withClient } from "./rpc"

const unavailable = (cause: unknown) => cause instanceof DaemonUnavailable ? cause
  : new DaemonUnavailable({ message: cause instanceof Error ? cause.message : String(cause) })
const attempt = <A>(f: () => A) => Effect.try({ try: f, catch: unavailable })

/** Recovers from one platform error reason, such as a file that does not exist. */
function unless<B>(reason: PlatformError.SystemErrorTag, fallback: B) {
  return <A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>): Effect.Effect<A | B, PlatformError.PlatformError, R> =>
    Effect.catch(effect, error => error.reason._tag === reason ? Effect.succeed(fallback) : Effect.fail(error))
}

/**
 * Each lock attempt checks and then acts on the lock directory. Callers in one
 * process take turns, so one never removes a lock another has just created.
 */
const lockTurn = Semaphore.makeUnsafe(1)

/** `exec` keeps the shell's pid for the daemon, and the redirection sends its output to the log. */
const daemonScript = 'exec "$0" "$1" >>"$2" 2>&1'

export const stopDaemon = Effect.fn("stopDaemon")(function* (home?: string) {
  const info = yield* readDaemonInfo(home)
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
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const p = yield* paths(options.home ?? options.env?.DO_IT_HOME)
  const compatible = Effect.gen(function* () {
    const info = yield* readDaemonInfo(p.home)
    if (!info || !alive(info.pid)) return null
    const health = yield* probeHealth(info)
    return health && health.appVersion === APP_VERSION && info.appVersion === APP_VERSION ? info : null
  })
  const existing = yield* compatible
  if (existing) return existing
  if (options.spawn === false) return yield* Effect.fail(new DaemonUnavailable({ message: "No compatible daemon is running" }))
  yield* fs.makeDirectory(p.home, { recursive: true, mode: 0o700 }).pipe(Effect.andThen(fs.chmod(p.home, 0o700)), Effect.mapError(unavailable))

  // The startup lock is a directory, so creating it is atomic. It holds the
  // owner's pid; a lock without a readable pid is abandoned after 10 seconds.
  const lockOnce = Effect.gen(function* () {
    const created = yield* fs.makeDirectory(p.lock, { mode: 0o700 }).pipe(Effect.as(true), unless("AlreadyExists", false))
    if (created) {
      yield* fs.writeFileString(p.lockPid, String(process.pid), { mode: 0o600 })
      return Option.getOrNull((yield* fs.stat(p.lock)).ino)
    }
    const stat = yield* fs.stat(p.lock).pipe(unless("NotFound", undefined))
    if (!stat) return undefined
    const text = yield* fs.readFileString(p.lockPid).pipe(unless("NotFound", undefined))
    const pid = text === undefined ? undefined : Number(text)
    const modified = Option.match(stat.mtime, { onNone: () => 0, onSome: date => date.getTime() })
    const abandoned = pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? !alive(pid) : Date.now() - modified > 10_000
    if (abandoned) yield* fs.remove(p.lock, { recursive: true, force: true })
    return undefined
  }).pipe(lockTurn.withPermit, Effect.mapError(unavailable))
  let inode: bigint | null | undefined
  const lockDeadline = Date.now() + 12_000
  while (inode === undefined) {
    inode = yield* lockOnce
    if (inode !== undefined) break
    if (Date.now() > lockDeadline) return yield* Effect.fail(new DaemonUnavailable({ message: "Timed out waiting for the daemon startup lock" }))
    yield* Effect.sleep("50 millis")
  }
  const held = inode
  const release = fs.stat(p.lock).pipe(
    Effect.flatMap(stat => Option.getOrNull(stat.ino) === held ? fs.remove(p.lock, { recursive: true, force: true }) : Effect.void),
    lockTurn.withPermit,
    Effect.ignore,
  )

  const start = Effect.gen(function* () {
    const found = yield* compatible
    if (found) return found
    const old = yield* readDaemonInfo(p.home)
    if (old && alive(old.pid) && !(yield* stopDaemon(p.home))) {
      return yield* Effect.fail(new DaemonUnavailable({ message: "The previous daemon could not be stopped" }))
    }
    const size = yield* fs.stat(p.log).pipe(Effect.map(stat => stat.size), unless("NotFound", 0n), Effect.mapError(unavailable))
    if (size >= 1024n * 1024n) yield* fs.rename(p.log, `${p.log}.old`).pipe(Effect.mapError(unavailable))
    yield* fs.writeFileString(p.log, "", { flag: "a", mode: 0o600 }).pipe(Effect.mapError(unavailable))
    const main = yield* path.fromFileUrl(new URL("../../server/src/main.ts", import.meta.url)).pipe(Effect.mapError(unavailable))
    const env: Record<string, string> = { ...options.env, DO_IT_HOME: p.home }
    if (options.port !== undefined) env.DO_IT_PORT = String(options.port)
    const command = ChildProcess.make("/bin/sh", ["-c", daemonScript, process.execPath, main, p.log], {
      detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", env, extendEnv: true,
    })
    const child = yield* spawner.spawn(command).pipe(Effect.mapError(unavailable))
    // An unreferenced child outlives this scope and this process.
    yield* child.unref.pipe(Effect.mapError(unavailable))
    const wait = Effect.gen(function* () {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const info = yield* compatible
        if (info) return info
        if (!(yield* child.isRunning.pipe(Effect.mapError(unavailable)))) break
        yield* Effect.sleep("50 millis")
      }
      return yield* Effect.fail(new DaemonUnavailable({ message: `The daemon did not start, see ${p.log}` }))
    })
    return yield* wait.pipe(Effect.onError(() => child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore)))
  })
  return yield* Effect.scoped(start).pipe(Effect.ensuring(release))
})
