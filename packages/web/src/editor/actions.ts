import { blockEnd, lines, type Line } from '@do-it/doc/text'

import type { ActionId, ActionResult, Range, TextSelection } from './types'
import type { Edit } from '@do-it/doc/text'

interface DocumentView {
  readonly text: string
  readonly lines: ReadonlyArray<Line>
  readonly newline: string
}

interface CaretSpec {
  readonly at: number
  readonly relative: number
}

interface ArchiveRegion {
  readonly start: number
  readonly end: number
}

interface ArchiveMovedBlock {
  readonly from: number
  readonly to: number
  readonly offsetMap: ReadonlyArray<number>
  readonly destination: number
}

interface MovePiece {
  readonly from: number
  readonly to: number
  readonly destination: number
  readonly block: boolean
}

interface MoveOperation {
  readonly from: number
  readonly to: number
  readonly insert: string
  readonly pieces: ReadonlyArray<MovePiece>
  readonly moving: MovePiece
}

interface TaskPrefix {
  readonly text: string
}

const NO_TASK = 'No task on this line'

export const runAction: (text: string, selection: TextSelection, action: ActionId) => ActionResult = (text, selection, action) => {
  try {
    const view = documentView(text)
    const normalized = normalizeSelection(text, selection)
    switch (action) {
      case 'newTask':
        return newTask(view, normalized)
      case 'toggleDone':
        return toggle(view, normalized, 'done')
      case 'toggleCancelled':
        return toggle(view, normalized, 'cancelled')
      case 'archive':
        return archive(view, normalized)
      case 'moveUp':
        return move(view, normalized, 'up')
      case 'moveDown':
        return move(view, normalized, 'down')
      case 'continueTask':
        return continueTask(view, normalized)
      case 'indent':
        return indent(view, normalized, false)
      case 'outdent':
        return indent(view, normalized, true)
      default:
        return unavailable('Unknown action')
    }
  } catch {
    return unavailable('Action unavailable')
  }
}

function documentView(text: string): DocumentView {
  const parsed = lines(text)
  let newline = '\n'
  for (let index = 0; index + 1 < parsed.length; index++) {
    const line = parsed[index]
    const next = parsed[index + 1]
    if (line !== undefined && next !== undefined) {
      const between = text.slice(line.to, next.from)
      if (between.includes('\n')) {
        newline = between
        break
      }
    }
  }
  return { text, lines: parsed, newline }
}

function normalizeSelection(text: string, selection: TextSelection): TextSelection {
  const sourceRanges = Array.isArray(selection.ranges) ? selection.ranges : []
  const ranges = sourceRanges.map(range => ({
    anchor: clampOffset(text, range.anchor),
    head: clampOffset(text, range.head),
  }))
  const requestedMain = Number.isFinite(selection.main) ? Math.trunc(selection.main) : 0
  const main = ranges.length === 0 ? 0 : Math.min(Math.max(requestedMain, 0), ranges.length - 1)
  return { ranges, main }
}

function clampOffset(text: string, offset: number): number {
  if (!Number.isFinite(offset)) return 0
  return Math.min(Math.max(Math.trunc(offset), 0), text.length)
}

function unavailable(reason: string): ActionResult {
  return { _tag: 'Unavailable', reason }
}

function lineAt(view: DocumentView, offset: number): number {
  const at = clampOffset(view.text, offset)
  for (let index = 0; index < view.lines.length; index++) {
    const line = view.lines[index]
    const next = view.lines[index + 1]
    if (line === undefined) continue
    if (at >= line.from && at <= line.to) return index
    if (next !== undefined && at > line.to && at < next.from) return index
  }
  return Math.max(view.lines.length - 1, 0)
}

function rangeBounds(range: Range): { readonly from: number; readonly to: number } {
  return range.anchor <= range.head
    ? { from: range.anchor, to: range.head }
    : { from: range.head, to: range.anchor }
}

function intersectsLine(range: Range, line: Line): boolean {
  const bounds = rangeBounds(range)
  if (line.from < line.to) return bounds.from < line.to && bounds.to > line.from
  return bounds.from <= line.from && bounds.to > line.from
}

function selectedLines(view: DocumentView, selection: TextSelection): number[] {
  const result = new Set<number>()
  for (const range of selection.ranges) {
    if (range.anchor === range.head) {
      result.add(lineAt(view, range.head))
      continue
    }
    for (let index = 0; index < view.lines.length; index++) {
      const line = view.lines[index]
      if (line !== undefined && intersectsLine(range, line)) result.add(index)
    }
  }
  return [...result].sort((a, b) => a - b)
}

function isOwnableLine(line: Line): boolean {
  return line.kind === 'item' || line.kind === 'paragraph'
}

function containingTask(view: DocumentView, index: number): number | undefined {
  const line = view.lines[index]
  if (line === undefined) return undefined
  for (let task = index - 1; task >= 0; task--) {
    const candidate = view.lines[task]
    if (candidate?.state !== undefined && blockEnd(view.lines as Line[], task) > index) return task
  }
  return undefined
}

function ownerForLine(view: DocumentView, index: number): number | undefined {
  const line = view.lines[index]
  if (line?.state !== undefined) return index
  if (line === undefined || !isOwnableLine(line)) return undefined
  return containingTask(view, index)
}

function taskTargets(view: DocumentView, selection: TextSelection, includeOwners: boolean, includeOwnersForSelection = includeOwners): number[] {
  const result = new Set<number>()
  for (const range of selection.ranges) {
    if (range.anchor === range.head) {
      const lineIndex = lineAt(view, range.head)
      const target = includeOwners ? ownerForLine(view, lineIndex) : view.lines[lineIndex]?.state === undefined ? undefined : lineIndex
      if (target !== undefined) result.add(target)
      continue
    }
    for (const index of selectedLines(view, { ranges: [range], main: 0 })) {
      const line = view.lines[index]
      if (line?.state !== undefined) result.add(index)
      else if (includeOwnersForSelection) {
        const owner = ownerForLine(view, index)
        if (owner !== undefined) result.add(owner)
      }
    }
  }
  return [...result].sort((a, b) => a - b)
}

function maximalRoots(view: DocumentView, targets: ReadonlyArray<number>): number[] {
  return targets.filter(index => !targets.some(parent => parent < index && blockEnd(view.lines as Line[], parent) > index))
}

function taskPrefix(view: DocumentView, index: number): TaskPrefix {
  const line = view.lines[index]!
  const indent = view.text.slice(line.from, line.from + line.indent)
  const sourceMarker = view.text[line.from + line.indent]
  const marker = sourceMarker === '-' || sourceMarker === '*' || sourceMarker === '+' ? sourceMarker : '-'
  return { text: `${indent}${marker} [ ] ` }
}

function taskBlockLast(view: DocumentView, index: number): number {
  return Math.max(blockEnd(view.lines as Line[], index) - 1, index)
}

function taskBlockEndOffset(view: DocumentView, index: number): number {
  return view.lines[taskBlockLast(view, index)]?.to ?? view.text.length
}

function filterEdits(view: DocumentView, edits: ReadonlyArray<Edit>): Edit[] {
  return edits
    .filter(edit => edit.from >= 0 && edit.to >= edit.from && edit.to <= view.text.length && view.text.slice(edit.from, edit.to) !== edit.insert)
    .sort((left, right) => left.from - right.from || left.to - right.to)
}

function applyRaw(text: string, edits: ReadonlyArray<Edit>): string {
  const sorted = [...edits].sort((left, right) => left.from - right.from || left.to - right.to)
  let at = 0
  const parts: string[] = []
  for (const edit of sorted) {
    parts.push(text.slice(at, edit.from), edit.insert)
    at = edit.to
  }
  parts.push(text.slice(at))
  return parts.join('')
}

function mapOffset(offset: number, edits: ReadonlyArray<Edit>): number {
  let shift = 0
  for (const edit of edits) {
    if (edit.from > offset) break
    if (edit.to > offset) return edit.from + shift + edit.insert.length
    shift += edit.insert.length - (edit.to - edit.from)
  }
  return offset + shift
}

function mapSelection(selection: TextSelection, edits: ReadonlyArray<Edit>): TextSelection {
  return {
    ranges: selection.ranges.map(range => ({
      anchor: mapOffset(range.anchor, edits),
      head: mapOffset(range.head, edits),
    })),
    main: selection.main,
  }
}

function insertionDestination(at: number, edits: ReadonlyArray<Edit>): number {
  let shift = 0
  for (const edit of edits) {
    if (edit.from > at) break
    if (edit.from === at && edit.to === at) continue
    if (edit.to <= at) shift += edit.insert.length - (edit.to - edit.from)
  }
  return at + shift
}

function withCarets(selection: TextSelection, edits: ReadonlyArray<Edit>, carets: ReadonlyMap<number, CaretSpec>, collapseMain?: CaretSpec): TextSelection {
  const mapped = mapSelection(selection, edits)
  const ranges = mapped.ranges.map((range, index) => {
    const spec = carets.get(index)
    if (spec === undefined) return range
    const at = insertionDestination(spec.at, edits) + spec.relative
    return { anchor: at, head: at }
  })
  if (collapseMain !== undefined) {
    const at = insertionDestination(collapseMain.at, edits) + collapseMain.relative
    ranges[mapped.main] = { anchor: at, head: at }
  }
  return { ranges, main: mapped.main }
}

function newTask(view: DocumentView, selection: TextSelection): ActionResult {
  const edits: Edit[] = []
  const carets = new Map<number, CaretSpec>()
  const selected = selectedLines(view, selection)

  if (selection.ranges.some(range => range.anchor !== range.head)) {
    const convertible = selected.filter(index => {
      const line = view.lines[index]
      return line !== undefined && line.state === undefined && (line.kind === 'item' || line.kind === 'paragraph' || line.kind === 'blank')
    })
    if (convertible.length > 0) {
      for (const index of convertible) {
        const line = view.lines[index]!
        const indent = view.text.slice(line.from, line.from + line.indent)
        if (line.kind === 'blank') {
          edits.push({ from: line.content, to: line.content, insert: '- [ ] ' })
        } else {
          edits.push({ from: line.from, to: line.content, insert: `${indent}- [ ] ` })
        }
      }
      const applied = filterEdits(view, edits)
      return applied.length === 0 ? unavailable('No task can be created on this line') : {
        _tag: 'Applied',
        edits: applied,
        selection: mapSelection(selection, applied),
      }
    }

    const targets = taskTargets(view, selection, true)
    const onlyTasksAndNotes = selected.every(index => {
      const line = view.lines[index]
      if (line?.state !== undefined) return true
      if (line?.kind === 'blank') return containingTask(view, index) !== undefined
      return line !== undefined && ownerForLine(view, index) !== undefined
    })
    if (targets.length > 0 && onlyTasksAndNotes) {
      const roots = maximalRoots(view, targets)
      const finalRoot = roots.at(-1)
      if (finalRoot !== undefined) {
        const at = taskBlockEndOffset(view, finalRoot)
        const prefix = taskPrefix(view, finalRoot).text
        const insert = `${view.newline}${prefix}`
        const edit = { from: at, to: at, insert }
        edits.push(edit)
        const collapse = { at, relative: insert.length }
        const applied = filterEdits(view, edits)
        return {
          _tag: 'Applied',
          edits: applied,
          selection: withCarets(selection, applied, carets, collapse),
        }
      }
    }
    return unavailable('No task can be created on this line')
  }

  const range = selection.ranges[selection.main]
  if (range === undefined) return unavailable('No task can be created on this line')
  const index = lineAt(view, range.head)
  const line = view.lines[index]
  if (line === undefined) return unavailable('No task can be created on this line')

  const taskTarget = line.state !== undefined ? index : ownerForLine(view, index)
  if (taskTarget !== undefined) {
    const at = taskBlockEndOffset(view, taskTarget)
    const insert = `${view.newline}${taskPrefix(view, taskTarget).text}`
    edits.push({ from: at, to: at, insert })
    carets.set(selection.main, { at, relative: insert.length })
  } else if (line.kind === 'heading') {
    const insert = `${view.newline}- [ ] `
    edits.push({ from: line.to, to: line.to, insert })
    carets.set(selection.main, { at: line.to, relative: insert.length })
  } else if (line.kind === 'blank') {
    const insert = '- [ ] '
    edits.push({ from: line.content, to: line.content, insert })
    carets.set(selection.main, { at: line.content, relative: insert.length })
  } else if (line.kind === 'item' || line.kind === 'paragraph') {
    const indent = view.text.slice(line.from, line.from + line.indent)
    edits.push({ from: line.from, to: line.content, insert: `${indent}- [ ] ` })
  } else {
    return unavailable('No task can be created on this line')
  }

  const applied = filterEdits(view, edits)
  return applied.length === 0 ? unavailable('No task can be created on this line') : {
    _tag: 'Applied',
    edits: applied,
    selection: withCarets(selection, applied, carets),
  }
}

function toggle(view: DocumentView, selection: TextSelection, kind: 'done' | 'cancelled'): ActionResult {
  const targets = taskTargets(view, selection, true, false)
  if (targets.length === 0) return unavailable(NO_TASK)
  if (kind === 'cancelled' && targets.every(index => view.lines[index]?.state === 'done')) {
    return unavailable('Reopen completed tasks before cancelling')
  }

  const edits: Edit[] = []
  for (const index of targets) {
    const line = view.lines[index]
    if (line?.checkbox === undefined || line.state === undefined) continue
    const next = kind === 'done'
      ? line.state === 'done' ? '[ ]' : '[x]'
      : line.state === 'cancelled' ? '[ ]' : line.state === 'done' ? view.text.slice(line.checkbox, line.checkbox + 3) : '[-]'
    edits.push({ from: line.checkbox, to: line.checkbox + 3, insert: next })
  }
  const applied = filterEdits(view, edits)
  return applied.length === 0 ? unavailable(NO_TASK) : {
    _tag: 'Applied',
    edits: applied,
    selection: mapSelection(selection, applied),
  }
}

function isArchiveHeading(view: DocumentView, index: number): boolean {
  const line = view.lines[index]
  return line?.kind === 'heading'
    && line.level === 2
    && line.depth === 0
    && view.text.slice(line.content, line.to).trimEnd() === 'Archive'
}

function archiveRegions(view: DocumentView): ArchiveRegion[] {
  const regions: ArchiveRegion[] = []
  for (let index = 0; index < view.lines.length; index++) {
    if (!isArchiveHeading(view, index)) continue
    let end = view.lines.length
    for (let probe = index + 1; probe < view.lines.length; probe++) {
      const line = view.lines[probe]
      if (line?.kind === 'heading' && (line.level === 1 || line.level === 2)) {
        end = probe
        break
      }
    }
    regions.push({ start: index, end })
  }
  return regions
}

function inArchive(index: number, regions: ReadonlyArray<ArchiveRegion>): boolean {
  return regions.some(region => index >= region.start && index < region.end)
}

function archive(view: DocumentView, selection: TextSelection): ActionResult {
  const regions = archiveRegions(view)
  const restricted = selection.ranges.some(range => range.anchor !== range.head)
  const selected = restricted ? new Set(selectedLines(view, selection)) : undefined
  const resolved = view.lines
    .map((line, index) => ({ line, index }))
    .filter(value => (value.line.state === 'done' || value.line.state === 'cancelled') && !inArchive(value.index, regions))
    .filter(value => view.text.slice(value.line.content, value.line.to).trim() !== '')
    .filter(value => {
      const end = blockEnd(view.lines as Line[], value.index)
      for (let index = value.index + 1; index < end; index++) {
        if (view.lines[index]?.state === 'open') return false
      }
      return true
    })
    .filter(value => selected === undefined || selected.has(value.index))
    .map(value => value.index)
  const roots = maximalRoots(view, resolved)
  if (roots.length === 0) return unavailable('No completed or cancelled tasks to archive')

  const blocks = roots.map(index => {
    const last = taskBlockLast(view, index)
    const raw = view.text.slice(view.lines[index]!.from, view.lines[last]!.to)
    return { index, raw: dedent(raw, view.lines[index]!.depth), sourceRaw: raw }
  })
  const movedText = blocks.map(block => block.raw).join(view.newline)
  const deletionRanges = mergeRanges(roots.map(index => archiveDeletionRange(view, index)))
  const deletionEdits = deletionRanges.map(range => ({ from: range.from, to: range.to, insert: '' }))
  const base = applyRaw(view.text, deletionEdits)

  const firstArchive = regions[0]
  let insertAt: number
  let insert: string
  let movedPrefixLength: number
  if (firstArchive === undefined) {
    insertAt = view.text.length
    const emptyBase = base.replace(/\r?\n/g, '').trim() === ''
    const hasBlankEnd = /(?:\r?\n){2}$/.test(base)
    const separator = emptyBase ? '' : hasBlankEnd ? '' : base.endsWith('\n') ? view.newline : `${view.newline}${view.newline}`
    const finalBreak = view.text.endsWith('\n') ? view.newline : ''
    const prefix = `${separator}## Archive${view.newline}${view.newline}`
    insert = `${prefix}${movedText}${finalBreak}`
    movedPrefixLength = prefix.length
  } else {
    let lastNonblank = firstArchive.start
    for (let index = firstArchive.start + 1; index < firstArchive.end; index++) {
      if (view.lines[index]?.kind !== 'blank') lastNonblank = index
    }
    insertAt = view.lines[lastNonblank]?.to ?? view.text.length
    insert = `${view.newline}${movedText}`
    movedPrefixLength = view.newline.length
  }

  const insertionEdit: Edit = { from: insertAt, to: insertAt, insert }
  const edits = filterEdits(view, [...deletionEdits, insertionEdit])
  if (edits.length === 0) return unavailable('No completed or cancelled tasks to archive')

  const insertionDestinationOffset = insertionDestination(insertAt, deletionEdits)
  const moved: ArchiveMovedBlock[] = []
  let destination = insertionDestinationOffset + movedPrefixLength
  for (const block of blocks) {
    const mapped = dedentWithMap(block.sourceRaw, view.lines[block.index]!.depth)
    moved.push({
      from: view.lines[block.index]!.from,
      to: view.lines[taskBlockLast(view, block.index)]!.to,
      offsetMap: mapped.offsetMap,
      destination,
    })
    destination += mapped.text.length + view.newline.length
  }

  return {
    _tag: 'Applied',
    edits,
    selection: mapArchiveSelection(selection, edits, moved),
  }
}

function archiveDeletionRange(view: DocumentView, index: number): { readonly from: number; readonly to: number } {
  const last = taskBlockLast(view, index)
  let from = view.lines[index]!.from
  let to = view.lines[last]!.to
  const afterIndex = last + 1
  const after = view.lines[afterIndex]
  if (after !== undefined) {
    to = after.from
    if (after.kind === 'blank') {
      const before = view.lines[index - 1]
      const afterNext = view.lines[afterIndex + 1]
      if (before?.kind === 'blank') from = before.from
      else if (afterNext !== undefined) to = afterNext.from
      else to = view.text.length
    }
  }
  return { from, to }
}

function mergeRanges(ranges: ReadonlyArray<{ readonly from: number; readonly to: number }>): Array<{ readonly from: number; readonly to: number }> {
  const sorted = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to)
  const merged: Array<{ from: number; to: number }> = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous !== undefined && range.from <= previous.to) previous.to = Math.max(previous.to, range.to)
    else merged.push({ from: range.from, to: range.to })
  }
  return merged
}

function dedent(text: string, depth: number): string {
  return dedentWithMap(text, depth).text
}

function dedentWithMap(text: string, depth: number): { readonly text: string; readonly offsetMap: ReadonlyArray<number> } {
  let output = ''
  let atLineStart = true
  let removed = 0
  const offsetMap: number[] = [0]
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (atLineStart && removed < depth && (character === ' ' || character === '\t')) {
      removed += character === '\t' ? 4 : 1
      offsetMap[index + 1] = output.length
      continue
    }
    output += character
    offsetMap[index + 1] = output.length
    if (character === '\n') {
      atLineStart = true
      removed = 0
    } else {
      atLineStart = false
    }
  }
  return { text: output, offsetMap }
}

function mapArchiveSelection(selection: TextSelection, edits: ReadonlyArray<Edit>, moved: ReadonlyArray<ArchiveMovedBlock>): TextSelection {
  const endpoint = (offset: number): number => {
    for (const block of moved) {
      if (offset >= block.from && offset <= block.to) {
        const relative = Math.min(Math.max(offset - block.from, 0), block.offsetMap.length - 1)
        return block.destination + (block.offsetMap[relative] ?? 0)
      }
    }
    return mapOffset(offset, edits)
  }
  const ranges = selection.ranges.map(range => {
    const bounds = rangeBounds(range)
    const intersectsMoved = moved.some(block => bounds.from < block.to && bounds.to > block.from)
    const sameBlock = moved.some(block => range.anchor >= block.from && range.anchor <= block.to && range.head >= block.from && range.head <= block.to)
    if (intersectsMoved && !sameBlock) {
      const head = endpoint(range.head)
      return { anchor: head, head }
    }
    return { anchor: endpoint(range.anchor), head: endpoint(range.head) }
  })
  return { ranges, main: selection.main }
}

function moveUnitForLine(view: DocumentView, index: number): { readonly start: number; readonly end: number } {
  const line = view.lines[index]
  if (line?.state !== undefined) return { start: index, end: blockEnd(view.lines as Line[], index) }
  const owner = containingTask(view, index)
  return owner === undefined
    ? { start: index, end: index + 1 }
    : { start: owner, end: blockEnd(view.lines as Line[], owner) }
}

function selectedMoveUnit(view: DocumentView, selection: TextSelection): { readonly start: number; readonly end: number } | undefined {
  const nonEmpty = selection.ranges.some(range => range.anchor !== range.head)
  const indexes = nonEmpty
    ? selectedLines(view, selection)
    : selection.ranges[selection.main] === undefined
      ? []
      : [lineAt(view, selection.ranges[selection.main]!.head)]
  if (indexes.length === 0) return undefined

  let start = view.lines.length
  let end = 0
  for (const index of indexes) {
    const unit = moveUnitForLine(view, index)
    start = Math.min(start, unit.start)
    end = Math.max(end, unit.end)
  }
  return start < end ? { start, end } : undefined
}

function taskBlockEndingAt(view: DocumentView, end: number, minimumDepth: number): { readonly start: number; readonly end: number } | undefined {
  let result: { readonly start: number; readonly end: number } | undefined
  for (let index = 0; index < end; index++) {
    const line = view.lines[index]
    if (line?.state === undefined || line.depth > minimumDepth) continue
    if (blockEnd(view.lines as Line[], index) === end) result = { start: index, end }
  }
  return result
}

function moveNeighbor(view: DocumentView, unit: { readonly start: number; readonly end: number }, direction: 'up' | 'down'): { readonly start: number; readonly end: number } | undefined {
  if (direction === 'down') {
    const line = view.lines[unit.end]
    if (line === undefined) return undefined
    return line.state === undefined
      ? { start: unit.end, end: unit.end + 1 }
      : { start: unit.end, end: blockEnd(view.lines as Line[], unit.end) }
  }

  const firstLine = view.lines[unit.start]
  const previous = unit.start - 1
  if (firstLine === undefined || previous < 0) return undefined
  return taskBlockEndingAt(view, unit.start, firstLine.depth) ?? { start: previous, end: unit.start }
}

function move(view: DocumentView, selection: TextSelection, direction: 'up' | 'down'): ActionResult {
  const unit = selectedMoveUnit(view, selection)
  if (unit === undefined) return unavailable(direction === 'up' ? 'Already at the top' : 'Already at the bottom')
  const neighbor = moveNeighbor(view, unit, direction)
  if (neighbor === undefined) return unavailable(direction === 'up' ? 'Already at the top' : 'Already at the bottom')

  const operation = direction === 'up'
    ? makeMoveOperation(view, neighbor, unit, 'up')
    : makeMoveOperation(view, unit, neighbor, 'down')
  const edits = filterEdits(view, [{ from: operation.from, to: operation.to, insert: operation.insert }])
  if (edits.length === 0) return unavailable(direction === 'up' ? 'Already at the top' : 'Already at the bottom')
  return {
    _tag: 'Applied',
    edits,
    selection: mapMoveSelection(selection, edits, [operation]),
  }
}

function makeMoveOperation(
  view: DocumentView,
  first: { readonly start: number; readonly end: number },
  second: { readonly start: number; readonly end: number },
  direction: 'up' | 'down',
): MoveOperation {
  const firstStart = view.lines[first.start]!.from
  const firstEnd = view.lines[first.end - 1]!.to
  const secondStart = view.lines[second.start]!.from
  const secondEnd = view.lines[second.end - 1]!.to
  const firstRaw = view.text.slice(firstStart, firstEnd)
  const gap = view.text.slice(firstEnd, secondStart)
  const secondRaw = view.text.slice(secondStart, secondEnd)
  const firstPiece = { from: firstStart, to: firstEnd, destination: secondRaw.length + gap.length, block: true }
  const secondPiece = { from: secondStart, to: secondEnd, destination: 0, block: true }
  const gapPiece = { from: firstEnd, to: secondStart, destination: secondRaw.length, block: false }
  return {
    from: firstStart,
    to: secondEnd,
    insert: `${secondRaw}${gap}${firstRaw}`,
    pieces: [secondPiece, gapPiece, firstPiece],
    moving: direction === 'up' ? secondPiece : firstPiece,
  }
}

function mapMoveSelection(selection: TextSelection, edits: ReadonlyArray<Edit>, operations: ReadonlyArray<MoveOperation>): TextSelection {
  const sorted = [...operations].sort((left, right) => left.from - right.from)
  const beforeShift = (operation: MoveOperation): number => {
    let shift = 0
    for (const other of sorted) {
      if (other.from >= operation.from) break
      shift += other.insert.length - (other.to - other.from)
    }
    return shift
  }
  const endpoint = (offset: number): number => {
    for (const operation of sorted) {
      if (offset < operation.from || offset > operation.to) continue
      const pieces = [...operation.pieces].sort((left, right) => Number(right.block) - Number(left.block) || left.from - right.from)
      const piece = pieces.find(candidate => offset >= candidate.from && offset <= candidate.to)
        ?? pieces.find(candidate => offset > candidate.from && offset < candidate.to)
      if (piece !== undefined) return operation.from + beforeShift(operation) + piece.destination + (offset - piece.from)
    }
    return mapOffset(offset, edits)
  }
  const endpointForRange = (offset: number, range: Range, operation: MoveOperation, shift: number): number => {
    const bounds = rangeBounds(range)
    const moving = operation.moving
    if (offset === moving.from) return operation.from + shift + moving.destination
    if (offset === moving.to) return operation.from + shift + moving.destination + (moving.to - moving.from)
    const neighbour = operation.pieces.find(piece => !piece.block)
    if (neighbour !== undefined && offset === neighbour.from && bounds.to <= neighbour.from) {
      return operation.from + shift + moving.destination + (moving.to - moving.from)
    }
    return endpoint(offset)
  }
  const shiftFor = (operation: MoveOperation): number => {
    let shift = 0
    for (const other of sorted) {
      if (other.from >= operation.from) break
      shift += other.insert.length - (other.to - other.from)
    }
    return shift
  }
  return {
    ranges: selection.ranges.map(range => {
      const operation = sorted.find(candidate => rangeBounds(range).from <= candidate.to && rangeBounds(range).to >= candidate.from)
      return operation === undefined
        ? { anchor: endpoint(range.anchor), head: endpoint(range.head) }
        : { anchor: endpointForRange(range.anchor, range, operation, shiftFor(operation)), head: endpointForRange(range.head, range, operation, shiftFor(operation)) }
    }),
    main: selection.main,
  }
}

function continueTask(view: DocumentView, selection: TextSelection): ActionResult {
  if (selection.ranges.length !== 1) return unavailable('Not a task')
  const range = selection.ranges[0]
  if (range === undefined || range.anchor !== range.head) return unavailable('Not a task')
  const index = lineAt(view, range.head)
  const line = view.lines[index]
  if (line?.state === undefined || line.content > range.head || range.head > line.to) return unavailable('Not a task')

  const prefix = taskPrefix(view, index).text
  if (line.content === line.to) {
    const edit = { from: line.from + line.indent, to: line.content, insert: '' }
    const applied = filterEdits(view, [edit])
    return {
      _tag: 'Applied',
      edits: applied,
      selection: { ranges: [{ anchor: line.from + line.indent, head: line.from + line.indent }], main: 0 },
    }
  }

  const splitAt = range.head
  const rest = view.text.slice(splitAt, line.to)
  const at = splitAt === line.to ? taskBlockEndOffset(view, index) : splitAt
  const insert = `${view.newline}${prefix}${rest}`
  const edit = { from: at, to: splitAt === line.to && at !== splitAt ? at : line.to, insert }
  const applied = filterEdits(view, [edit])
  const newLabel = insertionDestination(edit.from, applied) + view.newline.length + prefix.length
  return {
    _tag: 'Applied',
    edits: applied,
    selection: { ranges: [{ anchor: newLabel, head: newLabel }], main: 0 },
  }
}

function indent(view: DocumentView, selection: TextSelection, outdent: boolean): ActionResult {
  const targets = taskTargets(view, selection, true)
  const lineIndices = new Set<number>()
  if (targets.length > 0) {
    for (const root of maximalRoots(view, targets)) {
      const end = blockEnd(view.lines as Line[], root)
      for (let index = root; index < end; index++) lineIndices.add(index)
    }
  } else {
    for (const index of selectedLines(view, selection)) lineIndices.add(index)
  }

  const edits: Edit[] = []
  for (const index of [...lineIndices].sort((a, b) => a - b)) {
    const line = view.lines[index]
    if (line === undefined || line.kind === 'code' || line.kind === 'fence') continue
    if (!outdent) {
      edits.push({ from: line.from, to: line.from, insert: '  ' })
      continue
    }
    const first = view.text[line.from]
    if (first === '\t') edits.push({ from: line.from, to: line.from + 1, insert: '' })
    else {
      let spaces = 0
      while (spaces < 2 && view.text[line.from + spaces] === ' ') spaces++
      if (spaces > 0) edits.push({ from: line.from, to: line.from + spaces, insert: '' })
    }
  }
  const applied = filterEdits(view, edits)
  return applied.length === 0 ? unavailable('Nothing to change') : {
    _tag: 'Applied',
    edits: applied,
    selection: mapSelection(selection, applied),
  }
}
