import { describe, expect, it } from 'bun:test';
import { endsLine } from '../src/settle';

describe('endsLine', () => {
	it('ends a line on Enter after a task or text line', () => {
		expect(endsLine('# TODO\n\n- [ ] foo\n', '# TODO\n\n- [ ] foo\n- [ ] \n')).toBe(true);
		expect(endsLine('notes here\n', 'notes here\n\n')).toBe(true);
		expect(endsLine('  - [ ] child\n', '  - [ ] child\n  - [ ] \n')).toBe(true);
	});

	it('ends a line when typing and Enter land in one sync', () => {
		expect(endsLine('- [ ] a\n- [ ] \n', '- [ ] a\n- [ ] foo\n- [ ] \n')).toBe(true);
		expect(endsLine('- [ ] f', '- [ ] foo\n- [ ] ')).toBe(true);
	});

	it('finds the new line when repeated text makes the change ambiguous', () => {
		expect(endsLine('a\n- [ ] b\n', 'a\n- [ ] \n- [ ] b\n')).toBe(true);
	});

	it('ends a line on Enter on an empty task, which removes its marker', () => {
		expect(endsLine('- [ ] foo\n- [ ] \n', '- [ ] foo\n\n')).toBe(true);
	});

	it('keeps waiting while the person types inside one line', () => {
		expect(endsLine('- [ ] fo\n', '- [ ] foo\n')).toBe(false);
		expect(endsLine('- [ ] fo\n- [ ] \n', '- [ ] foo\n- [ ] \n')).toBe(false);
		expect(endsLine('- [ ] foo\n- [ ] \n', '- [ ] foo\n- [ ] b\n')).toBe(false);
		expect(endsLine('- [ ] foobar\n', '- [ ] foo\n- [ ] bar\n')).toBe(false);
		expect(endsLine('- [ ] foo\n', '- [ ] fo\n')).toBe(false);
	});

	it('does not end a line without a change', () => {
		expect(endsLine('a\n', 'a\n')).toBe(false);
	});

	it('treats a carriage return as part of the line break', () => {
		expect(endsLine('- [ ] foo\r\n', '- [ ] foo\r\n- [ ] \r\n')).toBe(true);
		expect(endsLine('- [ ] fo\r\n', '- [ ] foo\r\n')).toBe(false);
	});
});
