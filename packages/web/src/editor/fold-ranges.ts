import { blockEnd, lines, withoutStamps } from '@do-it/doc/text'

import type { DetailsBlock, LineSpan, SourceSpan } from './blocks'
import type { ClassifiedDocument, ClassifiedLine } from './lines'

export type FoldKind = 'heading' | 'task' | 'details'
export type FoldKey = string

export interface FoldCandidate extends SourceSpan, LineSpan {
  readonly key: FoldKey
  readonly kind: FoldKind
  readonly headerLine: number
  readonly anchor: number
  readonly label: SourceSpan
  readonly hidden: SourceSpan
  readonly hiddenLines: number
  readonly initiallyOpen: boolean
  readonly parent?: number
  readonly explicitId?: string
  readonly identityLabel: string
}

type Candidate = Omit<FoldCandidate, 'key' | 'parent' | 'identityLabel'>

const normalizedLabel = (text: string, candidate: Candidate): string => {
  let label = text.slice(candidate.label.from, candidate.label.to)
  if (candidate.kind === 'task') label = withoutStamps(label).replace(/[ \t]+@project(?:[ \t]*\([^()\r\n]*\))?[ \t]*$/, '')
  if (candidate.kind === 'heading') label = label.replace(/[ \t]+#+[ \t]*$/, '')
  return label.trim().replace(/\s+/g, ' ')
}

/** All foldable blocks, regardless of which ancestors are currently closed. */
export const foldCandidates = (text: string, classified: ClassifiedDocument): readonly FoldCandidate[] => {
  const all = classified.lines
  const parsed = lines(text)
  const details = classified.blocks.details
  const candidates: Candidate[] = []
  const nonblank = [0]
  for (const line of all) nonblank.push(nonblank[nonblank.length - 1]! + (text.slice(line.from, line.to).trim() ? 1 : 0))
  // A final newline creates a phantom line, not another hidden body line.
  const end = text.endsWith('\n') ? all.length - 1 : all.length
  const ordinary = (kind: 'heading' | 'task', line: ClassifiedLine, endLine: number): void => {
    if (endLine <= line.index + 1 || nonblank[endLine] === nonblank[line.index + 1]) return
    const to = all[endLine - 1]!.to
    candidates.push({
      kind, from: line.from, to, startLine: line.index, endLine,
      headerLine: line.index, anchor: line.from, label: line.label!,
      hidden: { from: line.to, to }, hiddenLines: endLine - line.index - 1, initiallyOpen: true,
    })
  }

  for (const block of details) {
    const header = all[block.summaryLine]!
    candidates.push({
      kind: 'details', from: block.from, to: block.to, startLine: block.startLine, endLine: block.endLine,
      headerLine: block.summaryLine, anchor: header.from, label: block.title,
      hidden: { from: header.to, to: block.to }, hiddenLines: block.endLine - block.summaryLine - 2,
      initiallyOpen: block.initiallyOpen, explicitId: block.explicitId,
    })
  }

  interface Scope { readonly block?: DetailsBlock; readonly headings: ClassifiedLine[] }
  const scopes: Scope[] = [{ headings: [] }]
  let detailIndex = 0
  const finish = (scope: Scope, boundary: number, level = 0): void => {
    while (scope.headings.length && scope.headings.at(-1)!.level! >= level) {
      ordinary('heading', scope.headings.pop()!, boundary)
    }
  }
  for (let index = 0; index < end; index += 1) {
    while (scopes.at(-1)!.block && index >= scopes.at(-1)!.block!.endLine - 1) {
      const scope = scopes.pop()!
      finish(scope, scope.block!.endLine - 1)
    }
    const block = details[detailIndex]
    if (block?.startLine === index) {
      scopes.push({ block, headings: [] })
      detailIndex += 1
    }
    const line = all[index]!
    if (line.kind === 'project') {
      const scope = scopes.at(-1)!
      finish(scope, index, line.level!)
      scope.headings.push(line)
    } else if (line.kind === 'task') ordinary('task', line, Math.min(end, blockEnd(parsed, index)))
  }
  for (const scope of scopes) finish(scope, scope.block ? scope.block.endLine - 1 : end)

  candidates.sort((left, right) => left.from - right.from || right.to - left.to)
  const stack: Candidate[] = []
  const dropped = new Set<Candidate>()
  for (const candidate of candidates) {
    while (stack.length && candidate.from >= stack.at(-1)!.to) stack.pop()
    // Details and scoped headings take priority over a task that cuts across them.
    while (stack.length && candidate.to > stack.at(-1)!.to && stack.at(-1)!.kind === 'task') dropped.add(stack.pop()!)
    const parent = stack.at(-1)
    if (parent && (candidate.to > parent.to || (candidate.kind === 'task' && parent.kind === 'details' && candidate.to === parent.to))) {
      dropped.add(candidate)
    } else stack.push(candidate)
  }

  const ids = new Map<string, number>()
  for (const block of details) if (block.explicitId !== undefined) ids.set(block.explicitId, (ids.get(block.explicitId) ?? 0) + 1)
  const occurrences = new Map<string, number>()
  const result: FoldCandidate[] = []
  const parents: number[] = []
  for (const candidate of candidates) {
    if (dropped.has(candidate)) continue
    while (parents.length && candidate.from >= result[parents.at(-1)!]!.to) parents.pop()
    const identityLabel = normalizedLabel(text, candidate)
    const base = `v1:${candidate.kind}:${identityLabel}`
    const occurrence = occurrences.get(base) ?? 0
    occurrences.set(base, occurrence + 1)
    const key = candidate.explicitId !== undefined && ids.get(candidate.explicitId) === 1
      ? `v1:details#${candidate.explicitId}` : `${base}#${occurrence}`
    result.push({ ...candidate, key, identityLabel, parent: parents.at(-1) })
    parents.push(result.length - 1)
  }
  return result
}

/** Prefer the header at the caret, then the innermost enclosing body. */
export const foldTarget = (candidates: readonly FoldCandidate[], head: number): FoldCandidate | undefined => {
  let containing: FoldCandidate | undefined
  for (const candidate of candidates) {
    if (head >= candidate.anchor && head <= candidate.hidden.from) return candidate
    if (head >= candidate.from && head <= candidate.to) containing = candidate
  }
  return containing
}
