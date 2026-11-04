import { readFileSync, statSync } from "node:fs"
import { Data, Effect } from "effect"
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

export function readDaemonInfo(home?: string): DaemonInfo | null {
  const p = paths(home)
  try {
    if (statSync(p.daemon).size > 4096 || statSync(p.token).size > 128) return null
    const record = JSON.parse(readFileSync(p.daemon, "utf8"))
    const token = readFileSync(p.token, "utf8").trim()
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !Number.isInteger(record.port)
      || record.port < 1 || record.port > 65535 || typeof record.appVersion !== "string"
      || !Number.isFinite(record.startedAt) || !/^[a-f0-9]{64}$/.test(token)) return null
    return { home: p.home, pid: record.pid, port: record.port, appVersion: record.appVersion,
      startedAt: record.startedAt, token, baseUrl: `http://127.0.0.1:${record.port}` }
  } catch { return null }
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

export const probeHealth = (info: DaemonInfo) => Effect.tryPromise({
  try: async (signal) => {
    const response = await fetch(`${info.baseUrl}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(500)]) })
    if (!response.ok) return null
    const body = await response.json() as { ok?: boolean; pid?: number; appVersion?: string }
    return body.ok === true && body.pid === info.pid && typeof body.appVersion === "string" ? body : null
  },
  catch: () => new DaemonUnavailable({ message: "The daemon did not answer its health check" }),
}).pipe(Effect.catch(() => Effect.succeed(null)))
