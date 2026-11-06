import { createTwoFilesPatch, diffArrays, diffChars, type Change } from 'diff';
import { MAX_DIFF } from './constants';
import { utf8Length, type Edit } from './edit';
import type { Version } from './types';

const MAX_REFINED = 16 * 1024;
const DEADLINE_MS = 250;

/** Coalesce adjacent additions and deletions into one replacement per hunk. */
function replacements(parts: ReadonlyArray<Change>, offset = 0): Edit[] {
	const result: Edit[] = [];
	let at = offset;
	let from = at;
	let inserted: string[] = [];
	function flush(): void {
		if (from !== at || inserted.length) result.push({ from, to: at, insert: inserted.join('') });
		inserted = [];
	}
	for (const part of parts) {
		if (part.added) inserted.push(part.value);
		else if (part.removed) at += part.value.length;
		else {
			flush();
			at += part.value.length;
			from = at;
		}
	}
	flush();
	return result;
}

/** A line-first diff, refined within small changed runs of lines.
 * All ranges are UTF-16 offsets in old; jsdiff's character tokens are Unicode
 * code points, so offsets use value.length rather than its token count.
 */
export function edits(old: string, next: string): Edit[] {
	if (old === next) return [];
	const deadline = performance.now() + DEADLINE_MS;
	// Like Rust split_inclusive: retain every newline, with no phantom final line.
	const oldLines = old.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const newLines = next.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const remaining = deadline - performance.now();
	const parts = remaining > 0 ? diffArrays(oldLines, newLines, { timeout: remaining }) : undefined;
	if (!parts) return [{ from: 0, to: old.length, insert: next }];
	const hunks = replacements(parts.map((part) => ({ ...part, value: part.value.join('') })));
	const result: Edit[] = [];
	for (const hunk of hunks) {
		const before = old.slice(hunk.from, hunk.to);
		const remaining = deadline - performance.now();
		if (
			!before ||
			!hunk.insert ||
			remaining <= 0 ||
			utf8Length(before) > MAX_REFINED ||
			utf8Length(hunk.insert) > MAX_REFINED
		) {
			result.push(hunk);
			continue;
		}
		// Each character refinement gets a quarter of the overall budget.
		// Also respect the original deadline when several hunks need refinement.
		const refined = diffChars(before, hunk.insert, { timeout: Math.min(DEADLINE_MS / 4, remaining) });
		if (refined) result.push(...replacements(refined, hunk.from));
		else result.push(hunk);
	}
	return result;
}

export function unified(old: string, next: string, from: Version, to: Version): string | null {
	if (old === next) return '';
	const diff = createTwoFilesPatch(String(from), String(to), old, next, undefined, undefined, {
		context: 2,
		headerOptions: { includeIndex: false, includeUnderline: false, includeFileHeaders: true }
	});
	return utf8Length(diff) > MAX_DIFF ? null : diff;
}
