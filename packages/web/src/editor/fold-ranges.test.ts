import { describe, expect, test } from 'bun:test';
import { blockEnd, lines } from '@do-it/doc/text';

import { foldCandidates, foldTarget, type FoldCandidate } from './fold-ranges';
import { classifyDocument } from './lines';

const candidates = (text: string) => foldCandidates(text, classifyDocument(text));
const named = (values: readonly FoldCandidate[], label: string) =>
	values.find((value) => value.identityLabel === label)!;
const nested = (values: readonly FoldCandidate[]) => {
	for (let index = 0; index < values.length; index += 1) {
		const left = values[index]!;
		for (const right of values.slice(index + 1)) {
			expect(right.from >= left.to || (right.from >= left.from && right.to <= left.to)).toBe(true);
		}
		if (left.parent !== undefined) {
			const parent = values[left.parent]!;
			expect(left.from).toBeGreaterThan(parent.from);
			expect(left.to).toBeLessThanOrEqual(parent.to);
		}
	}
};

describe('fold candidates', () => {
	test('folds all six heading levels up to their next peer or ancestor', () => {
		const text = '# Top\n## A\na\n### B\nb\n## C\nc\n#### D\nd\n##### E\ne\n###### F\nf\n# Next\nlast';
		const values = candidates(text);
		expect(values.map((value) => [value.identityLabel, value.startLine, value.endLine])).toEqual([
			['Top', 0, 13],
			['A', 1, 5],
			['B', 3, 5],
			['C', 5, 13],
			['D', 7, 13],
			['E', 9, 13],
			['F', 11, 13],
			['Next', 13, 15]
		]);
		expect(text.slice(named(values, 'A').hidden.from, named(values, 'A').hidden.to)).toBe('\na\n### B\nb');
		expect(named(values, 'Next').to).toBe(text.length);
		expect(values.every((value) => value.initiallyOpen)).toBe(true);
		nested(values);
	});

	test('omits leaf and blank-only ordinary blocks but keeps empty details', () => {
		const text =
			'# Leaf\n\n# Blank\n \n\t\n# Filled\nbody\n- [ ] Leaf task\n- [ ] Blank task\n  \n<details><summary>Empty</summary>\n</details>';
		const values = candidates(text);
		expect(values.map((value) => value.identityLabel)).toEqual(['Filled', 'Empty']);
		expect(named(values, 'Empty').hiddenLines).toBe(0);
		expect(named(values, 'Empty').initiallyOpen).toBe(false);
		expect(candidates('')).toEqual([]);
		expect(candidates('# Last\n')).toEqual([]);
	});

	test('uses task blockEnd for notes, nested tasks, and fenced blank lines', () => {
		const text =
			'- [ ] Parent\n  note\n  - [ ] Child\n    child note\n\n    ```html do-it\n    <p>First</p>\n\n    <p>Last</p>\n    ```\n- [ ] Next';
		const parsed = lines(text);
		const values = candidates(text);
		expect(values.map((value) => value.identityLabel)).toEqual(['Parent', 'Child']);
		for (const value of values) {
			expect(value.endLine).toBe(blockEnd(parsed, value.startLine));
			expect(value.hidden.from).toBe(parsed[value.headerLine]!.to);
			expect(value.hidden.to).toBe(parsed[value.endLine - 1]!.to);
			expect(value.hiddenLines).toBe(value.endLine - value.headerLine - 1);
		}
		nested(values);
	});

	test('scopes headings inside nested details without ending outer projects', () => {
		const text = [
			'# Outer',
			'<details>',
			'<summary>Explanation</summary>',
			'## Inner',
			'body',
			'<details><summary>Nested</summary>',
			'## Deep',
			'text',
			'</details>',
			'## Peer',
			'body',
			'</details>',
			'outer body',
			'# Next',
			'last'
		].join('\n');
		const values = candidates(text);
		expect(named(values, 'Outer').endLine).toBe(13);
		expect(named(values, 'Inner').endLine).toBe(9);
		expect(named(values, 'Deep').endLine).toBe(8);
		expect(named(values, 'Peer').endLine).toBe(11);
		const details = named(values, 'Explanation');
		expect(details.headerLine).toBe(2);
		expect(details.anchor).toBe(lines(text)[2]!.from);
		expect(details.hiddenLines).toBe(8);
		expect(text.slice(details.hidden.from, details.hidden.to).endsWith('</details>')).toBe(true);
		nested(values);
	});

	test('keeps attached details and drops task folds that cut across a details boundary', () => {
		const attached = '- [ ] Task\n  <details><summary>Explanation</summary>\n  body\n  </details>\n- [ ] Next';
		const complete = candidates(attached);
		expect(complete.map((value) => value.kind)).toEqual(['task', 'details']);
		expect(complete[1]!.parent).toBe(0);
		for (const text of [
			'- [ ] Task\n  <details><summary>Explanation</summary>\n  body\n</details>',
			'- [ ] Task\n  <details><summary>Explanation</summary>\n  ## Heading\n  body\n  </details>',
			'<details><summary>Explanation</summary>\n- [ ] Task\n  note\n  </details>\n  outside'
		]) {
			const values = candidates(text);
			expect(values.some((value) => value.kind === 'task')).toBe(false);
			expect(values.some((value) => value.kind === 'details')).toBe(true);
			nested(values);
		}
	});

	test('ignores apparent headings and tasks in ordinary and marked fences', () => {
		const text =
			'# Outer\n```md\n# Fake\n- [ ] Fake task\n```\n~~~html do-it\n## Fake HTML\n- [ ] Also fake\n~~~\n# Next\nbody';
		expect(candidates(text).map((value) => value.identityLabel)).toEqual(['Outer', 'Next']);
	});

	test('keeps UTF-16 offsets, tabs, CRLF, and physical counts without the phantom line', () => {
		const text = '# 😀\r\n\t- [ ] 中\r\n\t\tnote\r\n\r\n';
		const values = candidates(text);
		const heading = values[0]!;
		const task = values[1]!;
		expect(heading.hidden).toEqual({ from: '# 😀'.length, to: text.length - 2 });
		expect(heading.hiddenLines).toBe(3);
		expect(task.anchor).toBe('# 😀\r\n'.length);
		expect(task.hiddenLines).toBe(1);
		expect(text.slice(task.hidden.from, task.hidden.to)).toBe('\r\n\t\tnote');
		const details = candidates('<details open>\r\n<summary>中🙂</summary>\r\n</details>\r\n')[0]!;
		expect(details.hiddenLines).toBe(0);
		expect(details.initiallyOpen).toBe(true);
		expect(details.endLine).toBe(3);
	});

	test('keys use normalized labels, stamp-free tasks, occurrences, and unique details ids', () => {
		const text = [
			'#  Title  ###',
			'body',
			'- [x] Ship  it @today @done(26-11-05 10:00) @lasted(0:05) @project(Old)',
			'  note',
			'- [ ] Ship it @today',
			'  note',
			'<details id="stable"><summary>One</summary>',
			'</details>',
			'<details id="duplicate"><summary>Same</summary>',
			'</details>',
			'<details id="duplicate"><summary>Same</summary>',
			'</details>'
		].join('\n');
		expect(candidates(text).map((value) => value.key)).toEqual([
			'v1:heading:Title#0',
			'v1:task:Ship it @today#0',
			'v1:task:Ship it @today#1',
			'v1:details#stable',
			'v1:details:Same#0',
			'v1:details:Same#1'
		]);
	});

	test('targets the current header before the innermost containing body', () => {
		const text = '# Project\n- [ ] Task\n  <details>\n  <summary>Explanation</summary>\n  body\n  </details>\n# Leaf';
		const values = candidates(text);
		expect(foldTarget(values, text.indexOf('Project'))?.kind).toBe('heading');
		expect(foldTarget(values, text.indexOf('Task'))?.kind).toBe('task');
		expect(foldTarget(values, text.indexOf('Explanation'))?.kind).toBe('details');
		expect(foldTarget(values, text.indexOf('body'))?.kind).toBe('details');
		expect(foldTarget(values, text.indexOf('<details>'))?.kind).toBe('details');
		expect(foldTarget(values, text.indexOf('Leaf'))).toBeUndefined();
	});
});
