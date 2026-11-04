import { diffArrays, diffChars } from "diff"
import { withoutStamps } from "./stamp"
import { todos, type TaskState, type Todo } from "./todo"

export type TodoChangeKind = "added" | "removed" | "checked" | "unchecked" | "cancelled" | "uncancelled" | "edited"
export interface TodoChange {
  kind: TodoChangeKind
  number: number
  text: string
  line: number
  oldLine: number
}

function change(kind: TodoChangeKind, now: Todo, before = now): TodoChange {
  return { kind, number: now.number, text: withoutStamps(now.text), line: now.line, oldLine: before.line }
}

function stateChange(before: TaskState, now: TaskState): TodoChangeKind | null {
  if (before === now) return null
  if (now === "done") return "checked"
  if (now === "cancelled") return "cancelled"
  return before === "done" ? "unchecked" : "uncancelled"
}

function similarity(a: string, b: string): number {
  const length = [...a].length + [...b].length
  if (!length) return 1
  const equal = diffChars(a, b).reduce((n, part) => n + (part.added || part.removed ? 0 : part.count), 0)
  return 2 * equal / length
}

/** Port of Herdr's ordered task matching and best similar replacement pairing. */
export function todoChanges(old: string, next: string): TodoChange[] {
  const before = todos(old)
  const after = todos(next)
  const parts = diffArrays(before.map(todo => withoutStamps(todo.text)), after.map(todo => withoutStamps(todo.text)))
  const result: TodoChange[] = []
  let oldAt = 0
  let newAt = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (!part.added && !part.removed) {
      for (let k = 0; k < part.count; k++) {
        const was = before[oldAt++]!
        const now = after[newAt++]!
        const kind = stateChange(was.state, now.state)
        if (kind) result.push(change(kind, now, was))
      }
      continue
    }
    const olds: Todo[] = []
    const news: Todo[] = []
    // Adjacent insert/delete runs form one replacement, as similar::DiffOp does.
    while (i < parts.length && (parts[i]!.added || parts[i]!.removed)) {
      const run = parts[i]!
      if (run.removed) {
        olds.push(...before.slice(oldAt, oldAt + run.count))
        oldAt += run.count
      } else {
        news.push(...after.slice(newAt, newAt + run.count))
        newAt += run.count
      }
      i++
    }
    i--
    const taken = new Set<number>()
    for (const now of news) {
      let best = -1
      let score = 0.5
      for (const [k, was] of olds.entries()) {
        if (taken.has(k)) continue
        const candidate = similarity(was.text, now.text)
        // Rust max_by selects the last candidate on a tie.
        if (candidate >= score) { best = k; score = candidate }
      }
      if (best === -1) result.push(change("added", now))
      else { taken.add(best); result.push(change("edited", now, olds[best]!)) }
    }
    for (const [k, was] of olds.entries()) {
      if (!taken.has(k)) result.push(change("removed", was))
    }
  }
  return result
}

export function formatTodoChange(change: TodoChange): string {
  return `${change.kind} ${change.number}. ${change.text}`
}
