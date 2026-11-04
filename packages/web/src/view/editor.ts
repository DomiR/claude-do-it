import type { Html, HtmlBuilder } from 'foldkit/html'

import { formatTodoChange, formatVersionHeader } from '@do-it/protocol'

import { CaptureEditorInput } from '../mount'
import { Message } from '../message'
import { Model, ReadyDocument } from '../model'
import { markdownTaskView } from './markdown'

const fileNameFor = (path: string): string => path.split('/').at(-1) ?? path

const connectionLabel = (document: ReadyDocument): string =>
  document.connection._tag === 'Live' ? 'Live' : 'Reconnecting'

const tabButton = (mode: 'Tasks' | 'Markdown', currentMode: Model['mode'], h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class(`tab-button ${mode === currentMode ? 'tab-button-active' : ''}`),
      h.AriaPressed(mode === currentMode ? 'true' : 'false'),
      h.OnClick(Message.SelectedMode({ mode })),
    ],
    [mode],
  )

const formatHeader = (activity: Model['activity'][number]): string => {
  return formatVersionHeader(activity.from, activity.to, activity.by)
}

const activityView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.aside(
    [h.Class('activity-panel'), h.AriaLabel('Activity')],
    [
      h.div([h.Class('panel-kicker')], ['Activity']),
      model.activity.length === 0
        ? h.p([h.Class('activity-empty')], ['Waiting for changes'])
        : h.ol(
            [h.Class('activity-list')],
            model.activity.map(activity =>
              h.li(
                [h.Class('activity-item')],
                [
                  h.div([h.Class('activity-header')], [formatHeader(activity)]),
                  ...(activity.todos.length === 0
                    ? [h.div([h.Class('activity-line')], ['edited'])]
                    : activity.todos.map(todo => h.div([h.Class('activity-line')], [formatTodoChange(todo)]))),
                ],
              ),
            ),
          ),
    ],
  )

export const editorView = (model: Model, document: ReadyDocument, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('editor-shell')],
    [
      h.header(
        [h.Class('app-header')],
        [
          h.div(
            [h.Class('file-heading')],
            [
              h.div([h.Class('eyebrow')], ['DO IT']),
              h.h1([h.Class('file-name')], [fileNameFor(document.path)]),
              h.div([h.Class('file-path')], [document.path]),
            ],
          ),
          h.div(
            [h.Class('header-status')],
            [
              h.span([h.Class('version-badge')], [`Version ${document.base.version}`]),
              h.span([h.Class(`connection-status connection-${connectionLabel(document).toLowerCase()}`)], [connectionLabel(document)]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('content-grid')],
        [
          h.main(
            [h.Class('editor-card')],
            [
              h.nav([h.Class('tabs'), h.Role('tablist')], [tabButton('Tasks', model.mode, h), tabButton('Markdown', model.mode, h)]),
              model.mode === 'Tasks'
                ? markdownTaskView(model, document.draft, h)
                : h.textarea([
                    h.Class('markdown-editor'),
                    h.Attribute('data-editor-textarea', ''),
                    h.Value(document.draft),
                    h.AriaLabel('Markdown document'),
                    h.OnMount(CaptureEditorInput()),
                  ]),
            ],
          ),
          activityView(model, h),
        ],
      ),
    ],
  )

export const emptyView = (h: HtmlBuilder<Message>): Html =>
  h.main(
    [h.Class('empty-shell')],
    [
      h.div([h.Class('empty-mark')], ['do it']),
      h.h1([h.Class('empty-title')], ['Open a todo']),
      h.p([h.Class('empty-copy')], ['Run do-it open FILE to start editing a Markdown todo here.']),
    ],
  )
