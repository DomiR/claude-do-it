import { describe, expect, it } from 'bun:test';
import type { Author } from '@do-it/protocol';
import { addsLine, personAddsLine } from '../src/settle';

const todo = '# TODO\n\n## Tasks\n\n- [ ] ship it\n  - **t1** S, building\n- [ ] next\n- [ ] \n';

describe('addsLine', () => {
	it('adds a line on Enter at the end of a task or text line', () => {
		expect(addsLine('# TODO\n\n- [ ] foo\n', '# TODO\n\n- [ ] foo\n- [ ] \n')).toBe(true);
		expect(addsLine('notes here\n', 'notes here\n\n')).toBe(true);
		expect(addsLine('  - [ ] child\n', '  - [ ] child\n  - [ ] \n')).toBe(true);
		expect(addsLine(todo, todo.replace('- [ ] next\n', '- [ ] next\n- [ ] \n'))).toBe(true);
	});

	it('adds a line when typing and Enter land in one sync', () => {
		expect(addsLine('- [ ] a\n- [ ] \n', '- [ ] a\n- [ ] foo\n- [ ] \n')).toBe(true);
		expect(addsLine('- [ ] f', '- [ ] foo\n- [ ] ')).toBe(true);
	});

	it('adds a line on Enter inside a line, which splits it', () => {
		expect(addsLine('- [ ] foobar\n', '- [ ] foo\n- [ ] bar\n')).toBe(true);
		expect(addsLine('a\n- [ ] b\n', 'a\n- [ ] \n- [ ] b\n')).toBe(true);
	});

	it('adds lines when a block is pasted', () => {
		expect(addsLine(todo, todo.replace('- [ ] \n', '- [ ] one\n- [ ] two\n- [ ] \n'))).toBe(true);
	});

	it('waits while the person types in the middle of an existing task', () => {
		expect(addsLine(todo, todo.replace('ship it', 'ship the build it'))).toBe(false);
		expect(addsLine('- [ ] fo\n', '- [ ] foo\n')).toBe(false);
		expect(addsLine('- [ ] foo\n- [ ] \n', '- [ ] foo\n- [ ] b\n')).toBe(false);
	});

	it('waits when the person edits a line and moves away without Enter', () => {
		const edited = todo.replace('ship it', 'ship it today');
		expect(addsLine(todo, edited)).toBe(false);
		expect(addsLine(edited, edited.replace('- [ ] next', '- [ ] next up'))).toBe(false);
	});

	it('waits on deletions', () => {
		expect(addsLine('- [ ] foo\n', '- [ ] fo\n')).toBe(false);
		expect(addsLine(todo, todo.replace('- [ ] next\n', '- [ ] \n'))).toBe(false);
		expect(addsLine(todo, todo.replace('- [ ] next\n', ''))).toBe(false);
		expect(addsLine(todo, todo.replace('  - **t1** S, building\n', ''))).toBe(false);
		expect(addsLine('- [ ] a\n- [ ] b\n', '- [ ] a- [ ] b\n')).toBe(false);
	});

	it('waits on Enter on an empty task, which removes its marker instead of adding a line', () => {
		expect(addsLine('- [ ] foo\n- [ ] \n', '- [ ] foo\n\n')).toBe(false);
	});

	it('waits on a toggled box', () => {
		expect(addsLine(todo, todo.replace('- [ ] ship it', '- [x] ship it @done(26-11-06 09:00)'))).toBe(false);
	});

	it('does not add a line without a change', () => {
		expect(addsLine('a\n', 'a\n')).toBe(false);
	});

	it('counts a carriage return line break once', () => {
		expect(addsLine('- [ ] foo\r\n', '- [ ] foo\r\n- [ ] \r\n')).toBe(true);
		expect(addsLine('- [ ] fo\r\n', '- [ ] foo\r\n')).toBe(false);
	});
});

describe('personAddsLine', () => {
	const user: Author = { _tag: 'User' };
	const file: Author = { _tag: 'File' };
	const conductor: Author = { _tag: 'Agent', name: 'conductor' };
	const entered = todo.replace('- [ ] next\n', '- [ ] next\n- [ ] \n');

	it('settles early on Enter by the person or the file', () => {
		expect(personAddsLine(todo, entered, [user])).toBe(true);
		expect(personAddsLine(todo, entered, [file])).toBe(true);
	});

	it('waits when the change is bundled with an agent edit', () => {
		expect(personAddsLine(todo, entered, [user, conductor])).toBe(false);
	});

	it('waits without both texts', () => {
		expect(personAddsLine(undefined, entered, [user])).toBe(false);
		expect(personAddsLine(todo, undefined, [user])).toBe(false);
	});
});
