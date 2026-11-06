import { expect, spyOn, test } from 'bun:test';
import * as diff from 'diff';
import { applyEdits, DocError, edits, mapOffset, replaceUnique, type Edit } from '../src';

function roundTrip(old: string, next: string): Edit[] {
	const changes = edits(old, next);
	expect(applyEdits(old, changes)).toBe(next);
	for (let i = 1; i < changes.length; i++) expect(changes[i - 1]!.to).toBeLessThanOrEqual(changes[i]!.from);
	return changes;
}

// Offsets are UTF-16 code units, as in JavaScript strings.
test('identical texts need no edits', () => {
	expect(edits('a\nb\n', 'a\nb\n')).toEqual([]);
});

test('a changed word is a small edit inside its line', () => {
	const changes = roundTrip('one\nthe quick fox\nthree\n', 'one\nthe slow fox\nthree\n');
	expect(changes.length).toBeGreaterThan(0);
	for (const edit of changes) {
		expect(edit.to - edit.from).toBeLessThanOrEqual(5);
		expect(edit.from).toBeGreaterThanOrEqual(8);
		expect(edit.to).toBeLessThanOrEqual(13);
	}
});

test('lines added, removed, and Unicode round trip', () => {
	for (const [old, next] of [
		['a\nb\nc\n', 'a\nc\nd\n'],
		['', 'new\n'],
		['old\n', ''],
		['héllo wörld 🎉\n', 'hallo wörld 🎊!\n'],
		['no newline', 'no newline at end'],
		['\n\n', '\n'],
		['a\r\nb\r\n', 'a\r\nB\r\n'],
		['a', 'a\n'],
		['a\n', 'a']
	])
		roundTrip(old!, next!);
});

test('edits ascend without overlap', () => {
	roundTrip('1\n2\n3\n4\n5\n', '0\n2\nx\n4\n6\n7\n');
});

test('offsets map through edits', () => {
	const changes = [
		{ from: 2, to: 2, insert: 'xx' },
		{ from: 4, to: 6, insert: 'y' }
	];
	expect(mapOffset(0, changes)).toBe(0);
	expect(mapOffset(2, changes)).toBe(4);
	expect(mapOffset(5, changes)).toBe(7);
	expect(mapOffset(8, changes)).toBe(9);
});

test('replacing one unique place', () => {
	expect(replaceUnique('a b a', 'b', 'c')).toEqual([{ from: 2, to: 3, insert: 'c' }]);
	for (const [text, old, code] of [
		['a b a', 'a', 'ambiguous'],
		['a', 'z', 'not-found'],
		['a', '', 'invalid']
	] as const) {
		let failure: unknown;
		try {
			replaceUnique(text, old, 'c');
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(DocError);
		expect((failure as DocError).code).toBe(code);
	}
});

test('character refinement preserves UTF-16 coordinates and whole surrogate pairs', () => {
	expect(roundTrip('😀中alpha漢🙂beta尾\n', '😀中甲漢🙂beta尾\n')).toEqual([{ from: 3, to: 8, insert: '甲' }]);
	expect(roundTrip('😀中a漢🙂z\n', '😀中a漢🚀z\n')).toEqual([{ from: 5, to: 7, insert: '🚀' }]);
});

test("the beta checkbox and gamma addition are separate from beta's text", () => {
	const old = '# Todo\n- [ ] alpha\n- [ ] beta\n';
	const next = '# Todo\n- [ ] alpha\n- [x] beta\n- [ ] gamma\n';
	const changes = roundTrip(old, next);
	const beta = old.indexOf('beta');
	expect(changes.every((edit) => edit.to <= beta || edit.from >= beta + 4)).toBe(true);
	expect(changes).toEqual([
		{ from: old.indexOf('[ ] beta') + 1, to: old.indexOf('[ ] beta') + 2, insert: 'x' },
		{ from: old.length, to: old.length, insert: '- [ ] gamma\n' }
	]);
});

test('refinement includes hunks at 16 KiB, larger hunks become whole replacements', () => {
	const prefix = 'a'.repeat(16 * 1024 - 2);
	const old = `${prefix}x\n`;
	const next = `${prefix}y\n`;
	expect(roundTrip(old, next)).toEqual([{ from: prefix.length, to: prefix.length + 1, insert: 'y' }]);
	expect(roundTrip('start\n' + old + 'a\n', 'start\n' + next + 'b\n')).toEqual([
		{ from: 6, to: 6 + old.length + 2, insert: next + 'b\n' }
	]);
	// KiB means UTF-8 bytes, not UTF-16 units or code points.
	const unicode = '😀'.repeat(4096) + 'x\n';
	expect(roundTrip(unicode, unicode.replace('x', 'y'))).toEqual([
		{ from: 0, to: unicode.length, insert: unicode.replace('x', 'y') }
	]);
});

test('a timed out character refinement replaces the whole hunk', () => {
	// A timeout makes diff return undefined; the spy is typed by the last overload only.
	const refine = spyOn(diff, 'diffChars').mockReturnValueOnce(undefined as never);
	try {
		expect(roundTrip('keep\nold text\nend\n', 'keep\nnew text\nend\n')).toEqual([
			{ from: 5, to: 14, insert: 'new text\n' }
		]);
		expect(refine).toHaveBeenCalledTimes(1);
		const timeout = (refine.mock.calls[0]![2] as { timeout: number }).timeout;
		expect(timeout).toBeGreaterThan(0);
		expect(timeout).toBeLessThanOrEqual(62.5);
	} finally {
		refine.mockRestore();
	}
});

test('the shared deadline skips refinement after line comparison', () => {
	const clock = spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(251);
	const refine = spyOn(diff, 'diffChars');
	try {
		expect(roundTrip('keep\nold text\nend\n', 'keep\nnew text\nend\n')).toEqual([
			{ from: 5, to: 14, insert: 'new text\n' }
		]);
		expect(refine).not.toHaveBeenCalled();
	} finally {
		clock.mockRestore();
		refine.mockRestore();
	}
});

test('a timed out line diff still produces a complete replacement', () => {
	const compare = spyOn(diff, 'diffArrays').mockReturnValueOnce(undefined as never);
	try {
		expect(roundTrip('old\n', 'new\n')).toEqual([{ from: 0, to: 4, insert: 'new\n' }]);
	} finally {
		compare.mockRestore();
	}
});
