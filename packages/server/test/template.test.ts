import { expect, test } from 'bun:test';
import { TEMPLATE } from '../src/config';

const lines = TEMPLATE.split('\n');
const tasksAt = lines.indexOf('## Tasks');

test('the template keeps the Tasks heading last, with an empty typing spot', () => {
	expect(lines.filter((line) => line.startsWith('#'))).toEqual(['# TODO', '## Example', '## Tasks']);
	expect(TEMPLATE.endsWith('\n## Tasks\n\n- [ ] \n')).toBe(true);
});

test('the template follows the copy rule', () => {
	expect(TEMPLATE).not.toMatch(/[–—]/);
	for (const line of lines) expect(line.replace(/^\s*- (\[.\] )?/, '')).not.toContain(' - ');
});

test('open sample tasks carry a status line so the conductor never dispatches them', () => {
	const example = lines.slice(0, tasksAt);
	example.forEach((line, i) => {
		if (/^- \[ \] \S/.test(line)) expect(example[i + 1]).toMatch(/^ {2}- \*\*t0\*\* /);
	});
	expect(TEMPLATE).not.toMatch(/\*\*t[1-9]/);
	expect(lines.filter((line) => line.includes('**t0')).some((line) => line.includes('@'))).toBe(false);
	expect(TEMPLATE).not.toMatch(/\d{2}-\d{2}-\d{2}/);
});

test('the template shows the keys, tags, and agent replies', () => {
	for (const part of [
		'Cmd-Enter',
		'Cmd-D',
		'Cmd-Alt-Enter',
		'Cmd-Shift-A',
		'@today',
		'@high',
		'@due(',
		's then Tab',
		'**t0** ',
		'**t0 question:**'
	]) {
		expect(TEMPLATE).toContain(part);
	}
});
