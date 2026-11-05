import {
  ChangeSet, EditorSelection, EditorState, Prec, RangeSet, StateField,
  type Extension, type Range, type SelectionRange, type StateCommand,
} from '@codemirror/state'
import {
  Decoration, EditorView, ViewPlugin, WidgetType, drawSelection, highlightActiveLine, keymap,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, isolateHistory, temporarilySetTabFocusMode } from '@codemirror/commands'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'

import { Message } from '../message'
import { runAction } from './actions'
import { clearRemoteHighlight, editorFacts, remoteTransaction } from './facts'
import { bindings, type Platform } from './keymap'
import { classifyDocument, linkAt, linkRangeOn, type ClassifiedDocument, type ClassifiedLine, type InlineKind, type Span } from './lines'
import { closeLinkEditor, editLink, linkEdits, openLinkEditor } from './link-popover'
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
    default: return runEditorAction(view, command, selectionOf(view), false, fallThroughUnavailable)
  }
}

const inlineClasses: Record<InlineKind, string> = {
  strong: 'pt-strong', strongMark: 'pt-strong-mark', code: 'pt-code', codeMark: 'pt-code-mark', link: 'pt-link',
  em: 'pt-em', emMark: 'pt-em-mark', strike: 'pt-strike', strikeMark: 'pt-strike-mark', linkMark: 'pt-link-mark',
  tag: 'pt-tag',
}

const sanitizeTagName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

class BulletDot extends WidgetType {
  eq(): boolean { return true }
  ignoreEvent(): boolean { return false }
  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span')
    span.className = 'pt-bullet-dot'
    span.textContent = '•'
    return span
  }
}

const markerSymbols: Record<string, string> = { open: '☐', done: '✔', cancelled: '✘' }

/** The rendered checkbox of a task line. The `[ ]` source never shows. */
class Marker extends WidgetType {
  constructor(private readonly state: string, private readonly empty: boolean) { super() }
  eq(other: Marker): boolean { return other.state === this.state && other.empty === this.empty }
  ignoreEvent(): boolean { return false }
  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument
    // The outer box keeps the width of `[ ]` in the editor font, so wrapped lines still hang under the label.
    const span = document.createElement('span')
    span.className = `pt-marker pt-marker-${this.state}${this.empty ? ' pt-marker-empty' : ''}`
    span.setAttribute('aria-label', this.state === 'done' ? 'Done' : this.state === 'cancelled' ? 'Cancelled' : 'Open')
    const symbol = document.createElement('span')
    symbol.className = 'pt-marker-symbol'
    symbol.textContent = markerSymbols[this.state] ?? '☐'
    span.append(symbol)
    return span
  }
}

/**
 * Task lines and the status lines under them always show their rendered
 * form: markers, link text, and styled text never turn back into Markdown
 * while the caret is on them. Links are edited through their popover.
 */
export const alwaysRendered = (line: ClassifiedLine): boolean => line.kind === 'task' || line.kind === 'status'

/** One based numbers of the selected lines that reveal their Markdown while edited. */
const editingLines = (state: EditorState, classified: ClassifiedDocument): number[] => {
  const touched: number[] = []
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let number = Math.max(first, (touched[touched.length - 1] ?? 0) + 1); number <= last; number += 1) {
      const line = classified.lines[number - 1]
      if (!line || !alwaysRendered(line)) touched.push(number)
    }
  }
  return touched
}

const sameNumbers = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((number, index) => number === right[index])

const lineDecorations = (classified: ClassifiedDocument, editing: readonly number[]) => {
  const ranges: Range<Decoration>[] = []
  const replaced: Range<Decoration>[] = []
  const touched = new Set(editing)
  const mark = (span: Span | undefined, className: string) => {
    if (span && span.from < span.to) ranges.push(Decoration.mark({ class: className }).range(span.from, span.to))
  }
  const replace = (span: Span, widget?: WidgetType) => {
    const range = Decoration.replace(widget ? { widget } : {}).range(span.from, span.to)
    replaced.push(range)
    ranges.push(range)
  }
  for (const line of classified.lines) {
    const editing = touched.has(line.index + 1)
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
    if (editing) classes.push('pt-line-editing')
    const hanging = line.kind === 'task' || line.kind === 'status' || line.kind === 'note'
    if (hanging) classes.push('pt-hang')
    if (classes.length) ranges.push(Decoration.line({
      class: classes.join(' '),
      attributes: hanging ? { style: `--pt-hang: ${line.hang}` } : undefined,
    }).range(line.from))
    for (const span of line.alwaysHidden) replace(span)
    if (line.checkbox) replace(line.checkbox, new Marker(line.state ?? 'open', line.empty))
    if (line.kind === 'status') mark(line.hiddenBullet, 'pt-bullet-hidden')
    if (editing) mark(line.marks, 'pt-heading-marks')
    else {
      for (const span of line.previewHidden) replace(span)
      if (line.dot) replace(line.dot, new BulletDot())
    }
    if (line.kind !== 'status' && !line.alwaysHidden.length && (editing || !line.dot)) mark(line.bullet, 'pt-bullet')
    if (line.kind === 'project') mark(line.label, 'pt-heading-title')
    else if (line.kind === 'task') mark(line.label, 'pt-label')
    for (const span of line.inline) {
      if (editing || !span.kind.endsWith('Mark')) {
        const className = span.kind === 'tag'
          ? `${inlineClasses.tag} pt-tag-${sanitizeTagName(span.name ?? '')}`
          : inlineClasses[span.kind]
        mark(span, className)
      }
    }
  }
  return { decorations: Decoration.set(ranges, true), atomicRanges: RangeSet.of(replaced, true) }
}

export const documentDecorations = StateField.define<{
  classified: ClassifiedDocument
  editing: readonly number[]
  decorations: DecorationSet
  atomicRanges: RangeSet<Decoration>
}>({
  create: state => {
    const classified = classifyDocument(state.doc.toString())
    const editing = editingLines(state, classified)
    return { classified, editing, ...lineDecorations(classified, editing) }
  },
  update: (value, transaction) => {
    if (!transaction.docChanged && !transaction.selection) return value
    const classified = transaction.docChanged ? classifyDocument(transaction.newDoc.toString()) : value.classified
    const editing = editingLines(transaction.state, classified)
    if (!transaction.docChanged && sameNumbers(value.editing, editing)) return value
    return { classified, editing, ...lineDecorations(classified, editing) }
  },
  provide: field => [
    EditorView.decorations.from(field, value => value.decorations),
    EditorView.atomicRanges.of(view => view.state.field(field).atomicRanges),
  ],
})

// A caret never rests inside a task's rendered prefix, where typing would break the task syntax.
const taskCaretFilter = EditorState.transactionFilter.of(transaction => {
  if (!transaction.isUserEvent('select') || transaction.annotation(remoteTransaction) !== undefined) return transaction
  const pointer = transaction.isUserEvent('select.pointer')
  const classified = transaction.docChanged
    ? classifyDocument(transaction.newDoc.toString())
    : transaction.startState.field(documentDecorations).classified
  let moved = false
  const ranges = transaction.newSelection.ranges.map((range, index) => {
    if (!range.empty) return range
    const line = classified.lines[transaction.newDoc.lineAt(range.head).number - 1]
    if (line?.kind !== 'task' || !line.bullet || !line.label || range.head < line.bullet.from || range.head >= line.label.from) return range
    moved = true
    if (pointer) return EditorSelection.cursor(line.label.from)
    const previous = transaction.startState.selection.ranges[index]
    const previousHead = previous === undefined ? undefined : transaction.changes.mapPos(previous.head)
    if (previousHead !== undefined && previousHead >= line.label.from &&
      transaction.newDoc.lineAt(previousHead).from === line.from) {
      return EditorSelection.cursor(line.index === 0 ? line.from : transaction.newDoc.line(line.index).to)
    }
    return EditorSelection.cursor(line.label.from)
  })
  return moved ? [transaction, {
    selection: EditorSelection.create(ranges, transaction.newSelection.mainIndex), sequential: true,
  }] : transaction
})

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

export const editorExtensions = (platform: Platform): Extension => [
  EditorState.lineSeparator.of('\n'),
  EditorState.tabSize.of(4),
  EditorState.allowMultipleSelections.of(true),
  history(), drawSelection(), highlightActiveLine(), EditorView.lineWrapping,
  EditorView.contentAttributes.of({ 'aria-label': 'Todo document' }),
  Prec.highest(inputGuard),
  Prec.highest(keymap.of([{
    key: 'Escape',
    run: closeLinkEditor,
  }, {
    key: 'Backspace',
    run: view => view.composing || view.plugin(inputGuard)?.ignoreKey ? false : deleteEmptyTaskPrefix(view),
  }, {
    key: 'Home',
    run: view => view.composing || view.plugin(inputGuard)?.ignoreKey ? false : moveToTaskLabel(view),
  }])),
  Prec.highest(keymap.of(bindings.flatMap(binding => binding[platform].map(key => ({
    key,
    run: (view: EditorView) => view.composing || view.plugin(inputGuard)?.ignoreKey
      ? false : runEditorCommand(view, binding.command, key === 'Shift-Tab' && binding.command === 'outdent'),
    stopPropagation: true,
  }))))),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, { key: 'Escape', run: temporarilySetTabFocusMode }]),
  search({ top: true }),
  documentDecorations, taskCaretFilter, remoteHighlights, highlightTimer, linkEdits,
  EditorView.domEventHandlers({
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
    // Links on rendered lines show only their text, so a plain click opens the popover that edits them.
    click(event, view) {
      const target = event.target
      if (!(target instanceof Element) || view.composing || event.button !== 0 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
      const element = target.closest('.pt-link')
      if (!element || !view.contentDOM.contains(element) || !view.state.selection.main.empty) return false
      const position = view.posAtDOM(element)
      const line = view.state.field(documentDecorations).classified.lines[view.state.doc.lineAt(position).number - 1]
      if (!line || !alwaysRendered(line)) return false
      const text = view.state.doc.toString()
      const link = linkRangeOn(text, line, position)
      if (!link) return false
      openLinkEditor(view, { from: link.from, to: link.to, label: text.slice(link.label.from, link.label.to), target: link.target }, false)
      return false
    },
  }),
]
