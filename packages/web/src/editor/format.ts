import type { Edit } from '@do-it/doc/text'

import { classifyDocument, type ClassifiedDocument, type ClassifiedLine, type InlineConstruct } from './lines'
import type { ActionResult, Range, TextSelection } from './types'

/** The formatting bar's actions. Each is one undoable edit of the Markdown source. */
export type FormatAction = 'bold' | 'italic' | 'strike' | 'code' | 'toggleTask' | 'toggleBullet' | 'toggleHeading'

const inline: Record<'bold' | 'italic' | 'strike' | 'code', { readonly marker: string; readonly kind: InlineConstruct['kind'] }> = {
  bold: { marker: '**', kind: 'strong' },
  italic: { marker: '*', kind: 'em' },
  strike: { marker: '~~', kind: 'strike' },
  code: { marker: '`', kind: 'code' },
}

const unavailable = (reason: string): ActionResult => ({ _tag: 'Unavailable', reason })

const lineOf = (document: ClassifiedDocument, offset: number): ClassifiedLine | undefined =>
  document.lines.find(line => offset >= line.from && offset <= line.to)

/** Where a line's own text starts: after its rendered prefix, or after its indentation. */
const textStart = (text: string, line: ClassifiedLine): number => {
  if (line.prefix) return line.prefix.to
  if (line.label) return line.label.from
  let at = line.from
  while (at < line.to && /[ \t]/.test(text[at]!)) at += 1
  return at
}

/** Positions after the edits, where an edit at exactly `offset` lands after (`assoc` 1) or before (-1) it. */
const mapThrough = (edits: ReadonlyArray<Edit>, offset: number, assoc: 1 | -1): number => {
  let shift = 0
  for (const edit of edits) {
    if (edit.to < offset || (edit.to === offset && edit.from < offset) || (edit.from === offset && edit.to === offset && assoc > 0)) {
      shift += edit.insert.length - (edit.to - edit.from)
    } else if (edit.from < offset && offset < edit.to) return edit.from + shift + (assoc > 0 ? edit.insert.length : 0)
  }
  return offset + shift
}

const sorted = (edits: ReadonlyArray<Edit>): Edit[] => {
  const seen = new Set<string>()
  return [...edits].filter(edit => {
    const key = `${edit.from}:${edit.to}:${edit.insert}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((left, right) => left.from - right.from || left.to - right.to)
}

const wordAt = (text: string, line: ClassifiedLine, offset: number, start: number): { from: number; to: number } => {
  let from = offset
  let to = offset
  while (from > start && /[\p{L}\p{N}_'-]/u.test(text[from - 1]!)) from -= 1
  while (to < line.to && /[\p{L}\p{N}_'-]/u.test(text[to]!)) to += 1
  return { from, to }
}

/** Bold, italic, strikethrough and code wrap the selection or the word at the caret, or unwrap the run they are in. */
const toggleInline = (text: string, selection: TextSelection, action: keyof typeof inline): ActionResult => {
  const { marker, kind } = inline[action]
  const document = classifyDocument(text)
  const edits: Edit[] = []
  const targets: Array<{ range: Range; anchor: [number, 1 | -1]; head: [number, 1 | -1]; caret?: number }> = []
  for (const range of selection.ranges) {
    const low = Math.min(range.anchor, range.head)
    const line = lineOf(document, low)
    if (!line || line.kind === 'code' || line.kind === 'fence') continue
    const high = Math.min(Math.max(range.anchor, range.head), line.to)
    const run = line.constructs.find(construct => construct.kind === kind && construct.content.from <= low && high <= construct.content.to)
    if (run) {
      for (const mark of run.marks) edits.push({ from: mark.from, to: mark.to, insert: '' })
      targets.push({ range, anchor: [range.anchor, -1], head: [range.head, -1] })
      continue
    }
    const start = textStart(text, line)
    let from = Math.max(low, start)
    let to = Math.max(high, from)
    if (from === to) ({ from, to } = wordAt(text, line, from, start))
    while (from < to && /\s/.test(text[from]!)) from += 1
    while (to > from && /\s/.test(text[to - 1]!)) to -= 1
    if (from === to) {
      edits.push({ from, to, insert: marker + marker })
      targets.push({ range, anchor: [from, -1], head: [from, -1], caret: marker.length })
      continue
    }
    edits.push({ from, to: from, insert: marker }, { from: to, to, insert: marker })
    const forward = range.head >= range.anchor
    const collapsed = range.anchor === range.head
    targets.push(collapsed
      ? { range, anchor: [range.head, range.head <= from ? 1 : -1], head: [range.head, range.head <= from ? 1 : -1] }
      : { range, anchor: forward ? [from, 1] : [to, -1], head: forward ? [to, -1] : [from, 1] })
  }
  if (!edits.length) return unavailable('Nothing to format here')
  const applied = sorted(edits)
  return {
    _tag: 'Applied',
    edits: applied,
    selection: {
      ranges: targets.map(({ anchor, head, caret }) => {
        if (caret !== undefined) {
          const at = mapThrough(applied, anchor[0], -1) + caret
          return { anchor: at, head: at }
        }
        return { anchor: mapThrough(applied, anchor[0], anchor[1]), head: mapThrough(applied, head[0], head[1]) }
      }),
      main: Math.min(selection.main, Math.max(0, targets.length - 1)),
    },
  }
}

const selectedLines = (document: ClassifiedDocument, selection: TextSelection): ClassifiedLine[] => {
  const result = new Map<number, ClassifiedLine>()
  for (const range of selection.ranges) {
    const low = Math.min(range.anchor, range.head)
    const high = Math.max(range.anchor, range.head)
    for (const line of document.lines) {
      if (line.to >= low && line.from <= high && !(line.from === high && high > low)) result.set(line.index, line)
    }
  }
  return [...result.values()].sort((left, right) => left.index - right.index)
}

/** The source to replace when a line changes its kind: its prefix, or nothing at the start of its text. */
const prefixSource = (text: string, line: ClassifiedLine): { from: number; to: number } => {
  if (line.prefix) return { from: line.prefix.from, to: line.prefix.to }
  if (line.marks) return line.marks
  if (line.bullet) return { from: line.bullet.from, to: line.label?.from ?? line.bullet.to }
  if (line.quoteMark) return line.quoteMark
  const at = textStart(text, line)
  return { from: at, to: at }
}

/** Turns each selected line into a task, a bullet or a heading, or back into plain text when it already is one. */
const toggleLines = (text: string, selection: TextSelection, action: 'toggleTask' | 'toggleBullet' | 'toggleHeading'): ActionResult => {
  const document = classifyDocument(text)
  const lines = selectedLines(document, selection).filter(line => line.kind !== 'code' && line.kind !== 'fence' && line.kind !== 'rule')
  if (!lines.length) return unavailable('Nothing to format here')
  const is = (line: ClassifiedLine) => action === 'toggleTask' ? line.kind === 'task'
    : action === 'toggleBullet' ? line.prefix?.kind === 'bullet' || line.kind === 'status' || (line.kind === 'prose' && line.bullet !== undefined)
    : line.kind === 'project'
  // Like a list button in a word processor: when every line already is one, remove it; otherwise apply it.
  const remove = lines.every(is)
  const insert = action === 'toggleTask' ? '- [ ] ' : action === 'toggleBullet' ? '- ' : '## '
  const edits: Edit[] = []
  for (const line of lines) {
    const source = prefixSource(text, line)
    if (remove) edits.push({ from: source.from, to: source.to, insert: '' })
    else if (!is(line)) {
      // A heading starts its line, so it also takes the indentation.
      const from = action === 'toggleHeading' ? line.from : source.from
      edits.push({ from, to: source.to, insert })
    }
  }
  const applied = sorted(edits)
  return {
    _tag: 'Applied',
    edits: applied,
    selection: {
      ranges: selection.ranges.map(range => ({ anchor: mapThrough(applied, range.anchor, 1), head: mapThrough(applied, range.head, 1) })),
      main: selection.main,
    },
  }
}

export const runFormat = (text: string, selection: TextSelection, action: FormatAction): ActionResult => {
  switch (action) {
    case 'bold':
    case 'italic':
    case 'strike':
    case 'code':
      return toggleInline(text, selection, action)
    default:
      return toggleLines(text, selection, action)
  }
}
