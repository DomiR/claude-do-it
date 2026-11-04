import { MAX_ITEM } from "./constants"
import { applyEdits, type Edit } from "./edit"
import { DocError } from "./errors"
import { blockEnd, lines } from "./markdown"
import { findSection } from "./section"

export type TaskState = "open" | "done" | "cancelled"
export interface Todo {
  number: number
  line: number
  state: TaskState
  text: string
  indent: number
  section: string | null
}

export function todos(text: string): Todo[] {
  const result: Todo[] = []
  let section: string | null = null
  for (const [index, line] of lines(text).entries()) {
    // Like Herdr, this is the nearest heading's text, including deep headings.
    if (line.kind === "heading") section = text.slice(line.content, line.to).trim()
    if (line.state === undefined) continue
    result.push({ number: result.length + 1, line: index, state: line.state,
      text: text.slice(line.content, line.to).trim(), indent: line.depth, section })
  }
  return result
}

export function findTodo(text: string, query: number | string, section?: string): Todo {
  const scope = section === undefined ? null : findSection(text, section)
  const allLines = scope ? lines(text) : null
  const candidates = todos(text).filter(todo => !scope
    || (allLines![todo.line]!.from >= scope.from && allLines![todo.line]!.from < scope.to))
  const needle = String(query).trim().toLowerCase()
  let matches: Todo[]
  if (typeof query === "number" || /^\+?\d+$/.test(needle)) {
    matches = candidates.filter(todo => todo.number === Number(needle))
  } else {
    matches = candidates.filter(todo => todo.text.toLowerCase() === needle)
    if (!matches.length && needle) matches = candidates.filter(todo => todo.text.toLowerCase().includes(needle))
  }
  if (!matches.length) throw new DocError({ code: "not-found", message: `No todo matches ${JSON.stringify(query)}` })
  if (matches.length > 1) throw new DocError({ code: "ambiguous", message: `${matches.length} todos match ${JSON.stringify(query)}, name one by its number` })
  return matches[0]!
}

export function setTodoState(text: string, todo: Todo, state: TaskState): Edit[] {
  const line = lines(text)[todo.line]
  if (!line || line.checkbox === undefined || line.state === state) return []
  const insert = state === "done" ? "[x]" : state === "cancelled" ? "[-]" : "[ ]"
  return [{ from: line.checkbox, to: line.checkbox + 3, insert }]
}

function checked(text: string, edit: Edit): Edit[] {
  applyEdits(text, [edit])
  return [edit]
}

export function addTodo(text: string, item: string, section?: string): Edit[] {
  item = item.trim()
  if ([...item].length > MAX_ITEM) {
    throw new DocError({ code: "too-large", message: `A todo may have at most ${MAX_ITEM} characters` })
  }
  if (!item || /[\r\n]/.test(item)) {
    throw new DocError({ code: "invalid", message: "A todo must be one nonempty line of text" })
  }
  const scope = section === undefined ? null : findSection(text, section)
  const all = lines(text)
  let last = -1
  for (const [index, line] of all.entries()) {
    if (line.state !== undefined && (!scope || (line.from >= scope.from && line.from < scope.to))) last = index
  }
  const task = `- [ ] ${item}`
  if (last === -1) return appendBlock(text, task, section)
  const line = all[last]!
  const end = all[blockEnd(all, last) - 1]!.to
  const indent = text.slice(line.from, line.from + line.indent)
  return checked(text, { from: end, to: end, insert: `\n${indent}${task}` })
}

function append(text: string, block: string): Edit {
  const trimmed = text.replace(/[\r\n]+$/, "")
  const last = lines(trimmed).at(-1)
  const separator = !trimmed ? "" : last?.kind === "item" && block.startsWith("- ") ? "\n" : "\n\n"
  return { from: trimmed.length, to: text.length, insert: `${separator}${block}\n` }
}

export function appendBlock(text: string, block: string, section?: string): Edit[] {
  block = block.replace(/[\r\n]+$/, "")
  if (!block.trim()) throw new DocError({ code: "invalid", message: "There is no text to add" })
  if (section === undefined) return checked(text, append(text, block))
  const scope = findSection(text, section)
  const body = text.slice(scope.from, scope.to)
  const content = body.replace(/[\r\n]+$/, "")
  const edit = append(content, block)
  return checked(text, {
    from: scope.from + edit.from,
    to: scope.from + edit.to,
    insert: content.length === body.length ? edit.insert : edit.insert.replace(/\n+$/, ""),
  })
}

export function replaceUnique(text: string, old: string, next: string, section?: string): Edit[] {
  if (!old) throw new DocError({ code: "invalid", message: "Text to replace must not be empty" })
  const scope = section === undefined ? { from: 0, to: text.length } : findSection(text, section)
  const body = text.slice(scope.from, scope.to)
  const at = body.indexOf(old)
  if (at === -1) throw new DocError({ code: "not-found", message: "The text to replace is not in the document" })
  // Rust match_indices, like replaceAll, counts nonoverlapping occurrences.
  if (body.indexOf(old, at + old.length) !== -1) {
    throw new DocError({ code: "ambiguous", message: "Several places match the text to replace, include more of it so one does" })
  }
  return checked(text, { from: scope.from + at, to: scope.from + at + old.length, insert: next })
}
