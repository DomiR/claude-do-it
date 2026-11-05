import { APP_VERSION } from "@do-it/protocol"
import { Config, Data, Effect, Option, Path } from "effect"

export const MAX_BODY = 4 * 1024 * 1024
export const TEMPLATE = "# TODO\n\nAdd one task per line. Agents pick up new lines, plan them, and write their status underneath.\n\n## Tasks\n\n- [ ] \n"

export class InvalidConfig extends Data.TaggedError("InvalidConfig")<{ readonly message: string }> {}

export interface ServerConfig { home: string; port: number; idleMs: number; webDist: string }

/** Set by the npm build, which ships the web app next to the daemon. */
declare const DO_IT_WEB_ROOT: string | undefined
const webRoot = new URL(typeof DO_IT_WEB_ROOT === "string" ? DO_IT_WEB_ROOT : "../../web/dist", import.meta.url)

const optional = (name: string) => Config.option(Config.String(name)).pipe(Effect.map(Option.getOrUndefined))

/** Reads DO_IT_HOME, DO_IT_PORT, DO_IT_IDLE_MS, and DO_IT_WEB_DIST. */
export const config = Effect.gen(function* () {
  const path = yield* Path.Path
  const port = Number((yield* optional("DO_IT_PORT")) ?? 47100)
  const idleMs = Number((yield* optional("DO_IT_IDLE_MS")) ?? 30 * 60 * 1000)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return yield* Effect.fail(new InvalidConfig({ message: "DO_IT_PORT must be between 0 and 65535" }))
  if (!Number.isFinite(idleMs) || idleMs <= 0) return yield* Effect.fail(new InvalidConfig({ message: "DO_IT_IDLE_MS must be positive" }))
  const home = (yield* optional("DO_IT_HOME")) ?? path.join(yield* Config.String("HOME"), ".do-it")
  const webDist = (yield* optional("DO_IT_WEB_DIST")) ?? (yield* path.fromFileUrl(webRoot))
  return { home: path.resolve(home), port, idleMs, webDist: path.resolve(webDist) } satisfies ServerConfig
})
export { APP_VERSION }
