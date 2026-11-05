import { describe, expect, test } from 'bun:test'
import { blockEnd, lines } from '@do-it/doc/text'

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
    expect(document.stats).toEqual({ done: 2, cancelled: 1, open: 3, total: 6 })
    expect(formatStats(document.stats)).toBe('3/6 done')
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

  test('computes every live preview field on the todo fixture', () => {
    const document = classifyDocument(source)
    const task = lineContaining(source, 'First task')
    const status = lineContaining(source, '**t3**')
    const note = lineContaining(source, 'note for first')
    const empty = lineExactly(source, '- [ ] ')
    const heading = document.lines[0]!
    const quote = lineContaining(source, '> quoted prose')
    expect(slices(source, task.alwaysHidden)).toEqual(['- '])
    expect(task.previewHidden).toEqual([])
    expect(task.hang).toBe(4)
    expect(task.empty).toBe(false)
    expect(task.dot).toBeUndefined()
    expect(status.alwaysHidden).toEqual([])
    expect(slices(source, [status.hiddenBullet!])).toEqual(['- '])
    expect(slices(source, status.previewHidden)).toEqual(['**', '**'])
    expect(status.hang).toBe(4)
    expect(status.empty).toBe(false)
    expect(status.dot).toBeUndefined()
    expect(note.hang).toBe(2)
    expect(note.alwaysHidden).toEqual([])
    expect(note.previewHidden).toEqual([])
    expect(empty.empty).toBe(true)
    expect(empty.hang).toBe(4)
    expect(slices(source, empty.alwaysHidden)).toEqual(['- '])
    expect(slices(source, heading.previewHidden)).toEqual(['# '])
    expect(heading.hang).toBe(0)
    expect(heading.alwaysHidden).toEqual([])
    expect(quote.quoteMark && source.slice(quote.quoteMark.from, quote.quoteMark.to)).toBe('> ')
    expect(quote.previewHidden).toEqual([quote.quoteMark!])
    expect(slices(source, lineContaining(source, 'Intro **bold**').previewHidden)).toEqual([
      '**', '**', '`', '`', '[', '](https://example.com/guide)', '<', '>', '[', '](#tasks)',
    ])
    for (const line of document.lines) {
      expect(typeof line.empty).toBe('boolean')
      expect(typeof line.hang).toBe('number')
      for (const span of [...line.alwaysHidden, ...line.previewHidden]) {
        expect(span.from).toBeGreaterThanOrEqual(line.from)
        expect(span.to).toBeLessThanOrEqual(line.to)
        expect(span.from).toBeLessThan(span.to)
        expect(source.slice(span.from, span.to)).not.toContain('\n')
        if (line.checkbox) expect(span.to <= line.checkbox.from || span.from >= line.checkbox.to).toBe(true)
      }
    }
  })

  test('uses tab stops for hanging indents and only replaces unordered prose bullets', () => {
    const text = '# Tasks\n \t- [ ] Parent\n \t  - **agent** planning\n \t  note\n  \t\t- [ ] Nested\n- list\n* other\n+ last\n1. ordered\n>quote'
    const parent = lineContaining(text, 'Parent')
    const status = lineContaining(text, '**agent**')
    const note = lineContaining(text, 'note')
    expect(parent.depth).toBe(5)
    expect(parent.hang).toBe(8)
    expect(status.hang).toBe(8)
    expect(status.owner).toBe(parent.index)
    expect(note.hang).toBe(6)
    expect(note.owner).toBe(parent.index)
    expect(lineContaining(text, 'Nested').hang).toBe(12)
    for (const value of ['- list', '* other', '+ last']) {
      const line = lineExactly(text, value)
      expect(line.kind).toBe('prose')
      expect(line.dot).toEqual({ from: line.from, to: line.from + 1 })
      expect(line.alwaysHidden).toEqual([])
      expect(line.previewHidden).toEqual([])
    }
    expect(lineContaining(text, 'ordered').dot).toBeUndefined()
    const quote = lineContaining(text, '>quote')
    expect(slices(text, quote.previewHidden)).toEqual(['>'])
  })

  test('recognizes flanking single stars and underscores, strong, strike, code and link delimiters', () => {
    const text = 'snake_case _literal_ 2*3*4 a*b*c *a* **b** ~~c~~ __d__ `e` [guide](#tasks) <https://example.com> https://bare.example'
    const line = classifyDocument(text).lines[0]!
    expect(line.inline.map(span => [span.kind, text.slice(span.from, span.to)])).toEqual([
      ['emMark', '_'], ['em', 'literal'], ['emMark', '_'],
      ['emMark', '*'], ['em', 'a'], ['emMark', '*'],
      ['strongMark', '**'], ['strong', 'b'], ['strongMark', '**'],
      ['strikeMark', '~~'], ['strike', 'c'], ['strikeMark', '~~'],
      ['strongMark', '__'], ['strong', 'd'], ['strongMark', '__'],
      ['codeMark', '`'], ['code', 'e'], ['codeMark', '`'],
      ['linkMark', '['], ['link', 'guide'], ['linkMark', '](#tasks)'],
      ['linkMark', '<'], ['link', 'https://example.com'], ['linkMark', '>'],
      ['link', 'https://bare.example'],
    ])
    expect(line.inline.every((span, index) => span.from < span.to && (index === 0 || span.from >= line.inline[index - 1]!.to))).toBe(true)
    for (const literal of ['* a*', '*a *', 'a*b*c', '2*3*4', 'é*a*é', 'snake_case', 'a_b_c', '_ a_']) {
      expect(classifyDocument(literal).lines[0]!.inline).toEqual([])
    }
    for (const emphasized of ['*a*', '(*a*)', '*two words*', '*é*', '_a_', '(_two words_)']) {
      expect(classifyDocument(emphasized).lines[0]!.inline.map(span => span.kind)).toEqual(['emMark', 'em', 'emMark'])
    }
  })

  test('classifies PlainTasks tags, lowercases names, and excludes protected text', () => {
    const text = '@today @HIGH @low @critical @started(26-11-04 21:32) @done (26-11-04 21:32) @project(Tasks) @waiting (custom) **@bold**\n'
      + 'email a@b.c `@code` [link](@target)\n```\n@fenced\n```'
    const document = classifyDocument(text)
    const first = document.lines[0]!
    const tags = first.inline.filter(span => span.kind === 'tag')
    expect(tags.map(span => text.slice(span.from, span.to))).toEqual([
      '@today', '@HIGH', '@low', '@critical', '@started(26-11-04 21:32)', '@done (26-11-04 21:32)',
      '@project(Tasks)', '@waiting (custom)',
    ])
    expect(tags.map(span => span.name)).toEqual([
      'today', 'high', 'low', 'critical', 'started', 'done', 'project', 'waiting',
    ])
    expect(first.inline.some(span => span.kind === 'tag' && text.slice(span.from, span.to) === '@bold')).toBe(false)
    expect(first.inline.some(span => span.kind === 'strong' && text.slice(span.from, span.to) === '@bold')).toBe(true)
    expect(document.lines[1]!.inline.some(span => span.kind === 'tag')).toBe(false)
    expect(document.lines[2]!.inline).toEqual([])
    expect(document.lines[3]!.kind).toBe('code')
    expect(document.lines[3]!.inline).toEqual([])
    expect(first.inline.every((span, index) => index === 0 || span.from >= first.inline[index - 1]!.to)).toBe(true)
  })

  test('keeps link targets available over hidden syntax but not code', () => {
    const text = '[guide](#tasks) <mailto:team@example.com> `https://code.example`\n```\nhttps://fenced.example\n```'
    for (let offset = 0; offset < '[guide](#tasks)'.length; offset += 1) expect(linkAt(text, offset)).toBe('#tasks')
    const start = text.indexOf('<')
    const end = text.indexOf('>')
    for (let offset = start; offset <= end; offset += 1) expect(linkAt(text, offset)).toBe('mailto:team@example.com')
    expect(linkAt(text, text.indexOf('https://code'))).toBeUndefined()
    expect(linkAt(text, text.indexOf('https://fenced'))).toBeUndefined()
  })

  test('excludes every blank task state from statistics, including whitespace labels', () => {
    const text = '- [ ]\n- [x] \t \n- [-]   \n- [X] Done\n- [ ] Open\n## Archive\n- [x] Archived'
    const document = classifyDocument(text)
    expect(document.lines.slice(0, 3).map(line => line.empty)).toEqual([true, true, true])
    expect(document.stats).toEqual({ done: 1, cancelled: 0, open: 1, total: 2 })
  })

  test('tracks nested owners with the shared block boundaries, blanks and fences', () => {
    const text = '- [ ] Root\n  - [ ] Child\n\n    - child status\n    child note\n  - parent status\n\n  parent note\n\nOutside\n  orphan\n- [ ] Next\n  ```\n  - [ ] code\n  ```\n  next note\n  ## Heading\n    heading prose\n'
    const parsed = lines(text)
    const classified = classifyDocument(text)
    for (const line of classified.lines) {
      let expected: number | undefined
      for (let index = 0; index < line.index; index += 1) {
        const candidate = parsed[index]!
        if (candidate.state !== undefined && candidate.depth < line.depth && line.index < blockEnd(parsed, index)) expected = index
      }
      if (line.kind === 'status' || line.kind === 'note') expect(line.owner).toBe(expected)
      else expect(line.owner).toBeUndefined()
      if (expected !== undefined && parsed[line.index]!.kind === 'paragraph') expect(line.kind).toBe('note')
    }
    expect(lineContaining(text, 'orphan').kind).toBe('prose')
    expect(lineContaining(text, 'heading prose').kind).toBe('prose')
  })
})
