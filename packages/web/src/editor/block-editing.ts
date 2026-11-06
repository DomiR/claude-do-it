import {
  Annotation, EditorSelection, EditorState, SelectionRange, Transaction,
  type Extension, type TransactionSpec,
} from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { EditorView, ViewPlugin, type Command, type ViewUpdate } from '@codemirror/view'

import type { BlockIndex, DetailsBlock, SourceSpan } from './blocks'
import { classifiedDocument } from './document'
import { remoteTransaction } from './facts'
import { foldViewState } from './fold-view'
import { foldState, setFoldOpen } from './folds'
import { htmlBlockDecorations } from './html-block'
import type { ClassifiedDocument } from './lines'
import { protectSyntax, type TextChange } from './syntax'

const overlaps = (a: SourceSpan, b: SourceSpan): boolean => a.from < b.to && a.to > b.from
const covers = (a: SourceSpan, b: SourceSpan): boolean => a.from <= b.from && a.to >= b.to
const sameChanges = (a: readonly TextChange[], b: readonly TextChange[]): boolean => a.length === b.length &&
  a.every((change, i) => change.from === b[i]!.from && change.to === b[i]!.to && change.insert === b[i]!.insert)
const mergeChanges = (changes: readonly TextChange[]): TextChange[] => {
  const result: TextChange[] = []
  for (const change of [...changes].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const previous = result.at(-1)
    if (previous && change.from <= previous.to) result[result.length - 1] = {
      from: previous.from, to: Math.max(previous.to, change.to), insert: previous.insert + change.insert,
    }
    else result.push(change)
  }
  return result
}
const detailsSyntax = (block: DetailsBlock): readonly SourceSpan[] => [
  { from: block.from, to: block.title.from },
  { from: block.title.to, to: block.body.from },
  block.close,
]
const joinsBoundary = (change: SourceSpan, block: SourceSpan): boolean =>
  change.from < block.from && change.to >= block.from || change.from <= block.to && change.to > block.to

export const guardedEvents = ['delete', 'input.type', 'input.paste', 'input.drop', 'input.complete', 'input.replace', 'input.replace.all']

/** Keep separator newlines before inline cleanup can interpret a deletion as a line join. */
export const htmlBoundaryGuard = EditorState.changeFilter.of(transaction => {
  if (!transaction.docChanged || transaction.annotation(remoteTransaction) !== undefined || transaction.isUserEvent('input.replace') ||
    !guardedEvents.some(event => transaction.isUserEvent(event))) return true
  const document = transaction.startState.field(classifiedDocument)
  const protectedRanges: TextChange[] = []
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    if (from === to || inserted.length) return
    for (const block of document.blocks.html) {
      if (!block.closed || overlaps({ from, to }, block)) continue
      const before = { from: document.lines[block.startLine - 1]?.to ?? block.from, to: block.from }
      const after = { from: block.to, to: document.lines[block.endLine]?.from ?? block.to }
      for (const span of [before, after]) if (overlaps({ from, to }, span)) protectedRanges.push({ ...span, insert: '' })
    }
  })
  return protectedRanges.length ? mergeChanges(protectedRanges).flatMap(span => [span.from, span.to]) : true
})

/** Unwrap touched details and delete touched HTML whole, without duplicating the person's insertions. */
export const protectBlockSyntax = (blocks: BlockIndex, changes: readonly TextChange[]): TextChange[] | undefined => {
  let result = [...changes]
  for (;;) {
    const extra: TextChange[] = []
    const add = (span: SourceSpan): void => {
      if (span.from < span.to && !result.some(change => covers(change, span))) extra.push({ ...span, insert: '' })
    }
    const deletions = result.filter(change => change.from < change.to)
    for (const block of blocks.html) {
      if (block.closed && deletions.some(change => overlaps(change, block) || joinsBoundary(change, block))) add(block)
    }
    for (const block of blocks.details) {
      if (deletions.some(change => covers(change, block))) continue
      if (!deletions.some(change => detailsSyntax(block).some(span => overlaps(change, span)) ||
        joinsBoundary(change, block) || joinsBoundary(change, block.close))) continue
      // Keep line whitespace and content, including the delimiters of untouched nested sections.
      for (const span of block.delimiters) add(span)
    }
    if (!extra.length) return sameChanges(result, changes) ? undefined : result
    const next = mergeChanges([...result, ...extra])
    if (sameChanges(next, result)) return sameChanges(result, changes) ? undefined : result
    result = next
  }
}

/** Inline cleanup can expose another block boundary, so compose both protections to a fixed point. */
export const protectRenderedSyntax = (document: ClassifiedDocument, changes: readonly TextChange[]): TextChange[] | undefined => {
  let result = [...changes]
  for (;;) {
    const inline = protectSyntax(document, result) ?? result
    const next = protectBlockSyntax(document.blocks, inline) ?? inline
    if (sameChanges(next, result)) return sameChanges(result, changes) ? undefined : result
    result = next
  }
}

/** Extra deletions in the proposed document preserve inserted text, selections, effects and annotations. */
export const syntaxCleanup = (transaction: Transaction, protectedChanges: readonly TextChange[]): TextChange[] => {
  const extra: TextChange[] = []
  transaction.changes.iterGaps((fromA, fromB, length) => {
    for (const change of protectedChanges) {
      const from = Math.max(fromA, change.from)
      const to = Math.min(fromA + length, change.to)
      if (from < to) extra.push({ from: fromB + from - fromA, to: fromB + to - fromA, insert: '' })
    }
  })
  return extra
}

export const replacementTouchesBlockSyntax = (blocks: BlockIndex, changes: readonly TextChange[]): boolean => {
  const touches = (change: TextChange, span: SourceSpan): boolean => change.from === change.to
    ? change.from >= span.from && change.from <= span.to : overlaps(change, span) || joinsBoundary(change, span)
  return changes.some(change => blocks.html.some(block => block.delimiters.some(span => touches(change, span))) ||
    blocks.details.some(block => {
      if (change.from >= block.title.from && change.to <= block.title.to) return false
      return detailsSyntax(block).some(span => change.from === change.to
        ? change.from >= span.from && change.from < span.to : overlaps(change, span)) ||
        change.from < change.to && (joinsBoundary(change, block) || joinsBoundary(change, block.close))
    }))
}

export const blockInputHandled = Annotation.define<boolean>()
const indentOf = (text: string): string => /^[ \t]*/.exec(text)![0]
const bodyIndent = (state: EditorState, block: DetailsBlock): string => {
  for (let number = block.summaryLine + 2; number < block.endLine; number += 1) {
    const text = state.doc.line(number).text
    if (text.trim()) return indentOf(text)
  }
  return indentOf(state.doc.line(block.summaryLine + 1).text)
}

/** Route input on hidden tags and the end marker to editable title or body text. */
export const blockTyping = (state: EditorState, from: number, to: number, text: string): TransactionSpec | undefined => {
  if (!text) return undefined
  const document = state.field(classifiedDocument)
  for (const block of document.blocks.details) {
    const summary = document.lines[block.summaryLine]!
    const eol = state.sliceDoc(summary.to, block.body.from) || '\n'
    const write = (at: number, insert: string, caret: number, open = false): TransactionSpec => ({
      changes: { from: at, insert }, selection: EditorSelection.cursor(caret),
      effects: open ? state.field(foldState).candidates.filter(candidate => candidate.kind === 'details' && candidate.from === block.from)
        .map(candidate => setFoldOpen.of({ key: candidate.key, open: true })) : [],
      annotations: blockInputHandled.of(true), userEvent: 'input.type', scrollIntoView: true,
    })
    if ((from >= block.title.from || from === to && from >= block.from) && to <= summary.to && /[\r\n]/.test(text)) {
      const indent = bodyIndent(state, block)
      const body = text === '\n' || text === '\r\n' ? '' : text.replace(/\r\n?/g, '\n')
      const insert = eol + body.split('\n').map(line => indent + line).join(eol)
      return write(summary.to, insert, summary.to + insert.length, true)
    }
    if (from !== to) continue
    const closer = block.delimiters.at(-1)!
    if (from >= block.close.from && from <= block.to) {
      const before = from < closer.to
      const indent = before ? bodyIndent(state, block) : indentOf(state.doc.line(block.endLine).text)
      const body = text === '\n' || text === '\r\n' ? '' : text.replace(/\r\n?/g, '\n')
      const content = body.split('\n').map(line => indent + line).join(eol)
      return before ? write(block.close.from, content + eol, block.close.from + content.length)
        : write(block.to, eol + content, block.to + eol.length + content.length)
    }
    if (from >= block.from && from < block.title.from) return write(block.title.from, text, block.title.from + text.length)
    if (from > block.title.to && from <= summary.to) return write(block.title.to, text, block.title.to + text.length)
  }
  return undefined
}

/** Use CodeMirror's range mapping for mixed and multiple carets. */
export const blockInput = (state: EditorState, text: string): TransactionSpec | undefined => {
  let handled = false
  const spec = state.changeByRange(range => {
    const result = blockTyping(state, range.from, range.to, text)
    if (!result) return { changes: { from: range.from, to: range.to, insert: text }, range: EditorSelection.cursor(range.from + text.length) }
    handled = true
    // blockTyping answers with one caret, a SelectionRange, not a whole EditorSelection.
    const selection = result.selection
    const next = selection instanceof EditorSelection ? selection.main
      : selection instanceof SelectionRange ? selection
        : EditorSelection.range(selection?.anchor ?? range.from + text.length, selection?.head ?? selection?.anchor ?? range.from + text.length)
    return { changes: result.changes, range: next, effects: result.effects }
  })
  return handled ? { ...spec, annotations: blockInputHandled.of(true), userEvent: 'input.type', scrollIntoView: true } : undefined
}

/** Also route input transactions produced by composition commits or direct paste commands. */
export const blockInputFilter = EditorState.transactionFilter.of(transaction => {
  if (!transaction.docChanged || transaction.annotation(remoteTransaction) !== undefined || transaction.annotation(blockInputHandled) ||
    !['input.type', 'input.paste'].some(event => transaction.isUserEvent(event))) return transaction
  const changes: TextChange[] = []
  transaction.changes.iterChanges((from, to, _a, _b, insert) => { changes.push({ from, to, insert: insert.toString() }) })
  const first = changes[0]!
  const selections = transaction.startState.selection.ranges
  const aligned = changes.length === selections.length && changes.every((change, i) => change.insert === first.insert &&
    change.from === selections[i]!.from && change.to === selections[i]!.to)
  const spec = aligned ? blockInput(transaction.startState, first.insert)
    : changes.length === 1 ? blockTyping(transaction.startState, first.from, first.to, first.insert) : undefined
  if (!spec) return transaction
  const desired = transaction.startState.changes(spec.changes)
  return [transaction, {
    changes: transaction.changes.invert(transaction.startState.doc).compose(desired), selection: spec.selection,
    effects: spec.effects, annotations: blockInputHandled.of(true), sequential: true,
  }]
})

export const enterDetailsBody: Command = view => {
  if (view.composing || view.state.readOnly) return false
  const spec = blockInput(view.state, '\n')
  if (!spec) return false
  view.dispatch(spec)
  return true
}

export const blockCaretFilter = EditorState.transactionFilter.of(transaction => {
  if (transaction.annotation(remoteTransaction) !== undefined || transaction.isUserEvent('undo') || transaction.isUserEvent('redo') ||
    !transaction.selection && !transaction.docChanged) return transaction
  const document = (transaction.docChanged ? transaction.state : transaction.startState).field(classifiedDocument)
  let changed = false
  const ranges = transaction.newSelection.ranges.map((range, index) => {
    if (!range.empty) return range
    for (const block of document.blocks.details) {
      const summary = document.lines[block.summaryLine]!
      const closer = block.delimiters.at(-1)!
      const spans = [{ from: block.from, to: block.title.from }, { from: block.title.to, to: summary.to }, closer]
      for (const [part, span] of spans.entries()) {
        if (range.head <= span.from || range.head >= span.to) continue
        const previous = transaction.startState.selection.ranges[index]
        const left = previous !== undefined && transaction.changes.mapPos(previous.head) >= span.to
        const to = transaction.isUserEvent('select.pointer') ? part === 0 ? span.to : span.from : left ? span.from : span.to
        changed = true
        return EditorSelection.cursor(to)
      }
    }
    return range
  })
  return changed ? [transaction, { selection: EditorSelection.create(ranges, transaction.newSelection.mainIndex), sequential: true }] : transaction
})

const afterLine = (state: EditorState, to: number): number => state.doc.lineAt(to).to + 1
const adjacent = (state: EditorState, range: SourceSpan, position: number, forward: boolean): boolean => forward
  ? position === range.from || position === state.doc.lineAt(position).to && afterLine(state, position) === range.from
  : position === range.to || position === afterLine(state, range.to)

/** Folding boundaries reveal first; HTML boundaries select first, then delete the selected fence. */
export const deleteAdjacentBlock = (forward: boolean): Command => view => {
  const { state } = view
  if (view.composing || state.readOnly) return false
  const hidden = state.field(foldViewState).hidden
  const titleEnds = new Map(state.field(classifiedDocument).blocks.details.map(block => [block.startLine, block.title.to]))
  const opening = state.field(foldState).candidates.filter(candidate => hidden.some(span => span.from === candidate.hidden.from && span.to === candidate.hidden.to) &&
    state.selection.ranges.some(range => range.empty && (forward
      ? range.head === candidate.hidden.from || range.head === candidate.hidden.to ||
        candidate.kind === 'details' && range.head === titleEnds.get(candidate.startLine)
      : adjacent(state, candidate.hidden, range.head, false))))
  if (opening.length) {
    view.dispatch({ effects: opening.map(candidate => setFoldOpen.of({ key: candidate.key, open: true })), annotations: Transaction.addToHistory.of(false) })
    return true
  }
  const html: SourceSpan[] = []
  state.field(htmlBlockDecorations).between(0, state.doc.length, (from, to) => { html.push({ from, to }) })
  let selected = false
  const ranges = state.selection.ranges.map(range => {
    if (!range.empty) return range
    const block = html.find(block => adjacent(state, block, range.head, forward))
    if (!block) return range
    selected = true
    return EditorSelection.range(block.from, block.to)
  })
  if (selected) {
    view.dispatch({ selection: EditorSelection.create(ranges, state.selection.mainIndex), userEvent: 'select', scrollIntoView: true })
    return true
  }
  if (!ranges.every(range => html.some(block => range.from === block.from && range.to === block.to))) return false
  view.dispatch({
    ...state.changeByRange(range => ({ changes: { from: range.from, to: range.to }, range: EditorSelection.cursor(range.from) })),
    userEvent: 'delete.selection', annotations: isolateHistory.of('full'), scrollIntoView: true,
  })
  return true
}

/** Selection feedback changes the existing host only, so selecting HTML never reruns its scripts. */
export class HtmlSelectionFeedback {
  private active = true
  constructor(private readonly view: EditorView) { this.schedule() }
  update(update: ViewUpdate): void {
    if (update.selectionSet || update.docChanged || update.viewportChanged || update.geometryChanged ||
      update.startState.field(htmlBlockDecorations) !== update.state.field(htmlBlockDecorations)) this.schedule()
  }
  private schedule(): void { this.view.requestMeasure({ key: this, read: () => null, write: () => { if (this.active) this.refresh() } }) }
  refresh(): void {
    const { state } = this.view
    for (const host of this.view.contentDOM.querySelectorAll<HTMLElement>('.pt-html-section')) {
      const position = this.view.posAtDOM(host)
      let selected = false
      state.field(htmlBlockDecorations).between(position, position, (from, to) => {
        if (from === position && state.selection.ranges.some(range => range.from <= from && range.to >= to)) selected = true
      })
      host.classList.toggle('pt-html-section-selected', selected)
    }
  }
  destroy(): void { this.active = false }
}

export const htmlSelectionFeedback: Extension = [
  ViewPlugin.fromClass(HtmlSelectionFeedback),
  EditorView.baseTheme({ '.pt-html-section-selected': { outline: '2px solid var(--pt-project)', outlineOffset: '-2px' } }),
]
