function lineBreaks(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++;
	return count;
}

/**
 * Whether the change from `before` to `after` adds a line: Enter at the end of
 * a line or inside one, or a pasted block. Every other change waits: typing or
 * deleting inside a line, removing a line, toggling a box, and Enter on an
 * empty task, which removes its marker instead of making a line.
 *
 * Counting line breaks over the whole text is the same as counting them in the
 * changed run (the common prefix and suffix cancel), and needs no alignment.
 */
export function addsLine(before: string, after: string): boolean {
	return lineBreaks(after) > lineBreaks(before);
}
