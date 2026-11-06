import { describe, expect, test } from 'bun:test';
import { LoroDoc } from 'loro-crdt';
import { blockEnd, lines } from '../src/text';
import {
	Document,
	DocError,
	MAX_DIFF,
	MAX_ITEM,
	MAX_BYTES,
	addTodo,
	appendBlock,
	applyEdits,
	findSection,
	findTodo,
	formatTodoChange,
	replaceUnique,
	sections,
	sectionText,
	setTodoState,
	slug,
	todoChanges,
	todos,
	unified,
	type TaskState
} from '../src';

function code(action: () => unknown, expected: DocError['code']): void {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(DocError);
		expect((error as DocError).code).toBe(expected);
		return;
	}
	throw new Error(`Expected ${expected}`);
}

test('LoroText insert and delete directly use UTF-16 indices around emoji and CJK', () => {
	const doc = new LoroDoc();
	const text = doc.getText('text');
	try {
		text.insert(0, '😀中a漢🙂z');
		expect(text.length).toBe('😀中a漢🙂z'.length);
		text.delete(3, 1);
		text.insert(3, '🚀乙');
		expect(text.toString()).toBe('😀中🚀乙漢🙂z');
		text.delete('😀中🚀乙漢'.length, 2);
		expect(text.toString()).toBe('😀中🚀乙漢z');
	} finally {
		text.free();
		doc.free();
	}
});

describe('sections', () => {
	test('slugs, repeats, trailing hashes, and only the first three heading levels', () => {
		const text =
			'intro😀\n# Goals\n- [ ] a\n## Next Steps!\n- [ ] b\n#### deep\n- [ ] c\n## Next steps\n## Next steps\n### Done ###\n';
		const all = sections(text);
		expect(all.map((section) => section.id)).toEqual(['goals', 'next-steps', 'next-steps-1', 'next-steps-2', 'done']);
		expect(all.map((section) => section.level)).toEqual([1, 2, 2, 2, 3]);
		expect(all[0]!.from).toBe('intro😀\n'.length);
		expect(all[0]!.line).toBe(1);
		expect(all[1]!.title).toBe('Next Steps!');
		expect(sectionText(text, 'next-steps')).toBe('## Next Steps!\n- [ ] b\n#### deep\n- [ ] c\n');
		expect(findSection(text, '  #done  ').title).toBe('Done');
		expect(all.at(-1)!.to).toBe(text.length);
		expect(slug('Ünïcode: déjà vu_2 — ok')).toBe('ünïcode-déjà-vu_2--ok');
		expect(slug('你好 **World** 😀')).toBe('你好-world-');
		expect(sectionText(text, 'nope')).toBeNull();
		code(() => findSection(text, 'nope'), 'not-found');
	});
	test('fences require matching markers and sufficient closing length', () => {
		const text = '# Outside\n````md\n## Hidden\n```\n# Still hidden\n````\n~~~\n# Also hidden\n~~~~\n## Visible\n';
		expect(sections(text).map((section) => section.id)).toEqual(['outside', 'visible']);
		expect(sections('# Good\n#bad\n#### deep\n\t### Indented\n').map((section) => section.id)).toEqual([
			'good',
			'indented'
		]);
	});
});

describe('todo operations', () => {
	const text = '# Work\n- [ ] write\n  * [X] outline\n- [-] read\n\n## Later\n+ [ ] ship\n';
	test('lists states, indentation, global numbers and section IDs', () => {
		expect(todos(text)).toEqual([
			{ number: 1, line: 1, state: 'open', text: 'write', indent: 0, section: 'work' },
			{ number: 2, line: 2, state: 'done', text: 'outline', indent: 2, section: 'work' },
			{ number: 3, line: 3, state: 'cancelled', text: 'read', indent: 0, section: 'work' },
			{ number: 4, line: 6, state: 'open', text: 'ship', indent: 0, section: 'later' }
		]);
		expect(todos('\t- [ ] task\n')[0]!.indent).toBe(4);
		expect(todos('- [ ] standalone\n')[0]!.section).toBeNull();
		expect(todos('````\n- [ ] hidden\n````\n- [x]done\n- [?] no\n- [ ]\n').map((todo) => todo.text)).toEqual(['']);
		expect(todos('1. [ ] ordered\n2) [-] also\n').map((todo) => todo.state)).toEqual(['open', 'cancelled']);
	});
	test('keeps deep headings in the current section and uses repeated section IDs', () => {
		const repeated = '# Tasks\n- [ ] one\n#### Deep\n- [ ] two\n# Tasks\n- [ ] three\n';
		expect(todos(repeated).map((todo) => todo.section)).toEqual(['tasks', 'tasks', 'tasks-1']);
	});
	test('finds by number, numeric string, exact text, or unique substring ignoring case', () => {
		expect(findTodo(text, 4).text).toBe('ship');
		expect(findTodo(text, '4').text).toBe('ship');
		expect(findTodo(text, ' OUTL ').number).toBe(2);
		expect(findTodo('- [ ] fix\n- [ ] fix it\n', 'fix').number).toBe(1);
		expect(findTodo(text, 4, 'later').text).toBe('ship');
		code(() => findTodo(text, 1, 'later'), 'not-found');
		code(() => findTodo(text, 99), 'not-found');
		code(() => findTodo(text, 'missing'), 'not-found');
		code(() => findTodo(text, ''), 'not-found');
		code(() => findTodo(text, 1, 'unknown'), 'not-found');
		code(() => findTodo('- [ ] fix a\n- [ ] fix b\n', 'fix'), 'ambiguous');
		code(() => findTodo('- [ ] fix\n- [ ] fix\n', 'fix'), 'ambiguous');
	});
	test('check, uncheck, cancel and uncancel preserve markers and are idempotent', () => {
		let value = '\t* [ ] Ship\n';
		for (const state of ['done', 'open', 'cancelled', 'open'] as TaskState[]) {
			value = applyEdits(value, setTodoState(value, findTodo(value, 'ship'), state));
			expect(todos(value)[0]!.state).toBe(state);
			expect(value.startsWith('\t* ')).toBe(true);
			expect(setTodoState(value, findTodo(value, 1), state)).toEqual([]);
		}
		const doc = Document.open('- [X] Ship\n');
		try {
			const result = doc.agentEdit({ kind: 'agent', name: 'test' }, { version: 1 }, (text) =>
				setTodoState(text, findTodo(text, 1), 'done')
			);
			expect(result).toEqual({ version: 1, changed: false, others: null });
		} finally {
			doc.free();
		}
	});
	test('adds after the last task and its children with the same literal indentation', () => {
		expect(applyEdits(text, addTodo(text, 'new'))).toContain('+ [ ] ship\n- [ ] new\n');
		expect(applyEdits(text, addTodo(text, 'next', 'work'))).toContain('- [-] read\n- [ ] next\n\n## Later');
		const nested = '# A\n\t* [ ] parent\n\t  details\n\n# B\n';
		expect(applyEdits(nested, addTodo(nested, ' sibling ', 'a'))).toBe(
			'# A\n\t* [ ] parent\n\t  details\n\t- [ ] sibling\n\n# B\n'
		);
		expect(applyEdits('', addTodo('', 'first'))).toBe('- [ ] first\n');
		const plain = '# A\nparagraph\n\n# B\n';
		expect(applyEdits(plain, addTodo(plain, 'next', 'a'))).toBe('# A\nparagraph\n\n- [ ] next\n\n# B\n');
		code(() => addTodo(text, 'new', 'unknown'), 'not-found');
	});
	test('keeps empty fence lines inside a task block', () => {
		for (const newline of ['\n', '\r\n']) {
			const text = [
				'- [ ] Explain',
				'    ```html do-it',
				'    <p>First</p>',
				'',
				'    <p>Last</p>',
				'    ```',
				'- [ ] Next'
			].join(newline);
			const parsed = lines(text);
			expect(parsed[3]!.kind).toBe('code');
			expect(parsed[3]!.from).toBe(parsed[3]!.to);
			expect(blockEnd(parsed, 0)).toBe(6);
			expect(text.slice(parsed[0]!.from, parsed[blockEnd(parsed, 0) - 1]!.to)).toBe(
				text.slice(0, text.indexOf(`${newline}- [ ] Next`))
			);
		}
	});
	test('adds a todo after an attached HTML fence with an empty line', () => {
		const text =
			'## Tasks\n- [ ] Explain\n    ```html do-it\n    <p>First</p>\n\n    <p>Last</p>\n    ```\n\n## Later\n';
		expect(applyEdits(text, addTodo(text, 'Follow up', 'tasks'))).toBe(
			'## Tasks\n- [ ] Explain\n    ```html do-it\n    <p>First</p>\n\n    <p>Last</p>\n    ```\n- [ ] Follow up\n\n## Later\n'
		);
	});
	test('MAX_ITEM counts Unicode characters and rejects, never truncates', () => {
		expect(applyEdits('', addTodo('', '😀'.repeat(MAX_ITEM)))).toBe(`- [ ] ${'😀'.repeat(MAX_ITEM)}\n`);
		code(() => addTodo('', 'a'.repeat(MAX_ITEM + 1)), 'too-large');
		for (const item of ['  ', 'two\nlines', 'two\rlines']) code(() => addTodo('', item), 'invalid');
	});
	test("append block adds one blank line, none between list items, and preserves the section's final gap", () => {
		expect(applyEdits('text', appendBlock('text', 'more'))).toBe('text\n\nmore\n');
		expect(applyEdits('text\n\n\n', appendBlock('text\n\n\n', 'more\r\n'))).toBe('text\n\nmore\n');
		expect(applyEdits('- a\n', appendBlock('- a\n', '- b'))).toBe('- a\n- b\n');
		const two = '# A\n- a\n\n# B\nb\n';
		expect(applyEdits(two, appendBlock(two, '- a2', 'a'))).toBe('# A\n- a\n- a2\n\n# B\nb\n');
		expect(applyEdits('# A\n- a', appendBlock('# A\n- a', '- b', 'a'))).toBe('# A\n- a\n- b\n');
		code(() => appendBlock(two, ' \n'), 'invalid');
		code(() => appendBlock(two, 'x', 'missing'), 'not-found');
		code(() => appendBlock('x', 'y'.repeat(MAX_BYTES)), 'too-large');
	});
	test('unique replacement stays within a section and rejects absent or ambiguous text', () => {
		const two = '# A\nsame\n# B\nsame\n';
		expect(applyEdits(two, replaceUnique(two, 'same', 'other', 'b'))).toBe('# A\nsame\n# B\nother\n');
		code(() => replaceUnique(two, 'same', 'x'), 'ambiguous');
		code(() => replaceUnique(two, 'missing', 'x'), 'not-found');
		code(() => replaceUnique(two, '', 'x'), 'invalid');
		code(() => replaceUnique(two, 'same', 'x', 'unknown'), 'not-found');
		expect(applyEdits('aaa', replaceUnique('aaa', 'aa', 'b'))).toBe('ba');
	});
});

describe('todoChanges', () => {
	test('a replacement reports checks, edits, additions, then removals', () => {
		const old = '- [ ] warn when low\n- [ ] ship\n- [x] old idea\n- [ ] typo here\n';
		const next = '- [x] warn when low\n- [ ] ship\n- [ ] typo fixed\n- [ ] new one\n';
		expect(todoChanges(old, next).map(formatTodoChange)).toEqual([
			'checked 1. warn when low',
			'edited 3. typo fixed',
			'added 4. new one',
			'removed 3. old idea'
		]);
		expect(todoChanges(old, old)).toEqual([]);
	});
	test('all state transitions, including done to cancelled and cancelled to done', () => {
		for (const [before, after, kind] of [
			[' ', 'x', 'checked'],
			['x', ' ', 'unchecked'],
			[' ', '-', 'cancelled'],
			['-', ' ', 'uncancelled'],
			['x', '-', 'cancelled'],
			['-', 'x', 'checked']
		] as const) {
			expect(todoChanges(`- [${before}] Ship\n`, `- [${after}] Ship\n`)[0]!.kind).toBe(kind);
		}
		expect(todoChanges('- [X] done\n- [-] cancelled\n', '- [x] done\n- [-] cancelled\n')).toEqual([]);
		expect(formatTodoChange({ kind: 'checked', number: 3, text: 'Ship', line: 2, oldLine: 2 })).toBe('checked 3. Ship');
	});
	test('added and removed lines use the appropriate document numbers and positions', () => {
		expect(todoChanges('intro\n- [ ] A\n', 'intro\n- [ ] A\n\n- [ ] B\n')).toEqual([
			{ kind: 'added', number: 2, text: 'B', line: 3, oldLine: 3 }
		]);
		expect(todoChanges('intro\n- [ ] A\n', 'intro\n')).toEqual([
			{ kind: 'removed', number: 1, text: 'A', line: 1, oldLine: 1 }
		]);
		expect(todoChanges('- [ ] Ship\n', 'intro\n- [x] Ship\n')).toEqual([
			{ kind: 'checked', number: 1, text: 'Ship', line: 1, oldLine: 0 }
		]);
	});
});

describe('unified diffs', () => {
	test('exact version headers and two lines of context', () => {
		const old = 'a\nb\nc\nd\ne\nf\ng\nh\ni\n';
		const next = old.replace('e\n', 'E\n');
		expect(unified(old, next, 7, 8)).toBe('--- 7\n+++ 8\n@@ -3,5 +3,5 @@\n c\n d\n-e\n+E\n f\n g\n');
		expect(unified(old, old, 7, 7)).toBe('');
	});
	test('caps diff by UTF-8 bytes, including headers, without truncation', () => {
		expect(unified('old\n', 'x'.repeat(MAX_DIFF) + '\n', 1, 2)).toBeNull();
		expect(unified('old\n', '中'.repeat(Math.ceil(MAX_DIFF / 3)) + '\n', 1, 2)).toBeNull();
		expect(unified('old\n', 'x'.repeat(100) + '\n', 1, 2)).not.toBeNull();
		const doc = Document.open('old\n');
		try {
			doc.userEdit(1, 'x'.repeat(MAX_DIFF) + '\n');
			expect(doc.changes(1)!.diff).toBeNull();
			try {
				doc.agentEdit({ kind: 'agent', name: 't' }, { version: 1 }, () => []);
			} catch (error) {
				expect((error as DocError).conflict).toEqual({ expected: 1, current: 2, diff: null, forgotten: false });
			}
		} finally {
			doc.free();
		}
	});
});
