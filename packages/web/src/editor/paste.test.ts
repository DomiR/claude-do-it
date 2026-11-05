import { describe, expect, test } from 'bun:test'

import { clipboardMarkdown, htmlToMarkdown, looksLikeMarkdown, normalizeMarkdown } from './paste'

describe('normalizing pasted Markdown', () => {
  test('every spelling of a task becomes the todo form, its state kept', () => {
    expect(normalizeMarkdown([
      '- [ ] open', '* [ ] star', '+ [ ] plus', '[ ] bare', '[] empty', '- [x] done', '* [X] upper', '- [-] cancelled',
    ].join('\n'))).toBe([
      '- [ ] open', '- [ ] star', '- [ ] plus', '- [ ] bare', '- [ ] empty', '- [x] done', '- [x] upper', '- [-] cancelled',
    ].join('\n'))
  })

  test('box symbols and other bullets become tasks and dashes', () => {
    expect(normalizeMarkdown('☐ open\n✔ done\n✘ cancelled\n* star\n+ plus\n• dot')).toBe(
      '- [ ] open\n- [x] done\n- [-] cancelled\n- star\n- plus\n- dot',
    )
  })

  test('indentation is kept relative to the shallowest line, tabs counting as four spaces', () => {
    expect(normalizeMarkdown('    * [ ] parent\n        * [ ] child\n\t\t\t- [x] grandchild')).toBe(
      '- [ ] parent\n    - [ ] child\n        - [x] grandchild',
    )
  })

  test('escaped Markdown is unescaped', () => {
    expect(normalizeMarkdown('\\- \\[ \\] Ship it\n\\- \\[x\\] Done \\*now\\*')).toBe('- [ ] Ship it\n- [x] Done *now*')
    expect(normalizeMarkdown('- \\[ \\] Ship it')).toBe('- [ ] Ship it')
  })

  test('only a line that starts with an escaped block prefix is unescaped, never inline code or other lines', () => {
    expect(normalizeMarkdown('\\- \\[ \\] Ship \\*it\\* `a\\*b` 1\\. \\(x\\)!\ngrep \'\\[x\\]\' TODO.md'))
      .toBe('- [ ] Ship *it* `a\\*b` 1\\. \\(x\\)!\ngrep \'\\[x\\]\' TODO.md')
    expect(normalizeMarkdown('```\n\\- \\[ \\] literal\n```\n\\- \\[ \\] task')).toBe('```\n\\- \\[ \\] literal\n```\n- [ ] task')
    expect(clipboardMarkdown("grep '\\[x\\]' TODO.md")).toBeNull()
  })

  test('todo source passes unchanged', () => {
    const source = '# Project\n\n- [ ] Ship **it** @started(26-11-05 10:00)\n  - **t1** planning\n    a note\n- [x] Done @done(26-11-05 11:00)\n> quote'
    expect(normalizeMarkdown(source)).toBe(source)
  })

  test('fenced code is left alone', () => {
    expect(normalizeMarkdown('* [ ] task\n```\n* [ ] literal\n```')).toBe('- [ ] task\n```\n* [ ] literal\n```')
  })

  test('Windows line endings become newlines', () => {
    expect(normalizeMarkdown('* [ ] one\r\n* [ ] two')).toBe('- [ ] one\n- [ ] two')
  })
})

describe('recognizing Markdown', () => {
  test('block prefixes, inline styles, links, and escapes count', () => {
    for (const text of ['- [ ] task', 'intro\n* item', '## Heading', '> quote', '[] bare', 'some **bold**', 'a [link](https://x.dev)', '\\[ \\] escaped']) {
      expect(looksLikeMarkdown(text)).toBe(true)
    }
  })

  test('plain prose does not', () => {
    for (const text of ['hello world', 'snake_case_name and a*b', '1. numbered', '#hashtag', 'line one\nline two']) {
      expect(looksLikeMarkdown(text)).toBe(false)
    }
  })
})

describe('converting a rich text copy', () => {
  test('a task list with checkboxes and nesting', () => {
    const html = '<ul class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> Plan\n' +
      '<ul>\n<li class="task-list-item"><input type="checkbox" checked="" disabled> Draft</li>\n</ul>\n</li>\n' +
      '<li>Plain <strong>bold</strong> and <a href="https://example.com/a b">a link</a></li>\n</ul>'
    expect(htmlToMarkdown(html)).toBe('- [ ] Plan\n    - [x] Draft\n- Plain **bold** and [a link](https://example.com/a%20b)')
  })

  test('headings, quotes, emphasis, strike, and code', () => {
    expect(htmlToMarkdown('<h2>Plan</h2><p>Some <em>italic</em>, <del>gone</del> and <code>x()</code></p><blockquote><p>quoted</p></blockquote>'))
      .toBe('## Plan\nSome *italic*, ~~gone~~ and `x()`\n> quoted')
  })

  test('marks never span lines and wrap only their text', () => {
    expect(htmlToMarkdown('<p><b> one<br>two </b>three</p>')).toBe('**one**\n**two** three')
  })

  test('the Google Docs wrapper is not bold and the fragment markers frame the copy', () => {
    const html = '<html><body><!--StartFragment--><meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">' +
      '<p dir="ltr"><span>First</span></p><ul><li dir="ltr"><p><span>Item</span></p></li></ul></b><!--EndFragment--></body></html>'
    expect(htmlToMarkdown(html)).toBe('First\n- Item')
  })

  test('a web page copy keeps entities, image alt text, and table cells', () => {
    const html = '<p>It&rsquo;s <a href="https://x.dev">here</a> &hellip; caf&eacute; &amp; &Uuml;ber <img src="d.png" alt="the diagram"></p>' +
      '<table><tr><td>a</td><td>b</td></tr><tr><th>c</th><td>d&nbsp;e</td></tr></table>'
    expect(htmlToMarkdown(html)).toBe('It\u2019s [here](https://x.dev) \u2026 caf\u00e9 & \u00dcber the diagram\na b\nc d e')
    expect(htmlToMarkdown('<b>&constructor; &unknown;</b>')).toBe('**&constructor; &unknown;**')
  })

  test('scripts, styles, and links without a web target drop out', () => {
    expect(htmlToMarkdown('<style>p { color: red }</style><p><a href="javascript:alert(1)">click</a> &amp; <a>bare</a></p>')).toBe('click & bare')
  })
})

describe('choosing what to paste', () => {
  test('plain Markdown wins over the rich copy', () => {
    expect(clipboardMarkdown('* [ ] one', '<ul><li>one</li></ul>')).toBe('- [ ] one')
  })

  test('a rich copy fills in what its plain text lost', () => {
    expect(clipboardMarkdown('Plan\nDraft', '<ul><li><input type="checkbox"> Plan</li><li><input type="checkbox" checked> Draft</li></ul>'))
      .toBe('- [ ] Plan\n- [x] Draft')
  })

  test('plain prose without structure is left to the editor', () => {
    expect(clipboardMarkdown('hello world')).toBeNull()
    expect(clipboardMarkdown('hello world', '<span style="color: red">hello world</span>')).toBeNull()
  })
})
