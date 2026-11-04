import { sections, todos } from '@do-it/doc/text'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../message'
import { Model } from '../model'

const headingFor = (line: string): { level: number; title: string } | undefined => {
  const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
  return match === null ? undefined : { level: match[1]?.length ?? 1, title: match[2] ?? '' }
}

const indentationFor = (line: string): number => line.match(/^\s*/)?.[0].length ?? 0

const taskRow = (
  todo: ReturnType<typeof todos>[number],
  isHighlighted: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(`task-row ${isHighlighted ? 'task-row-highlight' : ''}`), h.Role('listitem')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class('task-checkbox'),
          h.AriaLabel(`${todo.state === 'done' ? 'Reopen' : 'Complete'} ${todo.text}`),
          h.OnClick(Message.ClickedTodo({ number: todo.number })),
        ],
        [todo.state === 'done' ? '✓' : todo.state === 'cancelled' ? '×' : ''],
      ),
      h.span([h.Class(`task-copy ${todo.state !== 'open' ? 'task-muted task-struck' : ''}`)], [todo.text]),
    ],
  )

const addTaskRow = (model: Model, section: string | null, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class('add-task-row'), h.OnSubmit(Message.ClickedAddTask({ section }))],
    [
      h.span([h.Class('add-task-plus')], ['+']),
      h.input([
        h.Type('text'),
        h.Value(model.taskInputs.find(input => input.section === section)?.text ?? ''),
        h.Placeholder('Add a task'),
        h.AriaLabel(section === null ? 'Add a task' : `Add a task to ${section}`),
        h.OnInput(text => Message.UpdatedTaskInput({ section, text })),
      ]),
    ],
  )

const sectionIdAtLine = (text: string, lineNumber: number): string | null =>
  sections(text).filter(section => section.line <= lineNumber).at(-1)?.id ?? null

export const markdownTaskView = (model: Model, text: string, h: HtmlBuilder<Message>): Html => {
  const lines = text.split('\n')
  const taskByLine = new Map(todos(text).map(todo => [todo.line, todo]))
  const sectionTaskCounts = new Map<string | null, number>()
  for (const todo of todos(text)) sectionTaskCounts.set(todo.section, (sectionTaskCounts.get(todo.section) ?? 0) + 1)
  const rendered: Html[] = []
  const addedInputs = new Set<string | null>()

  const appendInputIfNeeded = (lineNumber: number): void => {
    const section = sectionIdAtLine(text, lineNumber)
    if ((sectionTaskCounts.get(section) ?? 0) > 0 && !addedInputs.has(section)) {
      rendered.push(addTaskRow(model, section, h))
      addedInputs.add(section)
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const line = lines[index] ?? ''
    const todo = taskByLine.get(lineNumber)
    const heading = headingFor(line)
    const nextLine = lines[index + 1] ?? ''
    const atSectionEnd = headingFor(nextLine) !== undefined || index === lines.length - 1

    if (todo !== undefined) {
      rendered.push(taskRow(todo, model.highlightedTodos.includes(todo.number), h))
      if (atSectionEnd) appendInputIfNeeded(lineNumber)
      continue
    }
    if (heading !== undefined) {
      const headingTag = heading.level === 1 ? h.h2 : heading.level === 2 ? h.h3 : h.h4
      rendered.push(headingTag([h.Class('markdown-heading')], [heading.title]))
      continue
    }
    if (line.trim().length === 0) {
      rendered.push(h.div([h.Class('line-spacer')]))
      if (atSectionEnd) appendInputIfNeeded(lineNumber)
      continue
    }
    if (indentationFor(line) > 0 && /^\s*[-*+]\s+/.test(line)) {
      rendered.push(h.div([h.Class('subtask-line')], [line.trim().replace(/^[-*+]\s+/, '')]))
      if (atSectionEnd) appendInputIfNeeded(lineNumber)
      continue
    }
    rendered.push(h.p([h.Class('markdown-line')], [line]))
    if (atSectionEnd) appendInputIfNeeded(lineNumber)
  }

  if (rendered.length === 0 || (sectionTaskCounts.size === 0 && !addedInputs.has(null))) {
    rendered.push(addTaskRow(model, null, h))
  }
  return h.div([h.Class('task-list'), h.Role('list')], rendered)
}
