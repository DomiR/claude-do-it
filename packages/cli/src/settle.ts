import type { Author } from '@do-it/protocol';

function lineBreaks(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++;
	return count;
}

/**
 * Whether the change from `before` to `after` raises the line count: Enter at
 * the end of a line or inside one, a pasted block, or an undo that restores a
 * line. Every other change waits: typing or deleting inside a line, removing a
 * line, toggling a box, and Enter on an empty task, which removes its marker
 * instead of making a line.
 *
 * Counting line breaks over the whole text is the same as counting them in the
 * changed run (the common prefix and suffix cancel), and needs no alignment.
 */
export function addsLine(before: string, after: string): boolean {
	return lineBreaks(after) > lineBreaks(before);
}

/**
 * Whether a watch change by the person or the file settles after --settle-line.
 * A change bundled with an agent's edit waits, since the agent may have added
 * the lines.
 */
export function personAddsLine(
	before: string | undefined,
	after: string | undefined,
	by: ReadonlyArray<Author>
): boolean {
	return (
		before !== undefined &&
		after !== undefined &&
		by.every((author) => author._tag !== 'Agent') &&
		addsLine(before, after)
	);
}
