import { Deferred, Effect, Fiber, FileSystem, Path, Stream } from "effect"

/**
 * Runs `changed` shortly after the file at `path` changes, and every two
 * seconds as a fallback for file systems that do not report changes. Both
 * stop when the enclosing scope closes.
 */
export const watchFile = Effect.fn("watchFile")(function* (path: string, changed: Effect.Effect<void>) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const name = paths.basename(path)
  const ready = yield* Deferred.make<void>()
  const events = yield* fs.watch(paths.dirname(path), { onReady: () => Deferred.doneUnsafe(ready, Effect.void) }).pipe(
    Stream.filter(event => paths.basename(event.path) === name),
    Stream.debounce("50 millis"),
    Stream.runForEach(() => changed),
    // The stamp poll below also covers a watcher that fails or cannot start.
    Effect.ignore,
    Effect.forkScoped,
  )
  yield* changed.pipe(Effect.delay("2 seconds"), Effect.forever, Effect.forkScoped)
  // Changes made right after opening must not be missed while the watcher starts.
  yield* Effect.race(Deferred.await(ready), Fiber.await(events))
})
