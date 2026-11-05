import { Effect, Stdio, Stream } from "effect"

const MAX_STDIN = 2 * 1024 * 1024

export const readStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const chunks: Uint8Array[] = []
  let total = 0
  yield* Stream.runForEach(stdio.stdin, chunk => {
    total += chunk.byteLength
    if (total > MAX_STDIN) return Effect.fail(new Error("Standard input exceeds 2 MiB"))
    chunks.push(chunk)
    return Effect.void
  })
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  // Keep a leading byte order mark: the text is passed on unchanged.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
})

export function resolveText(text: string) { return text === "-" ? readStdin : Effect.succeed(text) }
