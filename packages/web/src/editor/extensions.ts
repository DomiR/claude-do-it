import {
  Annotation, ChangeSet, EditorSelection, EditorState, Facet, Prec, RangeSet, StateEffect, StateField,
  type Extension, type Range, type SelectionRange, type StateCommand,
} from '@codemirror/state'
import {
  Decoration, EditorView, ViewPlugin, WidgetType, drawSelection, highlightActiveLine, keymap,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'

import { Message } from '../message'
import { runAction } from './actions'
import { bindings, type Platform } from './keymap'
import { classifyDocument, linkAt, type ClassifiedDocument, type ClassifiedLine, type InlineKind, type Span } from './lines'
import type { ActionId, EditorCommand, TextSelection } from './types'

export const remoteTransaction = Annotation.define<number>()
export const clearRemoteHighlight = StateEffect.define<null>()

export type EditorFact =
  | typeof Message.PressedEditorCommand.Type
  | typeof Message.ShowedEditorNotice.Type

export const editorFacts = Facet.define<(fact: EditorFact) => void, (fact: EditorFact) => void>({
  combine: listeners => fact => { for (const listener of listeners) listener(fact) },
})

const selectionOf = (view: EditorView): TextSelection => ({
  ranges: view.state.selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
  main: view.state.selection.mainIndex,
})

export const runEditorAction = (
  view: EditorView,
  action: ActionId,
  selection: TextSelection = selectionOf(view),
  keepSelection = false,
): boolean => {
  const result = runAction(view.state.doc.toString(), selection, action)
  if (result._tag === 'Unavailable') {
    if (action === 'continueTask') return false
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

export const runEditorCommand = (view: EditorView, command: EditorCommand): boolean => {
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
    default: return runEditorAction(view, command)
  }
}

const inlineClasses: Record<InlineKind, string> = {
  strong: 'pt-strong', strongMark: 'pt-strong-mark', code: 'pt-code', codeMark: 'pt-code-mark', link: 'pt-link',
  em: 'pt-em', emMark: 'pt-em-mark', strike: 'pt-strike', strikeMark: 'pt-strike-mark', linkMark: 'pt-link-mark',
}

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

const editingLines = (state: EditorState): number[] => {
  const touched: number[] = []
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let number = Math.max(first, (touched[touched.length - 1] ?? 0) + 1); number <= last; number += 1) {
      touched.push(number)
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
    if (editing) mark(line.marks, 'pt-heading-marks')
    else {
      for (const span of line.previewHidden) replace(span)
      if (line.dot) replace(line.dot, new BulletDot())
    }
    if (!line.alwaysHidden.length && (editing || !line.dot)) mark(line.bullet, 'pt-bullet')
    if (line.kind === 'project') mark(line.label, 'pt-heading-title')
    else if (line.kind === 'task') mark(line.label, 'pt-label')
    for (const span of line.inline) {
      if (editing || !span.kind.endsWith('Mark')) mark(span, inlineClasses[span.kind])
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
    const editing = editingLines(state)
    return { classified, editing, ...lineDecorations(classified, editing) }
  },
  update: (value, transaction) => {
    if (!transaction.docChanged && !transaction.selection) return value
    const editing = editingLines(transaction.state)
    if (!transaction.docChanged && sameNumbers(value.editing, editing)) return value
    const classified = transaction.docChanged ? classifyDocument(transaction.newDoc.toString()) : value.classified
    return { classified, editing, ...lineDecorations(classified, editing) }
  },
  provide: field => [
    EditorView.decorations.from(field, value => value.decorations),
    EditorView.atomicRanges.of(view => view.state.field(field).atomicRanges),
  ],
})

const sourceMarkers = (state: EditorState, classified: ClassifiedDocument): number[] => {
  const touched = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number - 1
    const last = state.doc.lineAt(range.to).number - 1
    for (let index = first; index <= last; index += 1) {
      const slot = classified.lines[index]?.checkbox
      if (slot && (range.empty ? range.head >= slot.from && range.head < slot.to : range.from < slot.to && range.to > slot.from)) {
        touched.add(index)
      }
    }
  }
  return [...touched]
}

const markerDecoration = (line: ClassifiedLine, source: boolean): Range<Decoration> => Decoration.mark({
  class: `pt-marker pt-marker-${line.state ?? 'open'}${source ? ' pt-marker-source' : ''}${line.empty ? ' pt-marker-empty' : ''}`,
}).range(line.checkbox!.from, line.checkbox!.to)

// Source visibility changes only at slot boundaries, independently of the cached line preview and atomic ranges.
const markerDecorations = StateField.define<{ sources: readonly number[]; decorations: DecorationSet }>({
  create: state => {
    const classified = state.field(documentDecorations).classified
    const sources = sourceMarkers(state, classified)
    const touched = new Set(sources)
    return {
      sources,
      decorations: Decoration.set(classified.lines.flatMap(line => line.checkbox ? [markerDecoration(line, touched.has(line.index))] : [])),
    }
  },
  update: (value, transaction) => {
    if (!transaction.docChanged && !transaction.selection) return value
    const classified = transaction.state.field(documentDecorations).classified
    const sources = sourceMarkers(transaction.state, classified)
    const touched = new Set(sources)
    if (transaction.docChanged) return {
      sources,
      decorations: Decoration.set(classified.lines.flatMap(line => line.checkbox ? [markerDecoration(line, touched.has(line.index))] : [])),
    }
    if (sameNumbers(value.sources, sources)) return value
    const previous = new Set(value.sources)
    const changed = [...new Set([...value.sources, ...sources])]
      .filter(index => previous.has(index) !== touched.has(index))
      .sort((left, right) => left - right)
    const add = changed.map(index => markerDecoration(classified.lines[index]!, touched.has(index)))
    const starts = new Set(add.map(range => range.from))
    return {
      sources,
      decorations: value.decorations.update({
        filter: from => !starts.has(from),
        filterFrom: add[0]!.from,
        filterTo: add[add.length - 1]!.to,
        add, sort: true,
      }),
    }
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
})

const taskCaretFilter = EditorState.transactionFilter.of(transaction => {
  if (!transaction.isUserEvent('select') || transaction.isUserEvent('select.pointer') ||
    transaction.annotation(remoteTransaction) !== undefined) return transaction
  const classified = transaction.docChanged
    ? classifyDocument(transaction.newDoc.toString())
    : transaction.startState.field(documentDecorations).classified
  let moved = false
  const ranges = transaction.newSelection.ranges.map((range, index) => {
    if (!range.empty) return range
    const line = classified.lines[transaction.newDoc.lineAt(range.head).number - 1]
    if (line?.kind !== 'task' || !line.bullet || !line.label || range.head < line.bullet.from || range.head >= line.label.from) return range
    moved = true
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

// Home targets the label directly so it cannot be mistaken for a leftward step into the marker slot.
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
    key: 'Backspace',
    run: view => view.composing || view.plugin(inputGuard)?.ignoreKey ? false : deleteEmptyTaskPrefix(view),
  }, {
    key: 'Home',
    run: view => view.composing || view.plugin(inputGuard)?.ignoreKey ? false : moveToTaskLabel(view),
  }])),
  Prec.highest(keymap.of(bindings.flatMap(binding => binding[platform].map(key => ({
    key,
    run: (view: EditorView) => view.composing || view.plugin(inputGuard)?.ignoreKey
      ? false : runEditorCommand(view, binding.command),
    stopPropagation: true,
  }))))),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
  search({ top: true }),
  documentDecorations, markerDecorations, taskCaretFilter, remoteHighlights, highlightTimer,
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
  }),
]
