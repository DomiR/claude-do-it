/** Document metadata shared with the pure text API, without CRDT dependencies. */
export type Version = number
export type Origin =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly name: string }
  | { readonly kind: "file" }

export interface Conflict {
  readonly expected: Version
  readonly current: Version
  readonly diff: string | null
  readonly forgotten: boolean
}
