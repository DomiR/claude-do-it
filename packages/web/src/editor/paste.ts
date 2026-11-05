/**
 * Pasted Markdown becomes todo source that renders at once: every spelling
 * of a task becomes `- [ ]`, `- [x]` or `- [-]`, other bullets become `- `,
 * escaped Markdown is unescaped, and a rich text copy (HTML) is converted to
 * Markdown when its plain text has lost the structure.
 */

const TASK_STATES: Record<string, string> = { '': ' ', ' ': ' ', x: 'x', X: 'x', '-': '-' }
const OPEN_SYMBOL = /^(?:☐|□|❑|❒|⬜|▢)[ \t]+/u
const DONE_SYMBOL = /^(?:✔|✓|☑|✅)[ \t]+/u
const CANCELLED_SYMBOL = /^(?:✘|✗|☒)[ \t]+/u
const BULLET_SYMBOL = /^[*+•◦▪‣∙●○][ \t]+/u
const TASK = /^(?:[-*+•][ \t]+)?\[([ xX-]?)\](?:[ \t]+|$)/u
const NESTING = '    '

const blockLine = /^[ \t]*(?:[-*+•◦▪‣∙●○][ \t]|#{1,6}[ \t]|>|\[[ xX-]?\](?:[ \t]|$)|(?:☐|□|❑|❒|⬜|▢|✔|✓|☑|✅|✘|✗|☒)[ \t])/u
const inlineMarkdown = /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]*\]\([^)\s]+\)|(?:^|[\s(])[*_][^\s*_][^\n]*?[*_](?=$|[\s).,;:!?])/m
const escapedMarkdown = /\\[[\]*_#+\-~`>]/
const escapedBlock = /\\\[[ xX-]?\\\]|^[ \t]*\\[-*+#>]/m

/** Whether text is Markdown worth handling: block prefixes on a line, or inline styles and links. */
export const looksLikeMarkdown = (text: string): boolean =>
  text.split('\n').some(line => blockLine.test(line)) || inlineMarkdown.test(text) || escapedMarkdown.test(text)

/** A pasted line that starts a block of its own: a task, a bullet, a heading, or a quote. */
export const startsBlock = (line: string): boolean => /^[ \t]*(?:- \[[ x-]\](?:[ \t]|$)|- |#{1,6}(?:[ \t]|$)|>)/.test(line)

const unescape = (text: string): string => text.replace(/\\([[\]*_#+\-~`>.!()])/g, '$1')

/** One line in todo form, its indentation kept. */
const normalizeLine = (line: string): string => {
  const [, lead = '', body = ''] = /^([ \t]*)([\s\S]*)$/.exec(line) ?? []
  const task = TASK.exec(body)
  if (task) return `${lead}- [${TASK_STATES[task[1]!]}] ${body.slice(task[0].length)}`
  if (OPEN_SYMBOL.test(body)) return lead + body.replace(OPEN_SYMBOL, '- [ ] ')
  if (DONE_SYMBOL.test(body)) return lead + body.replace(DONE_SYMBOL, '- [x] ')
  if (CANCELLED_SYMBOL.test(body)) return lead + body.replace(CANCELLED_SYMBOL, '- [-] ')
  if (BULLET_SYMBOL.test(body)) return lead + body.replace(BULLET_SYMBOL, '- ')
  return line
}

const leadingSpaces = (line: string): number => /^ */.exec(line)![0].length

/**
 * Pasted lines in todo form. Leading tabs count as four spaces and the
 * indentation every line shares is removed, so nesting is relative to the
 * line the paste lands on.
 */
export const normalizeMarkdown = (text: string): string => {
  let source = text.replace(/\r\n?/g, '\n')
  if (escapedBlock.test(source)) source = unescape(source)
  const lines = source.split('\n').map(line => line.replace(/^[ \t]+/, lead => lead.replace(/\t/g, NESTING)))
  const indents = lines.filter(line => line.trim()).map(leadingSpaces)
  const shared = indents.length ? Math.min(...indents) : 0
  let fenced = false
  return lines.map(line => {
    const relative = line.trim() ? line.slice(shared) : ''
    if (/^[ \t]*(?:```|~~~)/.test(relative)) { fenced = !fenced; return relative }
    return fenced ? relative : normalizeLine(relative)
  }).join('\n')
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
  if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match
  const code = entity[1]!.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
  return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match
})

const structural = /<(?:li|h[1-6]|blockquote|strong|b|em|i|code|del|s|strike|a\s[^>]*href)\b|<input[^>]*checkbox/i

/** Whether a rich text copy carries structure that its plain text loses. */
export const hasStructure = (html: string): boolean => structural.test(html)

interface Inline {
  readonly tag: string
  readonly open: string
  readonly close: string
  /** Whether the opening mark is written on the current line. */
  written: boolean
}

const blockTags = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'tr', 'table', 'dt', 'dd'])
const hiddenTags = new Set(['style', 'script', 'head', 'title', 'template'])

/**
 * Markdown for an HTML clipboard fragment: lists and task lists (nested by
 * four spaces), headings, quotes, links, and inline styles. Inline marks open
 * at their first text and close on every line they reach, so no line keeps a
 * lone `**`.
 */
export const htmlToMarkdown = (html: string): string => {
  const fragment = html.replace(/^[\s\S]*?<!--StartFragment-->/, '').replace(/<!--EndFragment-->[\s\S]*$/, '')
  const output: string[] = []
  const lists: Array<{ ordered: boolean; count: number }> = []
  const inline: Inline[] = []
  let line = ''
  let marker = ''
  let pre = false
  let hidden = 0
  let quote = 0
  let item = ''
  const closeInline = () => {
    for (let index = inline.length - 1; index >= 0; index--) {
      const mark = inline[index]!
      if (!mark.written) continue
      const trailing = /[ \t]*$/.exec(line)![0]
      line = line.slice(0, line.length - trailing.length) + mark.close + trailing
      mark.written = false
    }
  }
  const flush = () => {
    closeInline()
    if (line.trim() && line !== marker) output.push(line.replace(/[ \t]+$/, ''))
    line = ''
    marker = ''
  }
  const begin = (prefix: string) => { flush(); line = prefix; marker = prefix }
  const append = (raw: string) => {
    let text = raw
    if (line === marker || /[ \t]$/.test(line)) text = text.replace(/^[ \t]+/, '')
    if (!text) return
    if (line === '' && quote > 0) { line = '> '; marker = line }
    const space = /^[ \t]*/.exec(text)![0]
    const opening = inline.filter(mark => !mark.written).map(mark => { mark.written = true; return mark.open }).join('')
    line += space + opening + text.slice(space.length)
  }
  const open = (tag: string, opening = '', closing = opening) => inline.push({ tag, open: opening, close: closing, written: false })
  const close = (tag: string) => {
    const index = inline.findLastIndex(mark => mark.tag === tag)
    if (index < 0) return
    const [mark] = inline.splice(index, 1)
    if (!mark?.written) return
    const trailing = /[ \t]*$/.exec(line)![0]
    line = line.slice(0, line.length - trailing.length) + mark.close + trailing
  }
  for (const token of fragment.split(/(<[^>]*>)/)) {
    if (!token) continue
    if (!token.startsWith('<')) {
      if (hidden > 0) continue
      const text = decode(token)
      if (pre) text.split('\n').forEach((part, index) => { if (index > 0) flush(); line += part })
      else append(text.replace(/\s+/g, ' '))
      continue
    }
    const tag = /^<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/.exec(token)
    if (!tag) continue
    const closing = tag[1] === '/'
    const name = tag[2]!.toLowerCase()
    const attributes = tag[3] ?? ''
    if (hiddenTags.has(name)) { hidden = Math.max(0, hidden + (closing ? -1 : 1)); continue }
    if (hidden > 0) continue
    if (blockTags.has(name)) { if (line !== marker) flush(); continue }
    switch (name) {
      case 'br':
        flush()
        if (lists.length) { line = item; marker = item }
        break
      case 'blockquote': flush(); quote = Math.max(0, quote + (closing ? -1 : 1)); break
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        if (closing) flush(); else begin(`${'#'.repeat(Number(name[1]))} `)
        break
      case 'ul': case 'ol':
        flush()
        if (closing) lists.pop(); else lists.push({ ordered: name === 'ol', count: 0 })
        break
      case 'li': {
        if (closing) { flush(); break }
        const list = lists[lists.length - 1]
        const indent = NESTING.repeat(Math.max(0, lists.length - 1))
        item = indent + NESTING
        begin(`${indent}${list?.ordered ? `${++list.count}. ` : '- '}`)
        break
      }
      case 'input':
        if (!closing && /type\s*=\s*["']?checkbox/i.test(attributes)) append(`[${/(?:^|\s)checked\b/i.test(attributes) ? 'x' : ' '}] `)
        break
      case 'strong': case 'b':
        // Google Docs wraps a whole copy in a `<b>` that is not bold.
        if (closing) close('b'); else open('b', /font-weight\s*:\s*(?:normal|[1-5]00)\b/i.test(attributes) ? '' : '**')
        break
      case 'em': case 'i': if (closing) close('i'); else open('i', '*'); break
      case 'del': case 's': case 'strike': if (closing) close('s'); else open('s', '~~'); break
      case 'code': if (pre) break; if (closing) close('code'); else open('code', '`'); break
      case 'pre': flush(); pre = !closing; break
      case 'td': case 'th': if (closing) append(' '); break
      case 'a': {
        if (closing) { close('a'); break }
        const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes)
        const target = href ? decode(href[1] ?? href[2] ?? href[3] ?? '').trim() : ''
        if (/^(?:https?:|mailto:)/i.test(target)) open('a', '[', `](${target.replace(/[\s()]/g, encodeURIComponent)})`)
        else open('a')
        break
      }
    }
  }
  flush()
  return output.join('\n')
}

/**
 * The Markdown to paste, or null to leave the paste to the editor. Plain
 * text that already is Markdown wins; otherwise a structured rich text copy
 * is converted.
 */
export const clipboardMarkdown = (plain: string, html?: string): string | null => {
  const text = plain.replace(/\r\n?/g, '\n')
  if (text && looksLikeMarkdown(text)) return normalizeMarkdown(text)
  if (html && hasStructure(html)) {
    const converted = htmlToMarkdown(html)
    if (converted.trim()) return normalizeMarkdown(converted)
  }
  return null
}
