import { describe, expect, test } from 'bun:test'

import { classifyDocument, formatStats, linkAt } from './lines'

const source = `# Roadmap
Intro **bold** and \`code\`, https://example.com/docs, http://example.com, [guide](https://example.com/guide), <mailto:team@example.com>, [tasks](#tasks)

## Tasks
- [ ] First task
  - **t3** M, planning
  note for first
- [x] Done task
- [X] Upper task
- [-] Cancelled task
- [ ]${' '}
  - [ ] Nested task
- [ ] Empty task
> quoted prose
---
\`\`\`md
- [ ] not a task
**not strong**
\`\`\`
## Archive
- [x] Archived task
  archived note
### Archived child
- [ ] Archived nested
# Next
`

const lineContaining = (text: string, value: string) => {
  const document = classifyDocument(text)
  const line = document.lines.find((entry) => text.slice(entry.from, entry.to).includes(value))
  if (!line) throw new Error(`Missing line ${value}`)
  return line
}

const lineExactly = (text: string, value: string) => {
  const document = classifyDocument(text)
  const line = document.lines.find((entry) => text.slice(entry.from, entry.to) === value)
  if (!line) throw new Error(`Missing exact line ${value}`)
  return line
}

const slices = (text: string, spans: ReadonlyArray<{ from: number; to: number }>) =>
  spans.map((span) => text.slice(span.from, span.to))

describe('PlainTasks line classification', () => {
  test('classifies tasks, owners, inline spans, fences, and archives', () => {
    const document = classifyDocument(source)
    const task = lineContaining(source, '- [ ] First task')
    const status = lineContaining(source, '- **t3** M, planning')
    const note = lineContaining(source, 'note for first')
    const intro = lineContaining(source, 'Intro **bold**')
    const fence = lineContaining(source, '```md')
    const code = lineContaining(source, 'not a task')
    const uppercase = lineContaining(source, 'Upper task')
    const cancelled = lineContaining(source, 'Cancelled task')
    const nested = lineContaining(source, 'Nested task')
    const empty = lineExactly(source, '- [ ] ')
    const archiveTask = lineContaining(source, 'Archived task')
    const archiveNote = lineContaining(source, 'archived note')

    expect(document.lines.map((line) => line.kind)).toContain('project')
    expect(task.kind).toBe('task')
    expect(task.state).toBe('open')
    expect(task.bullet && source.slice(task.bullet.from, task.bullet.to)).toBe('- ')
    expect(task.checkbox && source.slice(task.checkbox.from, task.checkbox.to)).toBe('[ ]')
    expect(task.label && source.slice(task.label.from, task.label.to)).toBe('First task')

    expect(status.kind).toBe('status')
    expect(status.owner).toBe(task.index)
    expect(status.bullet && source.slice(status.bullet.from, status.bullet.to)).toBe('- ')
    expect(status.label && source.slice(status.label.from, status.label.to)).toBe('**t3** M, planning')
    expect(slices(source, status.inline)).toEqual(['**', 't3', '**'])
    expect(status.inline.map((span) => span.kind)).toEqual(['strongMark', 'strong', 'strongMark'])

    expect(note.kind).toBe('note')
    expect(note.owner).toBe(task.index)
    expect(note.label && source.slice(note.label.from, note.label.to)).toBe('note for first')
    expect(uppercase.kind).toBe('task')
    expect(uppercase.state).toBe('done')
    expect(cancelled.kind).toBe('task')
    expect(cancelled.state).toBe('cancelled')
    expect(nested.kind).toBe('task')
    expect(nested.state).toBe('open')
    expect(empty.kind).toBe('task')
    expect(empty.label && source.slice(empty.label.from, empty.label.to)).toBe('')

    expect(intro.kind).toBe('prose')
    expect(intro.inline.map((span) => span.kind)).toContain('code')
    expect(intro.inline.map((span) => span.kind)).toContain('link')
    expect(intro.inline.every((span, index, spans) => index === 0 || span.from >= spans[index - 1]!.to)).toBe(true)

    const project = lineContaining(source, '# Roadmap')
    expect(project.marks && source.slice(project.marks.from, project.marks.to)).toBe('# ')
    expect(project.label && source.slice(project.label.from, project.label.to)).toBe('Roadmap')
    expect(project.level).toBe(1)
    expect(document.projects).toEqual([
      { title: 'Roadmap', level: 1, line: project.index, from: project.label!.from },
      { title: 'Tasks', level: 2, line: lineContaining(source, '## Tasks').index, from: lineContaining(source, '## Tasks').label!.from },
      { title: 'Archive', level: 2, line: lineContaining(source, '## Archive').index, from: lineContaining(source, '## Archive').label!.from },
      { title: 'Archived child', level: 3, line: lineContaining(source, '### Archived child').index, from: lineContaining(source, '### Archived child').label!.from },
      { title: 'Next', level: 1, line: lineContaining(source, '# Next').index, from: lineContaining(source, '# Next').label!.from },
    ])

    expect(fence.kind).toBe('fence')
    expect(code.kind).toBe('code')
    expect(code.inline).toEqual([])
    expect(lineContaining(source, '> quoted prose').kind).toBe('quote')
    expect(lineContaining(source, '---').kind).toBe('rule')

    expect(archiveTask.archived).toBe(true)
    expect(archiveNote.archived).toBe(true)
    expect(lineContaining(source, '## Archive').archived).toBe(true)
    expect(task.archived).toBe(false)
    expect(document.stats).toEqual({ done: 2, cancelled: 1, open: 4, total: 7 })
    expect(formatStats(document.stats)).toBe('3/7 done')
  })

  test('handles CRLF without including carriage returns in line spans', () => {
    const text = '- [ ] first\r\nsecond\r\n'
    const document = classifyDocument(text)
    expect(document.lines.map((line) => [line.from, line.to, text.slice(line.from, line.to)])).toEqual([
      [0, 11, '- [ ] first'],
      [13, 19, 'second'],
      [21, 21, ''],
    ])
  })

  test('finds each supported link form and misses ordinary text', () => {
    const bare = source.indexOf('https://example.com/docs') + 5
    const markdown = source.indexOf('[guide]') + 2
    const angle = source.indexOf('<mailto:') + 3
    const slug = source.indexOf('[tasks]') + 4
    expect(linkAt(source, bare)).toBe('https://example.com/docs')
    expect(linkAt(source, markdown)).toBe('https://example.com/guide')
    expect(linkAt(source, angle)).toBe('mailto:team@example.com')
    expect(linkAt(source, slug)).toBe('#tasks')
    expect(linkAt(source, source.indexOf('Roadmap'))).toBeUndefined()
  })
})
