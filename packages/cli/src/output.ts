import { describeAuthor, exitCodeFor, formatTodoChange, formatVersionHeader } from "@do-it/protocol"
import type { Author, Change, EditSuccess, RpcFailure, TodoChange } from "@do-it/protocol"
import { Console, Effect } from "effect"
/** Writes `text` and one line break. A text that already ends in a line break gets no second one. */
export function writeLine(text = ""): Effect.Effect<void> { return Console.log(text.endsWith("\n") ? text.slice(0, -1) : text) }
export function writeJson(value: unknown): Effect.Effect<void> { return writeLine(JSON.stringify(value)) }
export function diffText(header: string, diff: string | null): string { return diff ? `${header}\n${diff}` : header }
export function editReply(result: EditSuccess): { text: string; json: Record<string, unknown> } {
  if (!result.changed) return { text: `Unchanged. Version: ${result.version}`, json: { kind: "unchanged", version: result.version, section: result.section, others: result.others, diff: result.others?.diff ?? null } }
  if (result.section && result.others) { const header = `Updated section "${result.section}". Version: ${result.version}. Other sections changed since ${result.others.since}:`; return { text: diffText(header, result.others.diff), json: { kind: "updated-section", version: result.version, section: result.section, others: result.others, diff: result.others.diff } } }
  return { text: `Updated. Version: ${result.version}`, json: { kind: "updated", version: result.version, section: result.section, others: result.others, diff: result.others?.diff ?? null } }
}
function field(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null && key in error ? (error as Record<string, unknown>)[key] : undefined
}
export function mismatchReply(error: unknown, requested: number): { text: string; json: Record<string, unknown> } {
  const latest = typeof field(error, "latest") === "number" ? field(error, "latest") as number : requested
  const forgotten = field(error, "forgotten") === true || field(error, "_tag") === "Forgotten"
  if (forgotten) { const text = `Version mismatch, nothing changed. Latest version: ${latest}. Version ${requested} is no longer kept: run do-it read`; return { text, json: { kind: "version-mismatch", latest, since: requested, diff: null, forgotten: true } }
  }
  const since = typeof field(error, "since") === "number" ? field(error, "since") as number : requested
  const diff = typeof field(error, "diff") === "string" ? field(error, "diff") as string : null
  const header = `Version mismatch, nothing changed. Latest version: ${latest}. Changes since ${since}:`; return { text: diffText(header, diff), json: { kind: "version-mismatch", latest, since, diff, forgotten: false } }
}
export function changeReply(change: Change, todosOnly: boolean): string { return todosOnly ? change.todos.map(formatTodoChange).join("\n") : diffText(formatVersionHeader(change.from, change.to, change.by), change.diff) }
export function changeJson(change: Change): Record<string, unknown> { return { event: "change", from: change.from, to: change.to, by: change.by, diff: change.diff, todos: change.todos } }
export function todosText(changes: ReadonlyArray<TodoChange>): string { return changes.map(formatTodoChange).join("\n") }
export function rpcErrorCode(error: unknown): string { const tag = field(error, "_tag"); return typeof tag === "string" ? tag : "RpcClientError" }
function isRpcFailure(error: unknown): error is RpcFailure {
  const tag = field(error, "_tag")
  return typeof tag === "string" && ["VersionMismatch", "Refused", "Forgotten", "NothingYet", "DocumentGone", "Unauthorized"].includes(tag)
}
export function rpcExitCode(error: unknown): number { return isRpcFailure(error) ? exitCodeFor(error) : 3 }
export function errorMessage(error: unknown): string {
  const errors = field(error, "errors")
  if (Array.isArray(errors) && errors.length > 0) return errors.map(errorMessage).join("\n")
  const message = field(error, "message")
  return typeof message === "string" ? message : String(error)
}
export function errorTag(error: unknown): string | undefined { const tag = field(error, "_tag"); return typeof tag === "string" ? tag : undefined }
export function errorFields(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {}
  return Object.fromEntries(Object.entries(error).filter(([key]) => key !== "_tag" && key !== "message" && key !== "code"))
}
export { describeAuthor }
