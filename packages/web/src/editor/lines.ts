import { blockEnd, lines, type Line, type TaskState } from '@do-it/doc/text';

import { scanBlocks, type BlockIndex, type BlockRole } from './blocks';

export type LineKind = 'project' | 'task' | 'status' | 'note' | 'prose' | 'blank' | 'code' | 'fence' | 'quote' | 'rule';

export interface Span {
	readonly from: number;
	readonly to: number;
}

export type InlineKind =
	| 'strong'
	| 'strongMark'
	| 'em'
	| 'emMark'
	| 'strike'
	| 'strikeMark'
	| 'code'
	| 'codeMark'
	| 'link'
	| 'linkMark'
	| 'tag';

export interface InlineSpan extends Span {
	readonly kind: InlineKind;
	readonly name?: string;
}

export interface ClassifiedLine {
	readonly index: number;
	readonly from: number;
	readonly to: number;
	readonly kind: LineKind;
	readonly depth: number;
	readonly level?: number;
	readonly state?: TaskState;
	readonly marks?: Span;
	readonly bullet?: Span;
	readonly hiddenBullet?: Span;
	readonly quoteMark?: Span;
	readonly checkbox?: Span;
	readonly label?: Span;
	readonly hang: number;
	readonly empty: boolean;
	readonly alwaysHidden: ReadonlyArray<Span>;
	readonly previewHidden: ReadonlyArray<Span>;
	readonly dot?: Span;
	readonly inline: ReadonlyArray<InlineSpan>;
	/** Inline styles whose delimiters are hidden, in line order. */
	readonly constructs: ReadonlyArray<InlineConstruct>;
	/** The Markdown that starts the line and renders as one unit: a box, a bullet, a heading or quote mark. */
	readonly prefix?: LinePrefix;
	readonly archived: boolean;
	readonly owner?: number;
	readonly blockRole?: BlockRole;
}

export type PrefixKind = 'task' | 'status' | 'bullet' | 'heading' | 'quote';

/**
 * A line's rendered prefix. Task, status and bullet prefixes take visible
 * space (a box, a hanging gap, a dot); heading and quote marks take none.
 */
export interface LinePrefix extends Span {
	readonly kind: PrefixKind;
}

export const prefixHasWidth = (prefix: LinePrefix): boolean =>
	prefix.kind === 'task' || prefix.kind === 'status' || prefix.kind === 'bullet';

export interface Project {
	readonly title: string;
	readonly level: number;
	readonly line: number;
	readonly from: number;
}

export interface Stats {
	readonly done: number;
	readonly cancelled: number;
	readonly open: number;
	readonly total: number;
}

export interface ClassifiedDocument {
	readonly lines: ReadonlyArray<ClassifiedLine>;
	readonly projects: ReadonlyArray<Project>;
	readonly stats: Stats;
	readonly blocks: BlockIndex;
}

interface InlineCandidate {
	readonly from: number;
	readonly to: number;
	readonly spans: ReadonlyArray<InlineSpan>;
}

interface LinkCandidate {
	readonly from: number;
	readonly to: number;
	readonly target: string;
	readonly label: Span;
}

type MutableClassifiedLine = {
	-readonly [Key in keyof ClassifiedLine]: ClassifiedLine[Key];
};

const inlineKinds = new Set<LineKind>(['project', 'task', 'status', 'note', 'prose', 'quote']);

const trimRange = (text: string, from: number, to: number): Span => {
	let start = from;
	let end = to;
	while (start < end && /\s/.test(text[start]!)) start += 1;
	while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
	return { from: start, to: end };
};

const trimBareUrlEnd = (value: string): string => {
	let end = value.length;
	while (end > 0 && /[.,!?;:]/.test(value[end - 1]!)) end -= 1;
	let balance = 0;
	for (let index = 0; index < end; index += 1) {
		if (value[index] === '(') balance += 1;
		else if (value[index] === ')') balance -= 1;
	}
	while (end > 0 && value[end - 1] === ')' && balance < 0) {
		end -= 1;
		balance += 1;
	}
	return value.slice(0, end);
};

const linkCandidates = (text: string, from: number, to: number): LinkCandidate[] => {
	const source = text.slice(from, to);
	const result: LinkCandidate[] = [];

	const markdown = /\[([^\[\]\r\n]*)\]\(([^()\s]+)\)/g;
	for (const match of source.matchAll(markdown)) {
		const value = match[0]!;
		const target = match[2]!;
		const start = from + match.index!;
		result.push({
			from: start,
			to: start + value.length,
			target,
			label: { from: start + 1, to: start + 1 + match[1]!.length }
		});
	}

	const autolink = /<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi;
	for (const match of source.matchAll(autolink)) {
		const value = match[0]!;
		const target = match[1]!;
		const start = from + match.index!;
		result.push({
			from: start,
			to: start + value.length,
			target,
			label: { from: start + 1, to: start + value.length - 1 }
		});
	}

	const bare = /(?:https?:\/\/|mailto:)[^\s<>\[\]]+/gi;
	for (const match of source.matchAll(bare)) {
		const raw = match[0]!;
		const value = trimBareUrlEnd(raw);
		if (!value) continue;
		const start = from + match.index!;
		result.push({
			from: start,
			to: start + value.length,
			target: value,
			label: { from: start, to: start + value.length }
		});
	}

	return result;
};

const tagCandidates = (source: string, from: number): InlineCandidate[] => {
	const result: InlineCandidate[] = [];
	const pattern = /@([\p{L}\p{N}_-]+)(?:[ \t]?\([^()\r\n]*\))?/gu;
	for (const match of source.matchAll(pattern)) {
		const index = match.index!;
		const previous = source[index - 1];
		if (index > 0 && previous !== undefined && !/[\s(]/u.test(previous)) continue;
		const start = from + index;
		result.push({
			from: start,
			to: start + match[0].length,
			spans: [{ from: start, to: start + match[0].length, kind: 'tag', name: match[1]!.toLowerCase() }]
		});
	}
	return result;
};

const inlineCandidates = (text: string, from: number, to: number): InlineCandidate[] => {
	const source = text.slice(from, to);
	const result: InlineCandidate[] = [];

	for (const link of linkCandidates(text, from, to)) {
		const spans: InlineSpan[] = [];
		if (link.from < link.label.from) spans.push({ from: link.from, to: link.label.from, kind: 'linkMark' });
		if (link.label.from < link.label.to) spans.push({ ...link.label, kind: 'link' });
		if (link.label.to < link.to) spans.push({ from: link.label.to, to: link.to, kind: 'linkMark' });
		result.push({ from: link.from, to: link.to, spans });
	}

	const delimited = (start: number, end: number, width: number, kind: InlineKind, mark: InlineKind) => {
		result.push({
			from: start,
			to: end,
			spans: [
				{ from: start, to: start + width, kind: mark },
				{ from: start + width, to: end - width, kind },
				{ from: end - width, to: end, kind: mark }
			]
		});
	};

	const patterns: ReadonlyArray<readonly [RegExp, number, InlineKind, InlineKind]> = [
		[/(\*\*|__)([^\r\n]+?)\1/g, 2, 'strong', 'strongMark'],
		[/~~([^~\r\n]+)~~/g, 2, 'strike', 'strikeMark'],
		[/`([^`\r\n]+)`/g, 1, 'code', 'codeMark']
	];
	for (const [pattern, width, kind, mark] of patterns) {
		for (const match of source.matchAll(pattern)) {
			const start = from + match.index!;
			delimited(start, start + match[0].length, width, kind, mark);
		}
	}
	result.push(...tagCandidates(source, from));

	let opener: number | undefined;
	for (let index = 0; index < source.length; index += 1) {
		if (source[index] !== '*' || source[index - 1] === '*' || source[index + 1] === '*') continue;
		const before = source[index - 1] ?? '';
		const after = source[index + 1] ?? '';
		const beforeSpace = !before || /\s/.test(before);
		const afterSpace = !after || /\s/.test(after);
		const beforePunctuation = /[\p{P}\p{S}]/u.test(before);
		const afterPunctuation = /[\p{P}\p{S}]/u.test(after);
		if (/[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) continue;
		const opens = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
		const closes = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
		if (closes && opener !== undefined) {
			delimited(from + opener, from + index + 1, 1, 'em', 'emMark');
			opener = undefined;
		} else if (opens) opener = index;
	}

	// `_em_` only flanks words from outside, so snake_case and __strong__ never count.
	let underscore: number | undefined;
	for (let index = 0; index < source.length; index += 1) {
		if (source[index] !== '_' || source[index - 1] === '_' || source[index + 1] === '_') continue;
		const before = source[index - 1] ?? '';
		const after = source[index + 1] ?? '';
		const wordBefore = /[\p{L}\p{N}]/u.test(before);
		const wordAfter = /[\p{L}\p{N}]/u.test(after);
		const opens = !wordBefore && !!after && !/\s/.test(after);
		const closes = !wordAfter && !!before && !/\s/.test(before);
		if (closes && underscore !== undefined) {
			delimited(from + underscore, from + index + 1, 1, 'em', 'emMark');
			underscore = undefined;
		} else if (opens) underscore = index;
	}

	return result;
};

const acceptedCandidates = (text: string, line: ClassifiedLine): InlineCandidate[] => {
	if (!inlineKinds.has(line.kind)) return [];
	if (line.blockRole && line.blockRole !== 'details-summary') return [];
	const inlineEnd = line.blockRole === 'details-summary' ? (line.label?.to ?? line.to) : line.to;
	const candidates = inlineCandidates(text, line.label?.from ?? line.quoteMark?.to ?? line.from, inlineEnd).sort(
		(left, right) => left.from - right.from || right.to - right.from - (left.to - left.from)
	);
	const accepted: InlineCandidate[] = [];
	let end = line.from;
	for (const candidate of candidates) {
		if (candidate.from < end) continue;
		accepted.push(candidate);
		end = candidate.to;
	}
	return accepted;
};

/** A styled run with hidden syntax: its delimiters and the text they style. */
export interface InlineConstruct extends Span {
	readonly kind: 'strong' | 'em' | 'strike' | 'code' | 'link';
	readonly marks: ReadonlyArray<Span>;
	readonly content: Span;
}

const constructsOf = (candidates: ReadonlyArray<InlineCandidate>): InlineConstruct[] =>
	candidates.flatMap((candidate) => {
		const marks = candidate.spans.filter((span) => span.kind.endsWith('Mark')).map(({ from, to }) => ({ from, to }));
		if (!marks.length) return [];
		const kind = candidate.spans[0]!.kind.replace(/Mark$/, '') as InlineConstruct['kind'];
		const open = marks[0]!.to;
		const close = marks.length > 1 ? marks[marks.length - 1]!.from : candidate.to;
		return [
			{ from: candidate.from, to: candidate.to, kind, marks, content: { from: open, to: Math.max(open, close) } }
		];
	});

const headingTitleRange = (text: string, line: Line): Span => trimRange(text, line.content, line.to);

const indentationColumns = (text: string, line: Line): number => {
	let column = 0;
	for (let at = line.from; at < line.from + line.indent; at += 1) {
		column += text[at] === '\t' ? 4 - (column % 4) : 1;
	}
	return column;
};

const archivedLines = (all: Line[], text: string): ReadonlySet<number> => {
	const archive = all.findIndex(
		(line) =>
			line.kind === 'heading' &&
			line.level === 2 &&
			line.depth === 0 &&
			text.slice(line.content, line.to).trim() === 'Archive'
	);
	if (archive === -1) return new Set();
	let end = all.length;
	for (let index = archive + 1; index < all.length; index += 1) {
		const line = all[index]!;
		if (line.kind === 'heading' && (line.level === 1 || line.level === 2)) {
			end = index;
			break;
		}
	}
	return new Set(Array.from({ length: end - archive }, (_, offset) => archive + offset));
};

export const classifyDocument = (text: string): ClassifiedDocument => {
	const parsed = lines(text);
	const blocks = scanBlocks(text, parsed);
	const archived = archivedLines(parsed, text);
	const stats = { done: 0, cancelled: 0, open: 0, total: 0 };
	const projects: Project[] = [];
	const owners: number[] = [];
	let rootEnd = 0;

	const classified = parsed.map((line, index): ClassifiedLine => {
		if (index >= rootEnd || line.kind === 'heading') owners.length = 0;
		if (line.kind !== 'blank') {
			while (owners.length && parsed[owners[owners.length - 1]!]!.depth >= line.depth) owners.pop();
		}
		const owner = owners[owners.length - 1];
		const task = line.kind === 'item' && line.state !== undefined && line.checkbox !== undefined;
		if (task) {
			// Root blocks are disjoint. Only scan each root with blockEnd, then track nested owners with the stack.
			if (!owners.length) rootEnd = blockEnd(parsed, index);
			owners.push(index);
		}
		let kind: LineKind;
		if (line.kind === 'heading') kind = 'project';
		else if (task) kind = 'task';
		else if (line.kind === 'item' && owner !== undefined) kind = 'status';
		else if (line.kind === 'paragraph' && owner !== undefined) kind = 'note';
		else if (line.kind === 'paragraph') kind = 'prose';
		else if (line.kind === 'item') kind = 'prose';
		else if (line.kind === 'blank') kind = 'blank';
		else if (line.kind === 'code') kind = 'code';
		else if (line.kind === 'fence') kind = 'fence';
		else if (line.kind === 'quote') kind = 'quote';
		else kind = 'rule';

		const result: MutableClassifiedLine = {
			index,
			from: line.from,
			to: line.to,
			kind,
			depth: line.depth,
			hang: indentationColumns(text, line) + (task ? 4 : kind === 'status' ? 2 : 0),
			empty: task && text.slice(line.content, line.to).trim().length === 0,
			alwaysHidden: [],
			previewHidden: [],
			inline: [],
			constructs: [],
			archived: archived.has(index)
		};
		if (line.level !== undefined) result.level = line.level;
		if (line.state !== undefined) result.state = line.state;
		if (owner !== undefined && (kind === 'status' || kind === 'note')) result.owner = owner;

		if (kind === 'project') {
			const title = headingTitleRange(text, line);
			result.marks = { from: line.from + line.indent, to: line.content };
			result.label = title;
			projects.push({
				title: text.slice(title.from, title.to),
				level: line.level!,
				line: index,
				from: title.from
			});
		} else if (kind === 'task') {
			const listStart = line.from + line.indent;
			result.bullet = { from: listStart, to: line.checkbox! };
			result.checkbox = { from: line.checkbox!, to: line.checkbox! + 3 };
			result.label = { from: line.content, to: line.to };
			if (!result.archived && !result.empty) {
				stats.total += 1;
				if (line.state === 'done') stats.done += 1;
				else if (line.state === 'cancelled') stats.cancelled += 1;
				else stats.open += 1;
			}
		} else if (kind === 'status') {
			result.bullet = { from: line.from + line.indent, to: line.content };
			result.hiddenBullet = result.bullet;
			result.label = { from: line.content, to: line.to };
		} else if (kind === 'note') {
			result.label = { from: line.content, to: line.to };
		} else if (kind === 'quote') {
			const start = line.from + line.indent;
			result.quoteMark = { from: start, to: start + (text[start + 1] === ' ' ? 2 : 1) };
		} else if (kind === 'prose' && line.kind === 'item') {
			result.bullet = { from: line.from + line.indent, to: line.content };
			result.label = { from: line.content, to: line.to };
			if (/[-*+]/.test(text[result.bullet.from]!)) {
				result.dot = { from: result.bullet.from, to: result.bullet.from + 1 };
			}
		}

		const block = blocks.byLine[index];
		if (block) {
			result.blockRole = block.role;
			if (block.title) result.label = block.title;
		}
		const candidates = acceptedCandidates(text, result);
		result.inline = candidates.flatMap((candidate) => candidate.spans);
		result.constructs = constructsOf(candidates);
		// A prefix renders once it is complete: `# `, `- ` and `> ` need their space, as typed.
		if (kind === 'task' && result.bullet && result.label) {
			result.prefix = { from: result.bullet.from, to: result.label.from, kind: 'task' };
		} else if (kind === 'status' && result.bullet) {
			result.prefix = { from: result.bullet.from, to: result.bullet.to, kind: 'status' };
		} else if (result.dot && result.bullet && result.bullet.to > result.dot.to) {
			result.prefix = { from: result.bullet.from, to: result.bullet.to, kind: 'bullet' };
		} else if (kind === 'project' && result.marks && /\s$/.test(text.slice(result.marks.from, result.marks.to))) {
			result.prefix = { ...result.marks, kind: 'heading' };
		} else if (
			kind === 'quote' &&
			result.quoteMark &&
			(result.quoteMark.to - result.quoteMark.from > 1 || result.quoteMark.to < line.to)
		) {
			result.prefix = { ...result.quoteMark, kind: 'quote' };
		}
		if (kind === 'task' && result.bullet && result.bullet.from < result.bullet.to) {
			result.alwaysHidden = [result.bullet];
		}
		const previewHidden: Span[] = [];
		const prefix = result.marks ?? result.quoteMark;
		if (prefix && prefix.from < prefix.to) previewHidden.push(prefix);
		for (const span of result.inline) {
			if (span.kind.endsWith('Mark')) previewHidden.push({ from: span.from, to: span.to });
		}
		result.previewHidden = previewHidden;
		return result;
	});

	return { lines: classified, projects, stats, blocks };
};

/** A link as written in the document: `[label](target)`, `<target>`, or a bare URL. */
export interface LinkRange extends Span {
	readonly label: Span;
	readonly target: string;
}

/** The rendered link on `line` that contains `offset`, honouring the same precedence as the inline styles. */
export const linkRangeOn = (text: string, line: ClassifiedLine, offset: number): LinkRange | undefined => {
	if (!inlineKinds.has(line.kind) || offset < line.from || offset > line.to) return undefined;
	if (line.blockRole && line.blockRole !== 'details-summary') return undefined;
	const title = line.blockRole === 'details-summary' ? line.label : undefined;
	for (const link of linkCandidates(text, title?.from ?? line.from, title?.to ?? line.to)) {
		if (offset < link.from || offset > link.to) continue;
		if (
			line.inline.some(
				(span) => (span.kind === 'link' || span.kind === 'linkMark') && span.from >= link.from && span.to <= link.to
			)
		)
			return { from: link.from, to: link.to, label: link.label, target: link.target };
	}
	return undefined;
};

export const linkRangeAt = (document: ClassifiedDocument, text: string, offset: number): LinkRange | undefined => {
	for (const line of document.lines) {
		if (offset < line.from) break;
		const link = linkRangeOn(text, line, offset);
		if (link) return link;
	}
	return undefined;
};

export const linkAt = (text: string, offset: number): string | undefined =>
	linkRangeAt(classifyDocument(text), text, offset)?.target;

/**
 * Markdown for a link with this text and target. Brackets and line breaks
 * cannot appear in a label, and spaces and parentheses cannot appear in a
 * target, so those are dropped or percent encoded. An empty target leaves
 * plain text; an empty label shows the target.
 */
export const linkMarkdown = (label: string, target: string): string => {
	const url = target.trim().replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
	const text = label.replace(/[\[\]\r\n]/g, '').trim();
	if (!url) return text;
	return `[${text || url}](${url})`;
};

export const formatStats = (stats: Stats): string => `${stats.done + stats.cancelled}/${stats.total} done`;
