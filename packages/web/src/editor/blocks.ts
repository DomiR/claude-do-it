import type { Line } from '@do-it/doc/text'

export interface SourceSpan {
  readonly from: number
  readonly to: number
}

export interface LineSpan {
  readonly startLine: number
  readonly endLine: number
}

export interface DetailsBlock extends SourceSpan, LineSpan {
  readonly summaryLine: number
  readonly title: SourceSpan
  readonly body: SourceSpan
  /** The complete closing line, including its indentation. */
  readonly close: SourceSpan
  /** Literal tags only, without surrounding indentation or newlines. */
  readonly delimiters: readonly SourceSpan[]
  readonly parent?: number
  readonly explicitId?: string
  readonly initiallyOpen: boolean
}

interface HtmlBlockBase extends SourceSpan, LineSpan {
  readonly open: SourceSpan
  readonly body: SourceSpan
  readonly delimiters: readonly SourceSpan[]
  readonly indent: string
}

export type HtmlBlock = HtmlBlockBase & (
  | { readonly closed: true; readonly close: SourceSpan }
  | { readonly closed: false; readonly close?: undefined }
)

export type BlockRole =
  | 'details-open' | 'details-summary' | 'details-close'
  | 'html-open' | 'html-body' | 'html-close' | 'diagnostic'

export interface BlockLineInfo {
  readonly role: BlockRole
  /** Index in details or html, according to the role. Diagnostics have no block. */
  readonly block?: number
  readonly title?: SourceSpan
}

export interface BlockDiagnostic extends SourceSpan {
  readonly kind: 'details' | 'html'
  readonly reason: 'unmatched-open' | 'unmatched-close' | 'unmatched-summary' | 'invalid-header' | 'unclosed-fence'
  readonly line: number
}

export interface BlockIndex {
  readonly details: readonly DetailsBlock[]
  readonly html: readonly HtmlBlock[]
  readonly diagnostics: readonly BlockDiagnostic[]
  readonly byLine: readonly (BlockLineInfo | undefined)[]
}

interface DetailsAttributes {
  readonly initiallyOpen: boolean
  readonly explicitId?: string
}

interface Summary {
  readonly line: number
  readonly title: SourceSpan
  readonly open: SourceSpan
  readonly close: SourceSpan
}

interface PendingDetails {
  readonly line: number
  readonly open: SourceSpan
  readonly attributes?: DetailsAttributes
  readonly summary?: Summary
  readonly parent?: number
  closeLine?: number
}

const detailsAttributes = (source: string): DetailsAttributes | undefined => {
  let rest = source
  let initiallyOpen = false
  let explicitId: string | undefined
  const seen = new Set<string>()
  while (rest.trim()) {
    const match = /^[ \t]+(open|id)(?:[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^ \t"'=<>`]+)))?(?=[ \t]|$)/.exec(rest)
    if (!match || seen.has(match[1]!)) return undefined
    const name = match[1]!
    seen.add(name)
    if (name === 'open') initiallyOpen = true
    else {
      explicitId = match[2] ?? match[3]
      if (explicitId === undefined) return undefined
    }
    rest = rest.slice(match[0].length)
  }
  return { initiallyOpen, explicitId }
}

const summaryOn = (source: string, from: number, line: number): Summary | undefined => {
  const match = /^[ \t]*<summary>(.*?)<\/summary>[ \t]*$/.exec(source)
  if (!match || /<\/?summary>/.test(match[1]!)) return undefined
  const open = from + source.indexOf('<summary>')
  const title = { from: open + '<summary>'.length, to: open + '<summary>'.length + match[1]!.length }
  return {
    line, title,
    open: { from: open, to: title.from },
    close: { from: title.to, to: title.to + '</summary>'.length },
  }
}

/** Scan the shared lexical lines. Offsets are UTF-16 and endLine is exclusive. */
export const scanBlocks = (text: string, lines: readonly Line[]): BlockIndex => {
  const details: DetailsBlock[] = []
  const html: HtmlBlock[] = []
  const diagnostics: BlockDiagnostic[] = []
  const byLine: (BlockLineInfo | undefined)[] = Array.from({ length: lines.length }, () => undefined)
  const pending: PendingDetails[] = []
  const stack: number[] = []
  let fence: { line: number; html: boolean } | undefined

  const diagnoseDetails = (line: number, reason: BlockDiagnostic['reason']): void => {
    const source = lines[line]!
    diagnostics.push({ kind: 'details', reason, line, from: source.from, to: source.to })
    byLine[line] = { role: 'diagnostic' }
  }
  const finishHtml = (startLine: number, closeLine?: number): void => {
    const opening = lines[startLine]!
    const closing = closeLine === undefined ? undefined : lines[closeLine]!
    const open = { from: opening.from, to: opening.to }
    const base: HtmlBlockBase = {
      from: opening.from, to: closing?.to ?? text.length,
      startLine, endLine: closeLine === undefined ? lines.length : closeLine + 1,
      open,
      body: { from: lines[startLine + 1]?.from ?? text.length, to: closing?.from ?? text.length },
      delimiters: closing ? [open, { from: closing.from, to: closing.to }] : [open],
      indent: text.slice(opening.from, opening.from + opening.indent),
    }
    const block = html.length
    html.push(closing
      ? { ...base, closed: true, close: { from: closing.from, to: closing.to } }
      : { ...base, closed: false })
    for (let line = startLine; line < base.endLine; line += 1) {
      byLine[line] = { role: line === startLine ? 'html-open' : line === closeLine ? 'html-close' : 'html-body', block }
    }
    if (!closing) diagnostics.push({ kind: 'html', reason: 'unclosed-fence', line: startLine, ...open })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    // The shared parser decides which fences close, including marker and run length.
    if (line.kind === 'fence') {
      if (fence) {
        if (fence.html) finishHtml(fence.line, index)
        fence = undefined
      } else {
        const opening = /^(`{3,}|~{3,})(.*)$/.exec(text.slice(line.from + line.indent, line.to))
        const info = opening?.[2]?.trim().split(/\s+/)
        fence = { line: index, html: info !== undefined && info.length === 2 && info[0] === 'html' && info[1] === 'do-it' }
      }
      continue
    }
    if (line.kind === 'code') continue
    const from = line.from + line.indent
    const source = text.slice(from, line.to)
    const opening = /^<details(?=[ \t>])((?:[^"'<>]|"[^"]*"|'[^']*')*)>/.exec(source)
    if (opening) {
      const open = { from, to: from + opening[0].length }
      const rest = source.slice(opening[0].length)
      const next = lines[index + 1]
      const summary = rest.trim()
        ? summaryOn(rest, open.to, index)
        : next?.kind === 'paragraph' ? summaryOn(text.slice(next.from, next.to), next.from, index + 1) : undefined
      pending.push({ line: index, open, attributes: detailsAttributes(opening[1]!), summary, parent: stack.at(-1) })
      stack.push(pending.length - 1)
      if (summary) index = summary.line
    } else if (/^<\/details>[ \t]*$/.test(source)) {
      const parent = stack.pop()
      if (parent === undefined) diagnoseDetails(index, 'unmatched-close')
      else pending[parent]!.closeLine = index
    } else if (/^<\/?summary(?:[ \t>]|$)/.test(source)) {
      diagnoseDetails(index, 'unmatched-summary')
    }
  }
  if (fence?.html) finishHtml(fence.line)

  // Openers are in source order, so parents are resolved before their children.
  const parents: (number | undefined)[] = []
  for (const [index, entry] of pending.entries()) {
    const parent = entry.parent === undefined ? undefined : parents[entry.parent]
    parents[index] = parent
    const { summary, attributes, closeLine } = entry
    if (!summary || !attributes || closeLine === undefined) {
      const reason = !summary || !attributes ? 'invalid-header' : 'unmatched-open'
      diagnoseDetails(entry.line, reason)
      if (summary && summary.line !== entry.line) diagnoseDetails(summary.line, reason)
      if (closeLine !== undefined) diagnoseDetails(closeLine, 'invalid-header')
      continue
    }
    const closing = lines[closeLine]!
    const block = details.length
    const close = { from: closing.from, to: closing.to }
    details.push({
      from: lines[entry.line]!.from, to: closing.to,
      startLine: entry.line, endLine: closeLine + 1, summaryLine: summary.line,
      title: summary.title,
      body: { from: lines[summary.line + 1]!.from, to: closing.from },
      close,
      delimiters: [entry.open, summary.open, summary.close, {
        from: closing.from + closing.indent, to: closing.from + closing.indent + '</details>'.length,
      }],
      parent, ...attributes,
    })
    parents[index] = block
    byLine[entry.line] = { role: 'details-open', block }
    byLine[summary.line] = { role: 'details-summary', block, title: summary.title }
    byLine[closeLine] = { role: 'details-close', block }
  }
  diagnostics.sort((left, right) => left.line - right.line)
  return { details, html, diagnostics, byLine }
}
