import type { ClassifiedDocument, ClassifiedLine, Span } from './lines';

/** One replacement in the coordinates of the text before the edit. */
export interface TextChange {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
}

const overlaps = (change: Span, span: Span): boolean => change.from < span.to && change.to > span.from;
const covers = (change: Span, span: Span): boolean => change.from <= span.from && change.to >= span.to;

const linesTouching = (document: ClassifiedDocument, change: Span): ClassifiedLine[] =>
	document.lines.filter((line) => line.from <= change.to && line.to >= change.from);

/** Sorted, with overlapping ranges joined, keeping their inserted text in order. */
const merge = (changes: ReadonlyArray<TextChange>): TextChange[] => {
	const sorted = [...changes].sort((left, right) => left.from - right.from || left.to - right.to);
	const result: TextChange[] = [];
	for (const change of sorted) {
		const last = result[result.length - 1];
		if (last && change.from < last.to) {
			result[result.length - 1] = {
				from: last.from,
				to: Math.max(last.to, change.to),
				insert: last.insert + change.insert
			};
		} else result.push(change);
	}
	return result;
};

/**
 * Widens a person's edit so rendered syntax never breaks into visible
 * pieces: a line prefix (task box, bullet, heading or quote mark) goes as a
 * whole, a line joined onto the one above loses its prefix, and a styled run
 * loses both delimiters when either is hit, or when its whole text is
 * deleted. Returns undefined when the edit needs no change.
 */
export const protectSyntax = (
	document: ClassifiedDocument,
	changes: ReadonlyArray<TextChange>
): TextChange[] | undefined => {
	let result = changes.map((change) => ({ ...change }));
	let widened = false;
	for (let round = 0; round < 4; round += 1) {
		let changedThisRound = false;
		const next: TextChange[] = [];
		for (const change of result) {
			let { from, to } = change;
			if (from === to) {
				next.push(change);
				continue;
			}
			for (const line of linesTouching(document, { from, to })) {
				const prefix = line.prefix;
				if (prefix && prefix.from < prefix.to) {
					if (overlaps({ from, to }, prefix) && !covers({ from, to }, prefix)) {
						from = Math.min(from, prefix.from);
						to = Math.max(to, prefix.to);
					}
					// Joining this line onto the previous one leaves its prefix mid line, so it goes too.
					if (from < line.from && to >= line.from && to <= prefix.from) to = prefix.to;
				}
			}
			if (from !== change.from || to !== change.to) changedThisRound = true;
			next.push({ from, to, insert: change.insert });
		}
		const extra: TextChange[] = [];
		for (const line of document.lines) {
			for (const construct of line.constructs) {
				if (next.some((change) => covers(change, construct))) continue;
				const deletions = next.filter((change) => change.from < change.to);
				const hit = construct.marks.some((mark) => deletions.some((change) => overlaps(change, mark)));
				const emptied =
					construct.content.from < construct.content.to &&
					deletions.some((change) => change.insert === '' && covers(change, construct.content));
				if (!hit && !emptied) continue;
				for (const mark of construct.marks) {
					if (!next.some((change) => covers(change, mark)) && !extra.some((change) => covers(change, mark))) {
						extra.push({ from: mark.from, to: mark.to, insert: '' });
						changedThisRound = true;
					}
				}
			}
		}
		result = merge([...next, ...extra]);
		if (!changedThisRound) break;
		widened = true;
	}
	return widened ? result : undefined;
};
