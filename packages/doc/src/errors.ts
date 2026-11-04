import * as Data from "effect/Data"
import type { Conflict } from "./types"

export class DocError extends Data.TaggedError("DocError")<{
  readonly code: "conflict" | "forgotten" | "not-found" | "ambiguous" | "too-large" | "invalid"
  readonly message: string
  readonly conflict?: Conflict
}> {}
