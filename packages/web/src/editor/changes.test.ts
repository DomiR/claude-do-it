import { describe, expect, test } from 'bun:test';
import { EditorSelection, EditorState } from '@codemirror/state';

import { changeSetBetween, rebaseRemote } from './changes';

const stateFor = (text: string) => EditorState.create({ doc: text, extensions: [EditorState.lineSeparator.of('\n')] });
const rebased = (from: string, to: string, live: string): string =>
	rebaseRemote(from, to, live).apply(stateFor(live).doc).toString();

describe('remote changes', () => {
	test('maps several remote hunks around a local edit', () => {
		expect(rebased('one\nmiddle\nthree\n', 'ONE\nmiddle\nTHREE\n', 'one\nmiddle local\nthree\n')).toBe(
			'ONE\nmiddle local\nTHREE\n'
		);
	});

	test('drops an identical insertion while keeping live coordinates and other local edits', () => {
		const from = 'alpha\nomega\n';
		const to = 'alpha\nshared\nomega\n';
		const live = 'alpha\nshared\nomega\nlocal\n';
		const changes = rebaseRemote(from, to, live);
		expect(changes.length).toBe(live.length);
		expect(changes.apply(stateFor(live).doc).toString()).toBe(live);
	});

	test('factors shared replacements and deletions out of both branches', () => {
		expect(rebased('alpha\nbeta\nomega\n', 'ALPHA\nomega\n', 'ALPHA\nomega\nlocal\n')).toBe('ALPHA\nomega\nlocal\n');
	});

	test('puts a remote insertion before a local insertion at the same offset', () => {
		expect(rebased('ab', 'aRb', 'aLb')).toBe('aRLb');
	});

	test('maps the live caret and backwards selection through the remote changes', () => {
		const from = 'alpha\nmiddle\nomega\n';
		const live = 'alpha\nmiddle local\nomega\n';
		const to = 'prefix\nalpha\nmiddle\nOMEGA\n';
		const selection = EditorSelection.create([EditorSelection.cursor(12), EditorSelection.range(17, 14)], 1);
		const changes = rebaseRemote(from, to, live);
		const mapped = selection.map(changes);
		expect(mapped.ranges[0]?.head).toBe(19);
		expect(mapped.main.anchor).toBe(24);
		expect(mapped.main.head).toBe(21);
		expect(mapped.mainIndex).toBe(1);
		expect(changes.apply(stateFor(live).doc).toString()).toBe('prefix\nalpha\nmiddle local\nOMEGA\n');
	});

	test('keeps CRLF, lone CR, and mixed endings byte exact in EditorState and ChangeSets', () => {
		const original = '# Tasks\r\n- [ ] Ship\r\nraw\rcharacter\n';
		const next = '# Tasks\r\n- [x] Ship\r\nraw\rcharacter\n- [ ] Next\r\n';
		const state = stateFor(original);
		expect(state.doc.toString()).toBe(original);
		expect(state.doc.line(1).text).toBe('# Tasks\r');
		expect(state.update({ changes: changeSetBetween(original, next) }).state.doc.toString()).toBe(next);
		expect(rebased(original, next, `${original}local\r\n`)).toBe(`${next}local\r\n`);
	});

	test('empty remote deltas still apply to the live text', () => {
		expect(rebased('a', 'a', 'ab')).toBe('ab');
		expect(rebased('a', 'ab', 'ab')).toBe('ab');
	});
});
