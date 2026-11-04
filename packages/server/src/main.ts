import { BunRuntime } from "@effect/platform-bun"
import { Cause, Effect, Exit } from "effect"
import { makeServer } from "./http"

BunRuntime.runMain(Effect.scoped(Effect.gen(function* () {
  const server = yield* makeServer()
  yield* server.stopped
})), { teardown: (exit, done) => done(Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? 1 : 0) })
