import { Data, Effect, FileSystem, Path } from "effect"
import { paths } from "./paths"

export interface DaemonInfo {
  home: string
  pid: number
  port: number
  token: string
  appVersion: string
  startedAt: number
  baseUrl: string
}

export class DaemonUnavailable extends Data.TaggedError("DaemonUnavailable")<{
  readonly message: string
}> {}

export function readDaemonInfo(home?: string): Effect.Effect<DaemonInfo | null, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const p = yield* paths(home)
    if ((yield* fs.stat(p.daemon)).size > 4096n || (yield* fs.stat(p.token)).size > 128n) return null
    const text = yield* fs.readFileString(p.daemon)
    const token = (yield* fs.readFileString(p.token)).trim()
    const record = yield* Effect.try(() => JSON.parse(text) as Record<string, unknown> | null)
    if (!record || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || !Number.isInteger(record.port)
      || (record.port as number) < 1 || (record.port as number) > 65535 || typeof record.appVersion !== "string"
      || !Number.isFinite(record.startedAt) || !/^[a-f0-9]{64}$/.test(token)) return null
    const port = record.port as number
    return { home: p.home, pid: record.pid as number, port, appVersion: record.appVersion,
      startedAt: record.startedAt as number, token, baseUrl: `http://127.0.0.1:${port}` }
  }).pipe(Effect.catch(() => Effect.succeed(null)))
}

/** Signal 0 checks that a process exists. EPERM means it exists but belongs to someone else. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as { code?: unknown }).code === "EPERM" }
}

export interface Health {
  ok: true
  pid: number
  appVersion: string
}

/**
 * Asks the daemon for `/health` with a 500 ms timeout. "slow" means no answer
 * in time, which a busy machine can cause. null means a refused connection
 * or a wrong answer, so the daemon cannot be used.
 */
export const checkHealth = (info: DaemonInfo): Effect.Effect<Health | "slow" | null> => Effect.promise(async (signal) => {
  const timeout = AbortSignal.timeout(500)
  try {
    const response = await fetch(`${info.baseUrl}/health`, { signal: AbortSignal.any([signal, timeout]) })
    if (!response.ok) return null
    const body = await response.json() as { ok?: unknown; pid?: unknown; appVersion?: unknown }
    return body.ok === true && body.pid === info.pid && typeof body.appVersion === "string"
      ? { ok: true, pid: info.pid, appVersion: body.appVersion } : null
  } catch {
    return timeout.aborted ? "slow" : null
  }
})

export const probeHealth = (info: DaemonInfo) => checkHealth(info).pipe(Effect.map(health => health === "slow" ? null : health))
