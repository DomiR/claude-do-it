import { EditorSelection, StateEffect, StateField, type EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView, showTooltip, type Rect, type Tooltip, type TooltipView } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'

import { Message } from '../message'
import { editorFacts, remoteTransaction } from './facts'
import { classifyDocument, linkMarkdown, linkRangeAt, type ClassifiedDocument } from './lines'

/** The source range a link edit replaces, and the values the popover starts with. */
export interface LinkTarget {
  readonly from: number
  readonly to: number
  readonly label: string
  readonly target: string
}

interface LinkEdit extends LinkTarget {
  readonly focus: boolean
  readonly tooltip: Tooltip
}

const openLinkEdit = StateEffect.define<{ readonly target: LinkTarget; readonly focus: boolean }>()
const closeLinkEdit = StateEffect.define<null>()

/** The link under the main caret, or a new link around the selected text of its line. */
export const linkTargetAt = (state: EditorState, classified: ClassifiedDocument = classifyDocument(state.doc.toString())): LinkTarget => {
  const { from, to, head } = state.selection.main
  const text = state.doc.toString()
  const link = linkRangeAt(classified, text, head)
  if (link && (from === to || (from >= link.from && to <= link.to))) {
    return { from: link.from, to: link.to, label: text.slice(link.label.from, link.label.to), target: link.target }
  }
  const end = Math.min(to, state.doc.lineAt(from).to)
  return { from, to: end, label: text.slice(from, end), target: '' }
}

/** One undoable change that writes the link as `[label](target)`, with the caret after it. */
export const linkEditSpec = (target: LinkTarget, label: string, url: string): TransactionSpec => {
  const insert = linkMarkdown(label, url)
  return {
    changes: { from: target.from, to: target.to, insert },
    selection: EditorSelection.cursor(target.from + insert.length),
    effects: closeLinkEdit.of(null),
    userEvent: 'input.link',
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  }
}

/**
 * The open link edit. It follows other writers' edits elsewhere and closes on
 * a local edit, when its link changes, or when the caret leaves it.
 */
export const linkEdits = StateField.define<LinkEdit | null>({
  create: () => null,
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(closeLinkEdit)) return null
      if (effect.is(openLinkEdit)) {
        const { target, focus } = effect.value
        return { ...target, focus, tooltip: { pos: target.from, above: false, create: linkPanel } }
      }
    }
    if (!value) return value
    let next = value
    if (transaction.docChanged) {
      // Another writer's edit elsewhere keeps the popover open. A local edit means the person moved on.
      if (transaction.annotation(remoteTransaction) === undefined || transaction.changes.touchesRange(value.from, value.to)) return null
      const from = transaction.changes.mapPos(value.from, 1)
      const to = transaction.changes.mapPos(value.to, -1)
      // The tooltip object stays the same, so the popover and what was typed in it survive the edit.
      if (from !== value.from || to !== value.to) next = { ...value, from, to }
    }
    if (transaction.selection && transaction.annotation(remoteTransaction) === undefined) {
      const head = transaction.state.selection.main.head
      if (head < next.from || head > next.to) return null
    }
    return next
  },
  provide: field => showTooltip.compute([field], state => state.field(field)?.tooltip ?? null),
})

export const openLinkEditor = (view: EditorView, target: LinkTarget, focus: boolean): void => {
  view.dispatch({ effects: openLinkEdit.of({ target, focus }) })
}

/** Cmd-K / Ctrl-K: edit the link under the caret, or link the selected text. */
export const editLink = (view: EditorView): boolean => {
  openLinkEditor(view, linkTargetAt(view.state), true)
  return true
}

export const closeLinkEditor = (view: EditorView): boolean => {
  if (!view.state.field(linkEdits, false)) return false
  view.dispatch({ effects: closeLinkEdit.of(null) })
  return true
}

const hidden: Rect = { left: -10000, right: -10000, top: -10000, bottom: -10000 }

function linkPanel(view: EditorView): TooltipView {
  const document = view.dom.ownerDocument
  const opened = view.state.field(linkEdits)!
  const current = () => view.state.field(linkEdits, false) ?? null
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const form = element('form', 'pt-link-popover')
  form.setAttribute('aria-label', 'Edit link')
  const field = (caption: string, value: string, placeholder: string) => {
    const label = element('label', 'pt-link-popover-field')
    const input = element('input', 'pt-link-popover-input')
    input.type = 'text'
    input.value = value
    input.placeholder = placeholder
    input.spellcheck = false
    input.autocomplete = 'off'
    label.append(element('span', 'pt-link-popover-caption', caption), input)
    form.append(label)
    return input
  }
  const labelInput = field('Text', opened.label, 'Link text')
  const urlInput = field('Link', opened.target, 'https://')
  const actions = element('div', 'pt-link-popover-actions')
  const button = (text: string, type: 'submit' | 'button') => {
    const node = element('button', 'pt-link-popover-button', text)
    node.type = type
    actions.append(node)
    return node
  }
  button('Save', 'submit')
  const open = button('Open', 'button')
  const remove = opened.target ? button('Remove link', 'button') : undefined
  form.append(actions)

  const finish = (spec?: TransactionSpec) => {
    const edit = current()
    if (!edit) return
    view.dispatch(spec ?? { effects: closeLinkEdit.of(null) })
    view.focus()
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    const edit = current()
    if (!edit) return
    const unchanged = labelInput.value === edit.label && urlInput.value.trim() === edit.target
    finish(unchanged ? undefined : linkEditSpec(edit, labelInput.value, urlInput.value))
  })
  form.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    finish()
  })
  open.addEventListener('click', () => {
    const link = urlInput.value.trim()
    view.state.facet(editorFacts)(link
      ? Message.PressedEditorCommand({ command: 'openLink', link })
      : Message.ShowedEditorNotice({ text: 'No link here' }))
  })
  remove?.addEventListener('click', () => {
    const edit = current()
    if (edit) finish(linkEditSpec(edit, labelInput.value || edit.label, ''))
  })

  return {
    dom: form,
    getCoords: pos => view.coordsAtPos(current()?.from ?? pos) ?? hidden,
    mount: () => {
      if (!opened.focus) return
      const input = opened.label ? urlInput : labelInput
      input.focus()
      input.select()
    },
  }
}
