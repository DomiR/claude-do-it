import {
  Annotation, ChangeSet, EditorSelection, EditorState, Facet, Prec, StateEffect, StateField,
  type Extension, type Range,
} from '@codemirror/state'
import {
  Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, keymap,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'

import { Message } from '../message'
import { runAction } from './actions'
import { bindings, type Platform } from './keymap'
import { classifyDocument, linkAt, type ClassifiedDocument, type Span } from './lines'
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

const inlineClasses = {
  strong: 'pt-strong', strongMark: 'pt-strong-mark', code: 'pt-code', codeMark: 'pt-code-mark', link: 'pt-link',
}

const lineDecorations = (state: EditorState, classified: ClassifiedDocument): DecorationSet => {
  const ranges: Range<Decoration>[] = []
  const mark = (span: Span | undefined, className: string) => {
    if (span && span.from < span.to) ranges.push(Decoration.mark({ class: className }).range(span.from, span.to))
  }
  for (const line of classified.lines) {
    const classes: string[] = []
    switch (line.kind) {
      case 'project': classes.push('pt-line-project'); break
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
    if (classes.length) ranges.push(Decoration.line({ class: classes.join(' ') }).range(line.from))
    mark(line.marks, 'pt-heading-marks')
    mark(line.bullet, 'pt-bullet')
    if (line.kind === 'project') mark(line.label, 'pt-heading-title')
    else if (line.kind === 'task') mark(line.label, 'pt-label')
    const slot = line.checkbox
    if (slot) {
      const touches = state.selection.ranges.some(range => range.empty
        ? range.head >= slot.from && range.head < slot.to
        : range.from < slot.to && range.to > slot.from)
      mark(slot, `pt-marker pt-marker-${line.state ?? 'open'}${touches ? ' pt-marker-source' : ''}`)
    }
    for (const span of line.inline) mark(span, inlineClasses[span.kind])
  }
  return Decoration.set(ranges, true)
}

const documentDecorations = StateField.define<{ classified: ClassifiedDocument; decorations: DecorationSet }>({
  create: state => {
    const classified = classifyDocument(state.doc.toString())
    return { classified, decorations: lineDecorations(state, classified) }
  },
  update: (value, transaction) => {
    if (!transaction.docChanged && !transaction.selection) return value
    const classified = transaction.docChanged ? classifyDocument(transaction.newDoc.toString()) : value.classified
    return { classified, decorations: lineDecorations(transaction.state, classified) }
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
})

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
  Prec.highest(keymap.of(bindings.flatMap(binding => binding[platform].map(key => ({
    key,
    run: (view: EditorView) => view.composing || view.plugin(inputGuard)?.ignoreKey
      ? false : runEditorCommand(view, binding.command),
    stopPropagation: true,
  }))))),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
  search({ top: true }),
  documentDecorations, remoteHighlights, highlightTimer,
  EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target
      if (!(target instanceof Element) || view.composing) return false
      const marker = target.closest('.pt-marker')
      if (!marker || !view.contentDOM.contains(marker)) return false
      event.preventDefault()
      const position = view.posAtDOM(marker)
      const line = view.state.doc.lineAt(position)
      const slot = view.state.field(documentDecorations).classified.lines.find(candidate => candidate.from === line.from)?.checkbox
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
