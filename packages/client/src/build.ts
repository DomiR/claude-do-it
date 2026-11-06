import { Effect, FileSystem, Path } from "effect"

/** Set by the npm build: one id shared by the CLI and daemon bundles of a build. */
declare const DO_IT_BUILD: string | undefined
const sourceRoot = new URL("../../../", import.meta.url)

/**
 * The build id of the daemon this client starts. It must equal the server's
 * `buildId`: the npm build's id, or `source:` and the real path of this
 * checkout. The lifecycle tests check that the two agree.
 */
export const clientBuild: Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> = typeof DO_IT_BUILD === "string"
  ? Effect.succeed(DO_IT_BUILD)
  : Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return `source:${yield* fs.realPath(path.resolve(yield* path.fromFileUrl(sourceRoot)))}`
  }).pipe(Effect.orDie)
