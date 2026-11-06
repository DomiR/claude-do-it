import { describe, expect, test } from 'bun:test';
import { lines, sections, todos } from '@do-it/doc/text';

import { scanBlocks, type SourceSpan } from './blocks';

const scan = (text: string) => scanBlocks(text, lines(text));
const slice = (text: string, span: SourceSpan) => text.slice(span.from, span.to);

describe('details blocks', () => {
	test('reads one-line headers and exact delimiter spans', () => {
		const text = '  <details><summary>Title</summary>\n  first\n\n  last\n</details>\nnext';
		const result = scan(text);
		expect(result.details).toHaveLength(1);
		const block = result.details[0]!;
		expect(block).toMatchObject({
			from: 0,
			to: text.indexOf('\nnext'),
			startLine: 0,
			endLine: 5,
			summaryLine: 0,
			initiallyOpen: false
		});
		expect(block.parent).toBeUndefined();
		expect(block.explicitId).toBeUndefined();
		expect(slice(text, block.title)).toBe('Title');
		expect(slice(text, block.body)).toBe('  first\n\n  last\n');
		expect(slice(text, block.close)).toBe('</details>');
		expect(block.delimiters.map((span) => slice(text, span))).toEqual([
			'<details>',
			'<summary>',
			'</summary>',
			'</details>'
		]);
		expect(result.byLine.map((line) => line?.role)).toEqual([
			'details-summary',
			undefined,
			undefined,
			undefined,
			'details-close',
			undefined
		]);
		expect(result.byLine[0]).toEqual({ role: 'details-summary', block: 0, title: block.title });
		expect(result.diagnostics).toEqual([]);
	});

	test('reads two-line headers and closers at any indentation', () => {
		const text = "\t<details id='two'> \n    <summary>Title</summary> \nbody\n   </details>  ";
		const result = scan(text);
		const block = result.details[0]!;
		expect(block).toMatchObject({ startLine: 0, endLine: 4, summaryLine: 1, explicitId: 'two', initiallyOpen: false });
		expect(slice(text, block.title)).toBe('Title');
		expect(slice(text, block.body)).toBe('body\n');
		expect(slice(text, block.close)).toBe('   </details>  ');
		expect(block.delimiters.map((span) => slice(text, span))).toEqual([
			"<details id='two'>",
			'<summary>',
			'</summary>',
			'</details>'
		]);
		expect(result.byLine.map((line) => line?.role)).toEqual([
			'details-open',
			'details-summary',
			undefined,
			'details-close'
		]);
	});

	test('accepts boolean open and quoted ids in either order', () => {
		const cases: ReadonlyArray<readonly [string, boolean, string | undefined]> = [
			['', false, undefined],
			[' open', true, undefined],
			[' id="first" open', true, 'first'],
			[" open id='second'", true, 'second'],
			[' open=""', true, undefined],
			[' open="false"', true, undefined],
			[' open=false', true, undefined],
			[' id="quoted > value"', false, 'quoted > value'],
			["\tid = 'spaced'\topen\t", true, 'spaced']
		];
		for (const [attributes, initiallyOpen, explicitId] of cases) {
			const result = scan(`<details${attributes}><summary>T</summary>\n</details>`);
			expect(result.details).toHaveLength(1);
			expect(result.details[0]!.initiallyOpen).toBe(initiallyOpen);
			expect(result.details[0]!.explicitId).toBe(explicitId);
			expect(result.diagnostics).toEqual([]);
		}
	});

	test('matches nested and adjacent details in source order', () => {
		const text = [
			'<details><summary>Outer</summary>',
			'    <details open><summary>Inner</summary>',
			'  <details><summary>Deep</summary>',
			'</details>',
			'      </details>',
			' <details><summary>Sibling</summary>',
			' </details>',
			'</details>'
		].join('\n');
		const result = scan(text);
		expect(
			result.details.map((block) => [slice(text, block.title), block.startLine, block.endLine, block.parent])
		).toEqual([
			['Outer', 0, 8, undefined],
			['Inner', 1, 5, 0],
			['Deep', 2, 4, 1],
			['Sibling', 5, 7, 0]
		]);
		expect(result.byLine[3]).toEqual({ role: 'details-close', block: 2 });
		expect(result.byLine[4]).toEqual({ role: 'details-close', block: 1 });
		expect(result.diagnostics).toEqual([]);
	});

	test('keeps empty bodies and UTF-16 spans with CRLF', () => {
		const text = '😀 intro\r\n\t<details>\r\n\t<summary>中🙂</summary>\r\n</details>\r\n';
		const result = scan(text);
		const block = result.details[0]!;
		expect(block.from).toBe('😀 intro\r\n'.length);
		expect(block.title).toEqual({ from: text.indexOf('中'), to: text.indexOf('中') + '中🙂'.length });
		expect(block.body).toEqual({ from: text.indexOf('</details>'), to: text.indexOf('</details>') });
		expect(block.to).toBe(text.length - 2);
		expect(block.delimiters.every((span) => !slice(text, span).includes('\r'))).toBe(true);
		const empty = scan('<details><summary></summary>\n</details>').details[0]!;
		expect(empty.title.from).toBe(empty.title.to);
		expect(empty.body.from).toBe(empty.body.to);
		expect(result.byLine).toHaveLength(lines(text).length);
	});

	test('ignores details and summaries inside every fence', () => {
		for (const fence of ['```md', '```html', '```html do-it', '~~~html do-it']) {
			const closing = fence.slice(0, 3);
			const text = [
				'<details><summary>Outer</summary>',
				fence,
				'</details>',
				'<details><summary>Fake</summary>',
				'<summary>Stray</summary>',
				closing,
				'</details>'
			].join('\n');
			const result = scan(text);
			expect(result.details).toHaveLength(1);
			expect(result.details[0]!.endLine).toBe(7);
			expect(result.diagnostics).toEqual([]);
		}
	});

	test('reports unmatched delimiters without claiming their body', () => {
		const text = [
			'</details>',
			'<summary>Stray</summary>',
			'<details>',
			'<summary>Unclosed</summary>',
			'visible body',
			'<details><summary>Complete child</summary>',
			'child body',
			'</details>',
			'visible tail'
		].join('\n');
		const result = scan(text);
		expect(result.diagnostics.map((value) => [value.line, value.reason])).toEqual([
			[0, 'unmatched-close'],
			[1, 'unmatched-summary'],
			[2, 'unmatched-open'],
			[3, 'unmatched-open']
		]);
		expect(result.details).toHaveLength(1);
		expect(result.details[0]).toMatchObject({ startLine: 5, endLine: 8 });
		expect(result.details[0]!.parent).toBeUndefined();
		expect(result.byLine[4]).toBeUndefined();
		expect(result.byLine[8]).toBeUndefined();
		for (const index of [0, 1, 2, 3]) expect(result.byLine[index]).toEqual({ role: 'diagnostic' });
	});

	test('keeps malformed headers and nonstandalone tags literal', () => {
		for (const header of [
			'<details id=unquoted><summary>T</summary>',
			'<details open open><summary>T</summary>',
			'<details id="a" id="b"><summary>T</summary>',
			'<details class="unsupported"><summary>T</summary>',
			'<details>\n\n<summary>Not adjacent</summary>',
			'<details><summary>Missing end',
			'<details><summary>Title</summary> extra',
			'<details><summary>A<summary>B</summary></summary>'
		]) {
			const result = scan(`${header}\nbody\n</details>`);
			expect(result.details).toEqual([]);
			expect(result.diagnostics.length).toBeGreaterThan(0);
			expect(result.byLine.filter((line) => line && line.role !== 'diagnostic')).toEqual([]);
		}
		expect(scan('prose <details><summary>T</summary>\nprose </details>').details).toEqual([]);
		expect(scan('<details><summary>T</summary>\n</details> trailing').details).toEqual([]);
		expect(scan('<details').details).toEqual([]);
	});
});

describe('rendered HTML fence blocks', () => {
	test('recognizes only the exact html do-it info tokens', () => {
		for (const marker of ['```', '~~~']) {
			for (const info of ['html do-it', ' html\tdo-it  ']) {
				const text = `${marker}${info}\n<p>content</p>\n${marker}`;
				const result = scan(text);
				expect(result.html).toHaveLength(1);
				expect(result.html[0]!.closed).toBe(true);
				expect(result.byLine.map((line) => line?.role)).toEqual(['html-open', 'html-body', 'html-close']);
			}
			for (const info of ['html', 'HTML do-it', 'html render', 'html do-it extra', 'do-it html', 'html-do-it', '']) {
				const result = scan(`${marker}${info}\n<p>content</p>\n${marker}`);
				expect(result.html).toEqual([]);
				expect(result.byLine.every((line) => line === undefined)).toBe(true);
			}
		}
	});

	test('uses shared fence matching and keeps payload lines opaque', () => {
		const text = [
			'# Before',
			'  ````html do-it',
			'  # Not a project',
			'  - [ ] Not a task',
			'',
			'  ```',
			'  ~~~~',
			'  ```` trailing',
			'  <details><summary>Not a fold</summary>',
			'  `````',
			'- [ ] After'
		].join('\n');
		const result = scan(text);
		const block = result.html[0]!;
		expect(result.html).toHaveLength(1);
		expect(block).toMatchObject({ startLine: 1, endLine: 10, closed: true, indent: '  ' });
		expect(block.delimiters.map((span) => slice(text, span))).toEqual(['  ````html do-it', '  `````']);
		expect(result.byLine[4]).toEqual({ role: 'html-body', block: 0 });
		expect(result.byLine.slice(2, 9).every((line) => line?.role === 'html-body')).toBe(true);
		expect(result.details).toEqual([]);
		expect(result.diagnostics).toEqual([]);
		expect(todos(text).map((todo) => todo.text)).toEqual(['After']);
		expect(sections(text).map((section) => section.title)).toEqual(['Before']);
	});

	test('does not discover marked fences inside ordinary code', () => {
		const text = '````md\n```html do-it\n<script>ignored()</script>\n```\n````\n~~~html do-it\n~~~';
		const result = scan(text);
		expect(result.html).toHaveLength(1);
		expect(result.html[0]).toMatchObject({ startLine: 5, endLine: 7, closed: true });
		expect(result.html[0]!.body.from).toBe(result.html[0]!.body.to);
		expect(result.byLine.slice(0, 5).every((line) => line === undefined)).toBe(true);
	});

	test('returns unclosed HTML fences as nonrenderable', () => {
		for (const text of ['```html do-it', '```html do-it\n<script>pending()</script>\n\n<details>\n']) {
			const result = scan(text);
			expect(result.html).toHaveLength(1);
			const block = result.html[0]!;
			expect(block.closed).toBe(false);
			expect(block.close).toBeUndefined();
			expect(block.to).toBe(text.length);
			expect(block.body.to).toBe(text.length);
			expect(block.delimiters).toEqual([block.open]);
			expect(result.details).toEqual([]);
			expect(result.diagnostics).toEqual([{ kind: 'html', reason: 'unclosed-fence', line: 0, ...block.open }]);
		}
	});

	test('preserves fence indentation and CRLF payload offsets', () => {
		const text = '😀\r\n\t~~~html do-it\r\n\t<p>中🙂</p>\r\n\r\n\t~~~~\r\n';
		const result = scan(text);
		const block = result.html[0]!;
		expect(block.from).toBe('😀\r\n'.length);
		expect(block.indent).toBe('\t');
		expect(slice(text, block.body)).toBe('\t<p>中🙂</p>\r\n\r\n');
		expect(block.delimiters.map((span) => slice(text, span))).toEqual(['\t~~~html do-it', '\t~~~~']);
		expect(block.to).toBe(text.length - 2);
		expect(block.endLine).toBe(5);
	});
});
