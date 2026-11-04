import { APP_VERSION } from "@do-it/protocol"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const MAX_BODY = 4 * 1024 * 1024
export const TEMPLATE = "# TODO\n\nAdd one task per line. Agents pick up new lines, plan them, and write their status underneath.\n\n## Tasks\n\n- [ ] \n"

export interface ServerConfig { home: string; port: number; idleMs: number; webDist: string }
export function config(env: Record<string, string | undefined> = process.env): ServerConfig {
  const port = Number(env.DO_IT_PORT ?? 47100)
  const idleMs = Number(env.DO_IT_IDLE_MS ?? 30 * 60 * 1000)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("DO_IT_PORT must be between 0 and 65535")
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("DO_IT_IDLE_MS must be positive")
  return { home: resolve(env.DO_IT_HOME ?? join(homedir(), ".do-it")), port, idleMs,
    webDist: resolve(env.DO_IT_WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url))) }
}
export { APP_VERSION }
