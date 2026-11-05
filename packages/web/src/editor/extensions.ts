import {
  ChangeSet, Compartment, EditorSelection, EditorState, Prec, RangeSet, StateField, Transaction, findClusterBreak,
  type Extension, type Line, type Range, type SelectionRange, type StateCommand, type TransactionSpec,
} from '@codemirror/state'
import {
  Decoration, EditorView, ViewPlugin, WidgetType, drawSelection, highlightActiveLine, keymap,
  type Command, type DecorationSet, type ViewUpdate,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, isolateHistory, temporarilySetTabFocusMode } from '@codemirror/commands'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'

import { Message } from '../message'
import { runAction } from './actions'
import { classifiedDocument } from './document'
import { clearRemoteHighlight, editorFacts, remoteTransaction } from './facts'
import { foldAll, foldExtensions, toggleFold, unfoldAll, type FoldOptions } from './folds'
import { bindings, type Platform } from './keymap'
import {
  classifyDocument, linkAt, linkRangeOn, prefixHasWidth, type ClassifiedDocument, type InlineKind, type Span,
} from './lines'
import { closeLinkEditor, editLink, linkEdits, openLinkEditor } from './link-popover'
import { clipboardMarkdown, startsBlock } from './paste'
import { protectSyntax, type TextChange } from './syntax'
import type { ActionId, EditorCommand, TextSelection } from './types'

export { clearRemoteHighlight, editorFacts, remoteTransaction, type EditorFact } from './facts'

const selectionOf = (view: EditorView): TextSelection => ({
  ranges: view.state.selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
  main: view.state.selection.mainIndex,
})

export const runEditorAction = (
  view: EditorView,
  action: ActionId,
  selection: TextSelection = selectionOf(view),
  keepSelection = false,
  fallThroughUnavailable = false,
): boolean => {
  const result = runAction(view.state.doc.toString(), selection, action, new Date())
  if (result._tag === 'Unavailable') {
    if (action === 'continueTask' || action === 'tab' || fallThroughUnavailable) return false
    view.state.facet(editorFacts)(Message.ShowedEditorNotice({ text: result.reason }))
    return true
  }
  try {
    const changes = ChangeSet.of(result.edits, view.state.doc.length, '\n')
    const nextSelection = keepSelection
      ? view.state.selection.map(changes)
      : EditorSelection.create(
          result.selection.ranges.map(({ anchor, head }) => EditorSelection.range(anchor, head)),
          result.selection.main,
        )
    view.dispatch({
      changes,
      selection: nextSelection,
      userEvent: 'input.action',
      annotations: isolateHistory.of('full'),
      scrollIntoView: !keepSelection,
    })
  } catch {
    view.state.facet(editorFacts)(Message.ShowedEditorNotice({ text: 'Could not apply that action' }))
  }
  return true
}

export const runEditorCommand = (view: EditorView, command: EditorCommand, fallThroughUnavailable = false): boolean => {
  switch (command) {
    case 'find': return openSearchPanel(view)
    case 'commandPalette':
    case 'gotoProject':
    case 'showShortcuts':
      view.state.facet(editorFacts)(Message.PressedEditorCommand({ command }))
      return true
    case 'openLink':
      view.state.facet(editorFacts)(Message.PressedEditorCommand({
        command, link: linkAt(view.state.doc.toString(), view.state.selection.main.head),
      }))
      return true
    case 'editLink': return editLink(view)
    case 'toggleFold':
      if (!toggleFold(view)) view.state.facet(editorFacts)(Message.ShowedEditorNotice({ text: 'No foldable block here' }))
      return true
    case 'foldAll': return foldAll(view)
    case 'unfoldAll': return unfoldAll(view)
    default: return runEditorAction(view, command, selectionOf(view), false, fallThroughUnavailable)
  }
}

const inlineClasses: Record<InlineKind, string> = {
  strong: 'pt-strong', strongMark: 'pt-strong-mark', code: 'pt-code', codeMark: 'pt-code-mark', link: 'pt-link',
  em: 'pt-em', emMark: 'pt-em-mark', strike: 'pt-strike', strikeMark: 'pt-strike-mark', linkMark: 'pt-link-mark',
  tag: 'pt-tag',
}

const sanitizeTagName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

/** A plain bullet's `- `, drawn as a dot in the same width. */
class BulletDot extends WidgetType {
  constructor(private readonly width: number) { super() }
  eq(other: BulletDot): boolean { return other.width === this.width }
  ignoreEvent(): boolean { return false }
  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span')
    span.className = 'pt-bullet-dot'
    span.textContent = '•'
    span.style.width = `${this.width}ch`
    return span
  }
}

/** A status line's bullet: blank, but as wide as before, so the line still hangs under its task. */
class BulletGap extends WidgetType {
  constructor(private readonly width: number) { super() }
  eq(other: BulletGap): boolean { return other.width === this.width }
  ignoreEvent(): boolean { return false }
  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span')
    span.className = 'pt-bullet-gap'
    span.style.width = `${this.width}ch`
    return span
  }
}

const markerSymbols: Record<string, string> = { open: '☐', done: '✔', cancelled: '✘' }

/** A task's whole `- [ ] ` prefix, drawn as its box. It moves and deletes like one character. */
class Marker extends WidgetType {
  constructor(private readonly state: string, private readonly empty: boolean, private readonly gap: number) { super() }
  eq(other: Marker): boolean { return other.state === this.state && other.empty === this.empty && other.gap === this.gap }
  ignoreEvent(): boolean { return false }
  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument
    // As wide as the `[ ]` and the space after it, so wrapped lines still hang under the label.
    const span = document.createElement('span')
    span.className = `pt-marker pt-marker-${this.state}${this.empty ? ' pt-marker-empty' : ''}`
    span.style.width = `${3 + this.gap}ch`
    span.setAttribute('aria-label', this.state === 'done' ? 'Done' : this.state === 'cancelled' ? 'Cancelled' : 'Open')
    // The box measures 3ch in the editor font; the symbol inside uses a symbol font.
    const box = document.createElement('span')
    box.className = 'pt-marker-box'
    const symbol = document.createElement('span')
    symbol.className = 'pt-marker-symbol'
    symbol.textContent = markerSymbols[this.state] ?? '☐'
    box.append(symbol)
    span.append(box)
    return span
  }
}

/**
 * Every line shows its rendered form and never turns back into Markdown
 * for the caret: prefixes become boxes, dots and hidden heading or quote
 * marks, and inline delimiters are hidden. Fenced code stays as written.
 */
const lineDecorations = (classified: ClassifiedDocument) => {
  const ranges: Range<Decoration>[] = []
  const replaced: Range<Decoration>[] = []
  const mark = (span: Span | undefined, className: string) => {
    if (span && span.from < span.to) ranges.push(Decoration.mark({ class: className }).range(span.from, span.to))
  }
  const replace = (span: Span, widget?: WidgetType) => {
    const range = Decoration.replace(widget ? { widget } : {}).range(span.from, span.to)
    replaced.push(range)
    ranges.push(range)
  }
  for (const line of classified.lines) {
    const classes: string[] = []
    switch (line.kind) {
      case 'project': classes.push('pt-line-project', `pt-level-${line.level ?? 1}`); break
      case 'task': classes.push('pt-line-task', `pt-line-task-${line.state ?? 'open'}`); break
      case 'status': classes.push('pt-line-status'); break
      case 'note': classes.push('pt-line-note'); break
      case 'prose': classes.push('pt-line-prose'); break
      case 'fence':
      case 'code': classes.push('pt-line-code'); break
      case 'quote': classes.push('pt-line-quote'); break
      case 'rule': classes.push('pt-line-rule'); break
      case 'blank': break
    }
    if (line.archived) classes.push('pt-line-archived')
    const hanging = line.kind === 'task' || line.kind === 'status' || line.kind === 'note'
    if (hanging) classes.push('pt-hang')
    if (classes.length) ranges.push(Decoration.line({
      class: classes.join(' '),
      attributes: hanging ? { style: `--pt-hang: ${line.hang}` } : undefined,
    }).range(line.from))
    const prefix = line.prefix
    if (prefix && prefix.from < prefix.to) {
      if (prefix.kind === 'task') replace(prefix, new Marker(line.state ?? 'open', line.empty, prefix.to - line.checkbox!.to))
      else if (prefix.kind === 'status') replace(prefix, new BulletGap(prefix.to - prefix.from))
      else if (prefix.kind === 'bullet') replace(prefix, new BulletDot(prefix.to - prefix.from))
      else replace(prefix)
    } else {
      // An unfinished prefix, such as `#` before its space, shows as typed.
      mark(line.marks, 'pt-heading-marks')
      if (line.kind !== 'status') mark(line.bullet, 'pt-bullet')
    }
    if (line.kind === 'project') mark(line.label, 'pt-heading-title')
    else if (line.kind === 'task') mark(line.label, 'pt-label')
    for (const span of line.inline) {
      if (span.kind.endsWith('Mark')) replace(span)
      else mark(span, span.kind === 'tag' ? `${inlineClasses.tag} pt-tag-${sanitizeTagName(span.name ?? '')}` : inlineClasses[span.kind])
    }
  }
  return { decorations: Decoration.set(ranges, true), atomicRanges: RangeSet.of(replaced, true) }
}

export const documentDecorations = StateField.define<{
  classified: ClassifiedDocument
  decorations: DecorationSet
  atomicRanges: RangeSet<Decoration>
}>({
  create: state => {
    const classified = state.field(classifiedDocument)
    return { classified, ...lineDecorations(classified) }
  },
  update: (value, transaction) => {
    if (!transaction.docChanged) return value
    const classified = transaction.state.field(classifiedDocument)
    return { classified, ...lineDecorations(classified) }
  },
  provide: field => [
    classifiedDocument,
    EditorView.decorations.from(field, value => value.decorations),
    EditorView.atomicRanges.of(view => view.state.field(field).atomicRanges),
  ],
})

/**
 * A caret never rests inside a rendered prefix, where typing would break its
 * syntax. Before a box, dot or status gap is a real position, like before
 * any character. Heading and quote marks take no space, so the position
 * before them is skipped: leftwards to the previous line, otherwise to the text.
 */
const prefixCaretFilter = EditorState.transactionFilter.of(transaction => {
  if (!transaction.isUserEvent('select') || transaction.annotation(remoteTransaction) !== undefined) return transaction
  const pointer = transaction.isUserEvent('select.pointer')
  const classified = transaction.docChanged
    ? classifyDocument(transaction.newDoc.toString())
    : transaction.startState.field(documentDecorations).classified
  let moved = false
  const ranges = transaction.newSelection.ranges.map((range, index) => {
    if (!range.empty) return range
    const line = classified.lines[transaction.newDoc.lineAt(range.head).number - 1]
    const prefix = line?.prefix
    if (!line || !prefix || range.head < prefix.from || range.head >= prefix.to) return range
    const width = prefixHasWidth(prefix)
    if (range.head === prefix.from && width) return range
    moved = true
    if (pointer) return EditorSelection.cursor(prefix.to)
    const previous = transaction.startState.selection.ranges[index]
    const previousHead = previous === undefined ? undefined : transaction.changes.mapPos(previous.head)
    const leftward = previousHead !== undefined && previousHead >= prefix.to && transaction.newDoc.lineAt(previousHead).from === line.from
    // Leftwards the prefix is one step: before the box or dot, or past a hidden mark to the previous line.
    if (leftward && width) return EditorSelection.cursor(prefix.from)
    if (leftward) return EditorSelection.cursor(line.index === 0 ? prefix.to : transaction.newDoc.line(line.index).to)
    return EditorSelection.cursor(prefix.to)
  })
  return moved ? [transaction, {
    selection: EditorSelection.create(ranges, transaction.newSelection.mainIndex), sequential: true,
  }] : transaction
})

const guardedEvents = ['delete', 'input.type', 'input.paste', 'input.drop', 'input.complete']

/** A person's deletions and replacements take rendered syntax whole, so no edit leaves `- [` or a lone `**` behind. */
const syntaxGuard = EditorState.transactionFilter.of(transaction => {
  if (!transaction.docChanged || transaction.annotation(remoteTransaction) !== undefined) return transaction
  if (!guardedEvents.some(event => transaction.isUserEvent(event))) return transaction
  const changes: TextChange[] = []
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => { changes.push({ from, to, insert: inserted.toString() }) })
  const widened = protectSyntax(transaction.startState.field(documentDecorations).classified, changes)
  if (!widened) return transaction
  const changeSet = transaction.startState.changes(widened)
  return {
    changes: changeSet,
    selection: transaction.startState.selection.map(changeSet, 1),
    userEvent: transaction.annotation(Transaction.userEvent),
    scrollIntoView: transaction.scrollIntoView,
  }
})

/**
 * Typing keeps prefixes intact: `[] ` or `[ ] ` at the start of a line
 * becomes a task, text typed before a prefix goes after it, and text typed
 * right after a box gets the space a task needs.
 */
export const prefixTyping = (state: EditorState, from: number, to: number, text: string): TransactionSpec | undefined => {
  if (from !== to) return undefined
  const docLine = state.doc.lineAt(from)
  const write = (at: number, insert: string, replaceTo = at): TransactionSpec => ({
    changes: { from: at, to: replaceTo, insert },
    selection: EditorSelection.cursor(at + insert.length),
    userEvent: 'input.type', scrollIntoView: true,
  })
  if (text === ' ') {
    const typed = /^([ \t]*)(?:[-*+] )?\[ ?\]$/.exec(state.doc.sliceString(docLine.from, from))
    if (typed) return write(docLine.from + typed[1]!.length, '- [ ] ', from)
  }
  const line = state.field(documentDecorations).classified.lines[docLine.number - 1]
  const prefix = line?.prefix
  if (!line || !prefix || prefix.from === prefix.to) return undefined
  const gapless = line.kind === 'task' && line.checkbox !== undefined && prefix.to === line.checkbox.to
  if (from === prefix.from) return write(prefix.to, gapless && !/^\s/.test(text) ? ` ${text}` : text)
  if (from === prefix.to && gapless && !/^\s/.test(text)) return write(from, ` ${text}`)
  return undefined
}

/**
 * Pasted Markdown lands as todo source in one undoable change, see
 * `clipboardMarkdown`. A paste that starts with a task, bullet, heading, or
 * quote, or spans lines, is laid out as lines: on a line's empty text it
 * takes the line, after text it starts a new line, and text after the caret
 * moves to a line of its own below, keeping its prefix. Every pasted line
 * gets the indentation of the line the paste lands on, so nested tasks stay
 * nested. Inside fenced code the paste stays plain text. Returns undefined
 * when the editor's own paste does the same.
 */
export const pasteMarkdown = (state: EditorState, plain: string, html?: string): TransactionSpec | undefined => {
  const classified = state.field(documentDecorations).classified
  const inCode = (position: number) => {
    const kind = classified.lines[state.doc.lineAt(position).number - 1]?.kind
    return kind === 'code' || kind === 'fence'
  }
  if (state.selection.ranges.some(range => inCode(range.from) || inCode(range.to))) return undefined
  const markdown = clipboardMarkdown(plain, html)
  if (markdown === null) return undefined
  const paste = (spec: TransactionSpec): TransactionSpec => ({
    ...spec, userEvent: 'input.paste', annotations: isolateHistory.of('full'), scrollIntoView: true,
  })
  const pasted = markdown.split('\n')
  const first = pasted[0]!
  if ((pasted.length === 1 && !startsBlock(first)) || state.selection.ranges.length > 1) {
    return markdown === plain.replace(/\r\n?/g, '\n') ? undefined : paste(state.replaceSelection(markdown))
  }
  const { from, to } = state.selection.main
  const textStart = (line: Line): number =>
    classified.lines[line.number - 1]?.prefix?.to ?? line.from + /^[ \t]*/.exec(line.text)![0].length
  const startLine = state.doc.lineAt(from)
  const endLine = state.doc.lineAt(to)
  const indent = /^[ \t]*/.exec(startLine.text)![0]
  const indented = pasted.map(line => line.trim() ? indent + line : line)
  const start = textStart(startLine)
  const head = from > start
    ? startsBlock(first)
      ? `${state.sliceDoc(startLine.from, from).replace(/[ \t]+$/, '')}\n${indented[0]}`
      : state.sliceDoc(startLine.from, from) + first
    : from === start && !startsBlock(first) ? state.sliceDoc(startLine.from, from) + first : indented[0]!
  const end = textStart(endLine)
  const rest = state.sliceDoc(to, endLine.to)
  const tail = to < end ? `\n${endLine.text}` : rest.trim() ? `\n${state.sliceDoc(endLine.from, end)}${rest.replace(/^[ \t]+/, '')}` : ''
  const body = [head, ...indented.slice(1)].join('\n')
  return paste({
    changes: { from: startLine.from, to: endLine.to, insert: body + tail },
    selection: EditorSelection.cursor(startLine.from + body.length),
  })
}

const prefixInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing) return false
  const spec = prefixTyping(view.state, from, to, text)
  if (!spec) return false
  view.dispatch(spec)
  return true
})

/**
 * Backspace and Delete next to hidden delimiters delete the visible
 * character beyond them, as if the delimiters were not there. Deleting the
 * last character of a styled run also removes its delimiters (syntaxGuard).
 */
const deleteAcrossMarks = (forward: boolean): Command => view => {
  const { state } = view
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false
  const line = state.field(documentDecorations).classified.lines[state.doc.lineAt(state.selection.main.head).number - 1]
  if (!line?.constructs.length) return false
  const marks = line.constructs.flatMap(construct => construct.marks)
  let position = state.selection.main.head
  let skipped = false
  for (let again = true; again;) {
    again = false
    for (const mark of marks) {
      if (forward ? mark.from === position && mark.to > position : mark.to === position && mark.from < position) {
        position = forward ? mark.to : mark.from
        skipped = again = true
      }
    }
  }
  if (!skipped) return false
  let from: number
  let to: number
  const prefix = line.prefix
  if (!forward && prefix && prefix.from < prefix.to && position === prefix.to) [from, to] = [prefix.from, prefix.to]
  else if (!forward && position === line.from) {
    if (position === 0) return true
    ;[from, to] = [position - 1, position]
  } else if (forward && position === line.to) {
    if (position === state.doc.length) return true
    ;[from, to] = [position, position + 1]
  } else {
    const docLine = state.doc.lineAt(position)
    const target = findClusterBreak(docLine.text, position - docLine.from, forward) + docLine.from
    ;[from, to] = [Math.min(position, target), Math.max(position, target)]
  }
  view.dispatch({
    changes: { from, to }, selection: EditorSelection.cursor(from),
    userEvent: forward ? 'delete.forward' : 'delete.backward', scrollIntoView: true,
  })
  return true
}
export const deleteBackwardAcrossMarks = deleteAcrossMarks(false)
export const deleteForwardAcrossMarks = deleteAcrossMarks(true)

/** The rendered width of a task's box and the space after it, so a note lines up under the label. */
const NOTE_INDENT = '    '

/**
 * Shift-Enter on a task, or on a line already in a task's block, splits at
 * the caret and starts a plain line inside that block at the column where
 * the line's text shows: under a task one box deeper, under a status line
 * past its blank bullet gap, under a note at its own indentation. Folding
 * the task hides the new line, because the block is every deeper line below
 * it (`blockEnd`). Elsewhere Shift-Enter stays a plain newline.
 */
export const insertNoteLine: StateCommand = ({ state, dispatch }) => {
  const classified = state.field(documentDecorations).classified
  const plans: Array<{ from: number; to: number; insert: string }> = []
  for (const range of state.selection.ranges) {
    const line = classified.lines[state.doc.lineAt(range.head).number - 1]
    if (!line || (line.kind !== 'task' && line.owner === undefined)) return false
    const lead = /^[ \t]*/.exec(state.doc.sliceString(line.from, line.to))![0]
    // The line's own prefix stays where it is: the split is never inside it.
    const textStart = line.prefix?.to ?? line.from + lead.length
    const gap = line.prefix && prefixHasWidth(line.prefix) ? ' '.repeat(Math.max(0, textStart - line.from - lead.length)) : ''
    const indent = line.kind === 'task' ? lead + NOTE_INDENT : lead + gap
    let from = Math.max(range.from, textStart)
    let to = Math.max(range.to, from)
    while (to < line.to && /[ \t]/.test(state.doc.sliceString(to, to + 1))) to += 1
    while (from > textStart && /[ \t]/.test(state.doc.sliceString(from - 1, from))) from -= 1
    plans.push({ from, to, insert: `\n${indent}` })
  }
  const changes = state.changes(plans)
  dispatch(state.update({
    changes,
    selection: EditorSelection.create(plans.map(plan => EditorSelection.cursor(changes.mapPos(plan.from, -1) + plan.insert.length)), state.selection.mainIndex),
    userEvent: 'input', annotations: isolateHistory.of('full'), scrollIntoView: true,
  }))
  return true
}

/**
 * Enter after the text start of a status line or note inside a task's block
 * does what Shift-Enter does there, so the new line is a plain note at the
 * same visible indentation. Tasks keep continuing as tasks, and blank lines
 * and every other line keep the ordinary newline.
 */
export const continueBlockLine: StateCommand = target => {
  const { state } = target
  const classified = state.field(documentDecorations).classified
  const inBlock = state.selection.ranges.every(range => {
    const line = classified.lines[state.doc.lineAt(range.head).number - 1]
    if (!line || line.kind === 'task' || line.owner === undefined) return false
    const text = state.doc.sliceString(line.from, line.to)
    const textStart = line.prefix?.to ?? line.from + /^[ \t]*/.exec(text)![0].length
    return text.trim() !== '' && range.from >= textStart
  })
  return inBlock && insertNoteLine(target)
}

// Home targets the label directly so it cannot be mistaken for a leftward step into the task prefix.
export const moveToTaskLabel: StateCommand = ({ state, dispatch }) => {
  const classified = state.field(documentDecorations).classified
  const ranges: SelectionRange[] = []
  for (const range of state.selection.ranges) {
    const line = classified.lines[state.doc.lineAt(range.head).number - 1]
    if (line?.kind !== 'task' || !line.label) return false
    ranges.push(EditorSelection.cursor(line.label.from))
  }
  dispatch(state.update({
    selection: EditorSelection.create(ranges, state.selection.mainIndex), userEvent: 'select', scrollIntoView: true,
  }))
  return true
}

export const deleteEmptyTaskPrefix: StateCommand = ({ state, dispatch }) => {
  const classified = state.field(documentDecorations).classified
  const edits: Array<{ from: number; to: number }> = []
  for (const range of state.selection.ranges) {
    const line = classified.lines[state.doc.lineAt(range.head).number - 1]
    if (!range.empty || !line?.empty || !line.bullet || !line.label || range.head !== line.label.from) return false
    edits.push({ from: line.bullet.from, to: line.label.from })
  }
  const changes = state.changes(edits)
  dispatch(state.update({
    changes, selection: state.selection.map(changes), userEvent: 'delete.backward', scrollIntoView: true,
  }))
  return true
}

export const remoteHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, transaction) => {
    let next = value.map(transaction.changes)
    if (transaction.effects.some(effect => effect.is(clearRemoteHighlight))) next = Decoration.none
    if (transaction.annotation(remoteTransaction) !== undefined) {
      const inserted: Range<Decoration>[] = []
      transaction.changes.iterChanges((_from, _to, from, to) => {
        if (from < to) inserted.push(Decoration.mark({ class: 'pt-remote-highlight' }).range(from, to))
      })
      next = next.update({ add: inserted, sort: true })
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

const highlightTimer = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly view: EditorView) {}
  update(update: ViewUpdate): void {
    if (!update.transactions.some(transaction => transaction.annotation(remoteTransaction) !== undefined)) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.view.dispatch({ effects: clearRemoteHighlight.of(null) })
    }, 3000)
  }
  destroy(): void { if (this.timer !== undefined) clearTimeout(this.timer) }
})

const inputGuard = ViewPlugin.fromClass(class {
  ignoreKey = false
}, {
  eventHandlers: {
    keydown(event) {
      this.ignoreKey = event.isComposing || event.keyCode === 229 || event.key === 'Dead' || event.getModifierState('AltGraph')
      return false
    },
  },
})

const unlessComposing = (command: Command): Command => view =>
  view.composing || view.plugin(inputGuard)?.ignoreKey ? false : command(view)

/** Line wrapping, off by default so long lines scroll horizontally; the formatting bar toggles it. */
const lineWrap = new Compartment()
const wrapping = (wrap: boolean): Extension => wrap ? EditorView.lineWrapping : []

export const setLineWrap = (view: EditorView, wrap: boolean): void => {
  view.dispatch({ effects: lineWrap.reconfigure(wrapping(wrap)) })
}

export interface EditorOptions extends FoldOptions { readonly wrap?: boolean }

export const editorExtensions = (platform: Platform, options: EditorOptions = {}): Extension => [
  EditorState.lineSeparator.of('\n'),
  EditorState.tabSize.of(4),
  EditorState.allowMultipleSelections.of(true),
  history(), drawSelection(), highlightActiveLine(), lineWrap.of(wrapping(options.wrap ?? false)),
  foldExtensions(options),
  EditorView.contentAttributes.of({ 'aria-label': 'Todo document' }),
  Prec.highest(inputGuard),
  Prec.highest(keymap.of([{
    key: 'Escape',
    run: closeLinkEditor,
  }, {
    key: 'Backspace',
    run: unlessComposing(view => deleteEmptyTaskPrefix(view) || deleteBackwardAcrossMarks(view)),
  }, {
    key: 'Delete',
    run: unlessComposing(deleteForwardAcrossMarks),
  }, {
    key: 'Home',
    run: unlessComposing(moveToTaskLabel),
  }, {
    key: 'Shift-Enter',
    run: unlessComposing(insertNoteLine),
  }, {
    key: 'Enter',
    run: unlessComposing(continueBlockLine),
  }])),
  Prec.highest(keymap.of(bindings.flatMap(binding => binding[platform].map(key => ({
    key,
    run: unlessComposing(view => runEditorCommand(view, binding.command, key === 'Shift-Tab' && binding.command === 'outdent')),
    stopPropagation: true,
  }))))),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, { key: 'Escape', run: temporarilySetTabFocusMode }]),
  search({ top: true }),
  documentDecorations, prefixCaretFilter, syntaxGuard, prefixInput, remoteHighlights, highlightTimer, linkEdits,
  // The document's lines end in \n only, so a pasted or dropped \r would stay in the text.
  EditorView.clipboardInputFilter.of(text => text.replace(/\r\n?/g, '\n')),
  EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData
      if (!data || view.composing || view.state.readOnly) return false
      const spec = pasteMarkdown(view.state, data.getData('text/plain'), data.getData('text/html') || undefined)
      if (!spec) return false
      view.dispatch(spec)
      return true
    },
    mousedown(event, view) {
      const target = event.target
      if (!(target instanceof Element) || view.composing) return false
      const marker = target.closest('.pt-marker')
      if (!marker || !view.contentDOM.contains(marker)) return false
      event.preventDefault()
      const position = view.posAtDOM(marker)
      const line = view.state.doc.lineAt(position)
      const slot = view.state.field(documentDecorations).classified.lines[line.number - 1]?.checkbox
      if (slot) {
        runEditorAction(view, event.altKey ? 'toggleCancelled' : 'toggleDone', {
          ranges: [{ anchor: slot.from, head: slot.from }], main: 0,
        }, true)
        view.focus()
      }
      return true
    },
    // Links show only their text, so a plain click opens the popover that edits them.
    click(event, view) {
      const target = event.target
      if (!(target instanceof Element) || view.composing || event.button !== 0 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
      const element = target.closest('.pt-link')
      if (!element || !view.contentDOM.contains(element) || !view.state.selection.main.empty) return false
      const position = view.posAtDOM(element)
      const line = view.state.field(documentDecorations).classified.lines[view.state.doc.lineAt(position).number - 1]
      if (!line) return false
      const text = view.state.doc.toString()
      const link = linkRangeOn(text, line, position)
      if (!link) return false
      openLinkEditor(view, { from: link.from, to: link.to, label: text.slice(link.label.from, link.label.to), target: link.target }, false)
      return false
    },
  }),
]
