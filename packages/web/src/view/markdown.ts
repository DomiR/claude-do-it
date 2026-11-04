import { sections, todos } from '@do-it/doc/text'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../message'
import { Model } from '../model'

const headingFor = (line: string): { level: number; title: string } | undefined => {
  const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
  return match === null ? undefined : { level: match[1]?.length ?? 1, title: match[2] ?? '' }
}

const indentationFor = (line: string): number =>
  [...(line.match(/^[ \t]*/)?.[0] ?? '')].reduce((indent, character) => indent + (character === '\t' ? 4 : 1), 0)

const inlineMarkdown = (text: string, h: HtmlBuilder<Message>): ReadonlyArray<Html | string> => {
  const rendered: Array<Html | string> = []
  const token = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g
  let offset = 0

  for (const match of text.matchAll(token)) {
    const start = match.index ?? 0
    const value = match[0]
    if (start > offset) rendered.push(text.slice(offset, start))
    if (value.startsWith('**')) {
      rendered.push(h.strong([], [value.slice(2, -2)]))
    } else {
      rendered.push(h.code([], [value.slice(1, -1)]))
    }
    offset = start + value.length
  }

  if (offset < text.length) rendered.push(text.slice(offset))
  return rendered.length === 0 ? [text] : rendered
}

const taskDetailText = (line: string): string =>
  line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '').replace(/^\[[ xX-]\]\s*/, '')

const taskRow = (
  todo: ReturnType<typeof todos>[number],
  isHighlighted: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(`task-row ${isHighlighted ? 'task-row-highlight' : ''}`), h.Role('listitem')],
    [
      h.input([
        h.Type('checkbox'),
        h.Checked(todo.state === 'done'),
        h.Disabled(todo.state === 'cancelled'),
        h.Class('task-checkbox'),
        h.AriaLabel(`${todo.state === 'done' ? 'Reopen' : todo.state === 'cancelled' ? 'Cancelled' : 'Complete'} ${todo.text}`),
        h.OnChange(() => Message.ClickedTodo({ number: todo.number })),
      ]),
      h.span([h.Class(`task-copy ${todo.state !== 'open' ? 'task-muted task-struck' : ''}`)], inlineMarkdown(todo.text, h)),
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
      h.button([h.Type('submit'), h.Class('add-task-button')], ['Add']),
    ],
  )

const sectionIdAtLine = (text: string, lineIndex: number): string | null =>
  sections(text).filter(section => section.line <= lineIndex).at(-1)?.id ?? null

export const markdownTaskView = (model: Model, text: string, h: HtmlBuilder<Message>): Html => {
  const lines = text.split('\n')
  const documentTodos = todos(text)
  const taskByLine = new Map(documentTodos.map(todo => [todo.line, todo]))
  const sectionTaskCounts = new Map<string | null, number>()
  for (const todo of documentTodos) sectionTaskCounts.set(todo.section, (sectionTaskCounts.get(todo.section) ?? 0) + 1)
  const rendered: Html[] = []
  const addedInputs = new Set<string | null>()
  let activeTaskIndent: number | undefined

  const appendInputIfNeeded = (lineIndex: number): void => {
    const section = sectionIdAtLine(text, lineIndex)
    if ((sectionTaskCounts.get(section) ?? 0) > 0 && !addedInputs.has(section)) {
      rendered.push(addTaskRow(model, section, h))
      addedInputs.add(section)
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const todo = taskByLine.get(index)
    const heading = headingFor(line)
    const nextLine = lines[index + 1] ?? ''
    const atSectionEnd = headingFor(nextLine) !== undefined || index === lines.length - 1
    const indentation = indentationFor(line)
    const isIndentedUnderTask = activeTaskIndent !== undefined && indentation > activeTaskIndent

    if (!isIndentedUnderTask && line.trim().length > 0) activeTaskIndent = undefined

    if (todo !== undefined && isIndentedUnderTask) {
      rendered.push(h.div([h.Class('subtask-line')], inlineMarkdown(taskDetailText(line), h)))
      if (atSectionEnd) appendInputIfNeeded(index)
      continue
    }
    if (todo !== undefined) {
      if (todo.text.length > 0) {
        rendered.push(taskRow(todo, model.highlightedTodos.includes(todo.number), h))
        activeTaskIndent = todo.indent
      }
      if (atSectionEnd) appendInputIfNeeded(index)
      continue
    }
    if (isIndentedUnderTask) {
      rendered.push(h.div([h.Class('subtask-line')], inlineMarkdown(taskDetailText(line), h)))
      if (atSectionEnd) appendInputIfNeeded(index)
      continue
    }
    if (heading !== undefined) {
      const headingTag = heading.level === 1 ? h.h2 : heading.level === 2 ? h.h3 : h.h4
      rendered.push(headingTag([h.Class('markdown-heading')], [heading.title]))
      continue
    }
    if (line.trim().length === 0) {
      rendered.push(h.div([h.Class('line-spacer')]))
      if (atSectionEnd) appendInputIfNeeded(index)
      continue
    }
    if (indentation > 0 && /^\s*[-*+]\s+/.test(line)) {
      rendered.push(h.div([h.Class('subtask-line')], inlineMarkdown(taskDetailText(line), h)))
      if (atSectionEnd) appendInputIfNeeded(index)
      continue
    }
    rendered.push(h.p([h.Class('markdown-line')], inlineMarkdown(line, h)))
    if (atSectionEnd) appendInputIfNeeded(index)
  }

  if (rendered.length === 0 || (sections(text).length === 0 && !addedInputs.has(null))) {
    rendered.push(addTaskRow(model, null, h))
  }
  return h.div([h.Class('task-list'), h.Role('list')], rendered)
}
