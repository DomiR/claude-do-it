import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { formatTodoChange, formatVersionHeader } from '@do-it/protocol'
import { classifyDocument, formatStats } from '../editor/lines'
import { Message } from '../message'
import { type Model, type ReadyDocument, saveStatus } from '../model'
import { MountEditor } from '../mount'
import { paletteView } from './palette'

const fileNameFor = (path: string): string => path.split('/').at(-1) ?? path
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export const cursorLabel = (text: string, head: number): string => {
  const prefix = text.slice(0, Math.max(0, Math.min(head, text.length)))
  const line = prefix.split('\n').length
  const column = Array.from(graphemes.segment(prefix.slice(prefix.lastIndexOf('\n') + 1))).length + 1
  return `Ln ${line}, Col ${column}`
}

const activityView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.keyed('aside')('activity', [h.Class('pt-activity'), h.AriaLabel('Activity')], [
    h.h2([h.Class('pt-activity-title')], ['Activity']),
    model.activity.length === 0
      ? h.p([h.Class('pt-activity-empty')], ['Waiting for changes'])
      : h.ol([h.Class('pt-activity-list')], model.activity.map(activity =>
          h.li([h.Class('pt-activity-item')], [
            h.div([h.Class('pt-activity-header')], [formatVersionHeader(activity.from, activity.to, activity.by)]),
            ...(activity.todos.length === 0
              ? [h.div([h.Class('pt-activity-line')], ['edited'])]
              : activity.todos.map(todo => h.div([h.Class('pt-activity-line')], [formatTodoChange(todo)]))),
          ]))),
  ])

export const editorView = (model: Model, document: ReadyDocument, h: HtmlBuilder<Message>): Html => {
  const stats = classifyDocument(document.draft).stats
  const status = saveStatus(document)
  return h.div([h.Class('pt-shell')], [
    h.header([h.Class('pt-header')], [
      h.h1([h.Class('pt-file-name'), h.Title(document.path)], [fileNameFor(document.path)]),
      h.div([h.Class('pt-header-actions')], [
        h.button([
          h.Class(`pt-header-button${model.palette._tag === 'Open' ? ' pt-header-button-active' : ''}`),
          h.Type('button'), h.OnClick(Message.ClickedCommands()), h.AriaExpanded(model.palette._tag === 'Open'),
        ], ['Commands']),
        h.button([
          h.Class(`pt-header-button${model.activityOpen ? ' pt-header-button-active' : ''}`),
          h.Type('button'), h.OnClick(Message.ClickedActivity()), h.AriaExpanded(model.activityOpen),
        ], ['Activity']),
      ]),
    ]),
    h.main([h.Class(`pt-workspace${model.activityOpen ? ' pt-workspace-with-activity' : ''}`)], [
      // The Mount owns this childless host for the entire document session.
      h.keyed('div')(`editor:${document.session}`, [
        h.Class('pt-editor-host'),
        h.OnMount(MountEditor({
          session: document.session, text: document.draft, selection: document.selection, platform: model.platform,
        })),
      ]),
      ...(model.activityOpen ? [activityView(model, h)] : []),
    ]),
    h.footer([h.Class('pt-status-bar')], [
      h.div([h.Class('pt-status-left')], [
        h.span([
          h.Class('pt-status-item'), h.Title(`${stats.done} completed, ${stats.cancelled} cancelled, ${stats.open} open`),
        ], [formatStats(stats)]),
        h.span([h.Class('pt-notice'), h.Role('status'), h.Attribute('aria-live', 'polite')], Option.match(model.notice, {
          onNone: () => [],
          onSome: notice => /^(https?:|mailto:)/i.test(notice)
            ? [h.a([h.Href(notice), h.Attribute('target', '_blank'), h.Attribute('rel', 'noopener noreferrer')], [notice])]
            : [notice],
        })),
      ]),
      h.div([h.Class('pt-status-right')], [
        h.span([h.Class('pt-status-item')], [cursorLabel(document.draft, document.selection.head)]),
        h.span([h.Class('pt-status-item')], [`Version ${document.base.version}`]),
        h.span([h.Class(`pt-status-item${status === 'Saving' ? ' pt-status-saving' : status === 'Reconnecting' ? ' pt-status-reconnecting' : ''}`)], [status]),
      ]),
    ]),
    ...(model.palette._tag === 'Open' ? [paletteView(model, document.draft, h)] : []),
  ])
}

export const emptyView = (h: HtmlBuilder<Message>): Html =>
  h.main([h.Class('empty-shell')], [
    h.div([h.Class('empty-mark')], ['do it']),
    h.h1([h.Class('empty-title')], ['Open a todo']),
    h.p([h.Class('empty-copy')], ['Run do-it open FILE to start editing a Markdown todo here.']),
  ])
