/** A line holding nothing the person wrote: blank, or a bare list or task marker. */
const emptyLine = /^[ \t\r]*(?:(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX-]?\])?[ \t\r]*)?$/;

function commonPrefix(a: string, b: string, limit: number): number {
	let index = 0;
	while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index++;
	return index;
}
function commonSuffix(a: string, b: string, limit: number): number {
	let index = 0;
	while (index < limit && a.charCodeAt(a.length - 1 - index) === b.charCodeAt(b.length - 1 - index)) index++;
	return index;
}

/**
 * Whether the change from `before` to `after` leaves the caret on an empty
 * line under a written one: Enter after a task or text line, or Enter on an
 * empty task, which removes its marker. Typing inside a line is unfinished.
 *
 * The caret sits at the end of the changed run, but repeated text makes the
 * run's position ambiguous. Both extreme alignments are taken, and every line
 * between their carets counts.
 */
export function endsLine(before: string, after: string): boolean {
	if (before === after) return false;
	const limit = Math.min(before.length, after.length);
	const prefix = commonPrefix(before, after, limit);
	const latest = after.length - commonSuffix(before, after, limit - prefix);
	const suffix = commonSuffix(before, after, limit);
	const earliest = after.length - suffix;
	const lines = after.split('\n');
	let start = 0;
	for (let index = 0; index < lines.length; index++) {
		const end = start + lines[index]!.length;
		if (
			end >= earliest &&
			start <= latest &&
			index > 0 &&
			emptyLine.test(lines[index]!) &&
			!emptyLine.test(lines[index - 1]!)
		)
			return true;
		if (start > latest) break;
		start = end + 1;
	}
	return false;
}
