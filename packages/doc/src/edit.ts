import { MAX_BYTES } from "./constants"
import { DocError } from "./errors"

const encoder = new TextEncoder()

export function utf8Length(text: string): number {
  return encoder.encode(text).length
}

export interface Edit {
  readonly from: number
  readonly to: number
  readonly insert: string
}

export function checkSize(text: string): void {
  const bytes = utf8Length(text)
  if (bytes > MAX_BYTES) {
    throw new DocError({ code: "too-large", message: `The document would be ${bytes} bytes, over the limit of ${MAX_BYTES}` })
  }
}

export function checkText(text: string): void {
  checkSize(text)
  if (!text.isWellFormed()) {
    throw new DocError({ code: "invalid", message: "Text contains an unpaired surrogate" })
  }
}

function boundary(text: string, at: number): boolean {
  const left = text.charCodeAt(at - 1)
  const right = text.charCodeAt(at)
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff)
}

export function checkedEdits(text: string, edits: ReadonlyArray<Edit>): Edit[] {
  const sorted = edits.map(edit => ({ ...edit })).sort((a, b) => a.from - b.from || a.to - b.to)
  let end = 0
  for (const edit of sorted) {
    if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to)
      || edit.from < end || edit.from > edit.to || edit.to > text.length
      || !boundary(text, edit.from) || !boundary(text, edit.to)) {
      throw new DocError({ code: "invalid", message: `The edit ${edit.from}..${edit.to} overlaps another edit, is outside the text, or splits a character` })
    }
    checkText(edit.insert)
    end = edit.to
  }
  return sorted.filter(edit => text.slice(edit.from, edit.to) !== edit.insert)
}

/** All offsets refer to the original string, including for unsorted edits. */
export function applyEdits(text: string, edits: ReadonlyArray<Edit>): string {
  const sorted = checkedEdits(text, edits)
  const parts: string[] = []
  let at = 0
  for (const edit of sorted) {
    parts.push(text.slice(at, edit.from), edit.insert)
    at = edit.to
  }
  parts.push(text.slice(at))
  const result = parts.join("")
  checkText(result)
  return result
}

/** Map an offset through ascending, nonoverlapping edits. */
export function mapOffset(offset: number, edits: ReadonlyArray<Edit>): number {
  let shift = 0
  for (const edit of edits) {
    if (edit.from > offset) break
    if (edit.to > offset) return edit.from + shift + edit.insert.length
    shift += edit.insert.length - (edit.to - edit.from)
  }
  return offset + shift
}
