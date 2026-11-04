import type { Edit } from "./edit"
import { lines } from "./markdown"
import type { TaskState, Todo } from "./todo"

export type StampTag = "started" | "done" | "cancelled"

const stampNames = "started|done|cancelled"

function stampPattern(tag?: StampTag): RegExp {
  const name = tag ?? stampNames
  return new RegExp(`(?:^|[ \\t]+)@(?:${name})(?![A-Za-z0-9_])(?:[ \\t]*\\([^()\\r\\n]*\\))?`, "g")
}

function removeStamp(label: string, tag: StampTag): string {
  return label.replace(stampPattern(tag), "")
}

function hasStamp(label: string, tag: StampTag): boolean {
  return stampPattern(tag).test(label)
}

function taskLabel(text: string, todo: Todo): { from: number; to: number; body: string } | null {
  const line = lines(text)[todo.line]
  if (!line || line.state === undefined) return null
  return { from: line.content, to: line.to, body: text.slice(line.content, line.to) }
}

function stampText(label: string, stamp: string): string {
  const trailing = /[ \t]*$/.exec(label)!
  const core = label.slice(0, trailing.index)
  const project = /[ \t]+@project(?:[ \t]*\([^()\r\n]*\))?$/.exec(core)
  const beforeProject = project ? core.slice(0, project.index) : core
  const prefix = beforeProject.trimEnd()
  const withStamp = prefix ? `${prefix} ${stamp}` : stamp
  return `${withStamp}${project?.[0] ?? ""}${trailing[0]}`
}

function labelEdit(text: string, todo: Todo, make: (label: string) => string): Edit[] {
  const target = taskLabel(text, todo)
  if (!target) return []
  const insert = make(target.body)
  return insert === target.body ? [] : [{ from: target.from, to: target.to, insert }]
}

function stampTextFor(tag: StampTag, date: Date): string {
  const formatted = formatStamp(date)
  return tag === "started" ? `@${tag}(${formatted})` : `@${tag} (${formatted})`
}

function checkboxEdit(text: string, todo: Todo, state: TaskState): Edit[] {
  const line = lines(text)[todo.line]
  if (!line || line.checkbox === undefined || line.state === state) return []
  const insert = state === "done" ? "[x]" : state === "cancelled" ? "[-]" : "[ ]"
  return [{ from: line.checkbox, to: line.checkbox + 3, insert }]
}

export function formatStamp(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0")
  return `${two(date.getFullYear() % 100)}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function stampTodo(text: string, todo: Todo, tag: StampTag, date: Date): Edit[] {
  const stamp = stampTextFor(tag, date)
  return labelEdit(text, todo, label => stampText(removeStamp(label, tag), stamp))
}

export function unstampTodo(text: string, todo: Todo, tag: StampTag): Edit[] {
  return labelEdit(text, todo, label => removeStamp(label, tag))
}

export function setTodoStateStamped(text: string, todo: Todo, state: TaskState, date: Date): Edit[] {
  const currentState = lines(text)[todo.line]?.state
  const edits = checkboxEdit(text, todo, state)
  const tag = state === "done" ? "done" : state === "cancelled" ? "cancelled" : null
  const labelEdits = labelEdit(text, todo, label => {
    let next = label
    if (state === "done") next = removeStamp(next, "cancelled")
    else if (state === "cancelled") next = removeStamp(next, "done")
    else next = removeStamp(removeStamp(next, "done"), "cancelled")
    if (tag && (currentState !== state || !hasStamp(next, tag))) {
      next = stampText(removeStamp(next, tag), stampTextFor(tag, date))
    }
    return next
  })
  return [...edits, ...labelEdits].sort((a, b) => a.from - b.from || a.to - b.to)
}

/** The label without PlainTasks stamp tags (@started, @done, @cancelled with or without dates). */
export function withoutStamps(label: string): string {
  return label.replace(stampPattern(), "").trim()
}
