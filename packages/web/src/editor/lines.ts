import { blockEnd, lines, type Line, type TaskState } from '@do-it/doc/text'

export type LineKind =
  | 'project'
  | 'task'
  | 'status'
  | 'note'
  | 'prose'
  | 'blank'
  | 'code'
  | 'fence'
  | 'quote'
  | 'rule'

export interface Span {
  readonly from: number
  readonly to: number
}

export type InlineKind = 'strong' | 'strongMark' | 'code' | 'codeMark' | 'link'

export interface InlineSpan extends Span {
  readonly kind: InlineKind
}

export interface ClassifiedLine {
  readonly index: number
  readonly from: number
  readonly to: number
  readonly kind: LineKind
  readonly depth: number
  readonly level?: number
  readonly state?: TaskState
  readonly marks?: Span
  readonly bullet?: Span
  readonly checkbox?: Span
  readonly label?: Span
  readonly inline: ReadonlyArray<InlineSpan>
  readonly archived: boolean
  readonly owner?: number
}

export interface Project {
  readonly title: string
  readonly level: number
  readonly line: number
  readonly from: number
}

export interface Stats {
  readonly done: number
  readonly cancelled: number
  readonly open: number
  readonly total: number
}

export interface ClassifiedDocument {
  readonly lines: ReadonlyArray<ClassifiedLine>
  readonly projects: ReadonlyArray<Project>
  readonly stats: Stats
}

interface InlineCandidate {
  readonly from: number
  readonly to: number
  readonly spans: ReadonlyArray<InlineSpan>
}

interface LinkCandidate {
  readonly from: number
  readonly to: number
  readonly target: string
}

type MutableClassifiedLine = {
  -readonly [Key in keyof ClassifiedLine]: ClassifiedLine[Key]
}

const inlineKinds = new Set<LineKind>(['project', 'task', 'status', 'note', 'prose'])

const trimRange = (text: string, from: number, to: number): Span => {
  let start = from
  let end = to
  while (start < end && /\s/.test(text[start]!)) start += 1
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1
  return { from: start, to: end }
}

const trimBareUrlEnd = (value: string): string => {
  let end = value.length
  while (end > 0 && /[.,!?;:]/.test(value[end - 1]!)) end -= 1
  while (end > 0 && value[end - 1] === ')') {
    const opening = value.slice(0, end).split('(').length - 1
    const closing = value.slice(0, end).split(')').length - 1
    if (closing <= opening) break
    end -= 1
  }
  return value.slice(0, end)
}

const linkCandidates = (text: string, from: number, to: number): LinkCandidate[] => {
  const source = text.slice(from, to)
  const result: LinkCandidate[] = []

  const markdown = /\[[^\]\r\n]*\]\(([^()\s]+)\)/g
  for (const match of source.matchAll(markdown)) {
    const value = match[0]!
    const target = match[1]!
    const start = from + match.index!
    result.push({ from: start, to: start + value.length, target })
  }

  const autolink = /<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi
  for (const match of source.matchAll(autolink)) {
    const value = match[0]!
    const target = match[1]!
    const start = from + match.index!
    result.push({ from: start, to: start + value.length, target })
  }

  const bare = /(?:https?:\/\/|mailto:)[^\s<>\[\]]+/gi
  for (const match of source.matchAll(bare)) {
    const raw = match[0]!
    const value = trimBareUrlEnd(raw)
    if (!value) continue
    const start = from + match.index!
    result.push({ from: start, to: start + value.length, target: value })
  }

  return result
}

const inlineCandidates = (text: string, from: number, to: number): InlineCandidate[] => {
  const source = text.slice(from, to)
  const result: InlineCandidate[] = []

  for (const link of linkCandidates(text, from, to)) {
    result.push({ from: link.from, to: link.to, spans: [{ from: link.from, to: link.to, kind: 'link' }] })
  }

  const strong = /\*\*([^\r\n]*?)\*\*/g
  for (const match of source.matchAll(strong)) {
    const value = match[0]!
    const start = from + match.index!
    const markLength = 2
    result.push({
      from: start,
      to: start + value.length,
      spans: [
        { from: start, to: start + markLength, kind: 'strongMark' },
        { from: start + markLength, to: start + value.length - markLength, kind: 'strong' },
        { from: start + value.length - markLength, to: start + value.length, kind: 'strongMark' },
      ],
    })
  }

  const code = /`([^`\r\n]*?)`/g
  for (const match of source.matchAll(code)) {
    const value = match[0]!
    const start = from + match.index!
    result.push({
      from: start,
      to: start + value.length,
      spans: [
        { from: start, to: start + 1, kind: 'codeMark' },
        { from: start + 1, to: start + value.length - 1, kind: 'code' },
        { from: start + value.length - 1, to: start + value.length, kind: 'codeMark' },
      ],
    })
  }

  return result
}

const inlineSpans = (text: string, line: ClassifiedLine): ReadonlyArray<InlineSpan> => {
  if (!inlineKinds.has(line.kind)) return []
  const candidates = inlineCandidates(text, line.from, line.to)
    .sort((left, right) => left.from - right.from || right.to - right.from - (left.to - left.from))
  const accepted: InlineSpan[] = []
  let end = line.from
  for (const candidate of candidates) {
    if (candidate.from < end) continue
    accepted.push(...candidate.spans)
    end = candidate.to
  }
  return accepted.sort((left, right) => left.from - right.from || left.to - right.to)
}

const headingTitleRange = (text: string, line: Line): Span => trimRange(text, line.content, line.to)

const ownerFor = (all: Line[], index: number, taskIndexes: ReadonlyArray<number>): number | undefined => {
  const current = all[index]!
  let owner: number | undefined
  for (const taskIndex of taskIndexes) {
    if (taskIndex >= index) break
    const task = all[taskIndex]!
    if (current.depth <= task.depth) continue
    if (index < blockEnd(all, taskIndex)) owner = taskIndex
  }
  return owner
}

const archivedLines = (all: Line[], text: string): ReadonlySet<number> => {
  const archive = all.findIndex((line) =>
    line.kind === 'heading' &&
    line.level === 2 &&
    line.depth === 0 &&
    text.slice(line.content, line.to).trim() === 'Archive',
  )
  if (archive === -1) return new Set()
  let end = all.length
  for (let index = archive + 1; index < all.length; index += 1) {
    const line = all[index]!
    if (line.kind === 'heading' && (line.level === 1 || line.level === 2)) {
      end = index
      break
    }
  }
  return new Set(Array.from({ length: end - archive }, (_, offset) => archive + offset))
}

export const classifyDocument = (text: string): ClassifiedDocument => {
  const parsed = lines(text)
  const taskIndexes = parsed.flatMap((line, index) => line.state === undefined ? [] : [index])
  const archived = archivedLines(parsed, text)
  const stats: Stats = { done: 0, cancelled: 0, open: 0, total: 0 }
  const projects: Project[] = []

  const classified = parsed.map((line, index): ClassifiedLine => {
    const owner = ownerFor(parsed, index, taskIndexes)
    let kind: LineKind
    if (line.kind === 'heading') kind = 'project'
    else if (line.state !== undefined) kind = 'task'
    else if (line.kind === 'item' && owner !== undefined) kind = 'status'
    else if (line.kind === 'paragraph' && owner !== undefined) kind = 'note'
    else if (line.kind === 'paragraph') kind = 'prose'
    else kind = line.kind

    const result = {
      index,
      from: line.from,
      to: line.to,
      kind,
      depth: line.depth,
      inline: [],
      archived: archived.has(index),
    } as MutableClassifiedLine
    if (line.level !== undefined) result.level = line.level
    if (line.state !== undefined) result.state = line.state
    if (owner !== undefined && (kind === 'status' || kind === 'note')) result.owner = owner

    if (kind === 'project') {
      const title = headingTitleRange(text, line)
      result.marks = { from: line.from + line.indent, to: line.content }
      result.label = title
      projects.push({
        title: text.slice(title.from, title.to),
        level: line.level!,
        line: index,
        from: title.from,
      })
    } else if (kind === 'task') {
      const listStart = line.from + line.indent
      result.bullet = { from: listStart, to: line.checkbox! }
      result.checkbox = { from: line.checkbox!, to: line.checkbox! + 3 }
      result.label = { from: line.content, to: line.to }
      if (!archived.has(index)) {
        stats.total += 1
        if (line.state === 'done') stats.done += 1
        else if (line.state === 'cancelled') stats.cancelled += 1
        else stats.open += 1
      }
    } else if (kind === 'status') {
      result.bullet = { from: line.from + line.indent, to: line.content }
      result.label = { from: line.content, to: line.to }
    } else if (kind === 'note') {
      result.label = { from: line.content, to: line.to }
    }

    result.inline = inlineSpans(text, result)
    return result
  })

  return { lines: classified, projects, stats }
}

export const linkAt = (text: string, offset: number): string | undefined => {
  const document = classifyDocument(text)
  for (const line of document.lines) {
    if (!inlineKinds.has(line.kind)) continue
    for (const span of line.inline) {
      if (span.kind !== 'link' || offset < span.from || offset > span.to) continue
      const link = linkCandidates(text, line.from, line.to).find((candidate) =>
        candidate.from === span.from && candidate.to === span.to,
      )
      if (link) return link.target
    }
  }
  return undefined
}

export const formatStats = (stats: Stats): string => `${stats.done + stats.cancelled}/${stats.total} done`
