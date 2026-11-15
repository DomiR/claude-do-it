import type { Author, TodoChange } from './schema.js';
import type { RpcFailure } from './errors.js';

export const describeAuthor = (author: Author): string => {
	switch (author._tag) {
		case 'User':
			return 'the user';
		case 'Agent':
			return author.name;
		case 'File':
			return 'file';
	}
};

export const formatTodoChange = (change: TodoChange): string => `${change.kind} ${change.number}. ${change.text}`;

export const formatVersionHeader = (from: number, to: number, by: ReadonlyArray<Author>): string => {
	const version = from === to || to === from + 1 ? `Version ${to}` : `Versions ${from + 1}-${to}`;
	return by.length === 0 ? version : `${version} by ${by.map(describeAuthor).join(', ')}`;
};

/** The lines a unified diff adds, without their marks, and how many lines it removes. Headers and context are left out. */
export const diffLines = (diff: string): { readonly added: ReadonlyArray<string>; readonly removed: number } => {
	const added: string[] = [];
	let removed = 0;
	let hunk = false;
	for (const line of diff.split('\n')) {
		if (line.startsWith('@@')) hunk = true;
		else if (!hunk) continue;
		else if (line.startsWith('+')) added.push(line.slice(1));
		else if (line.startsWith('-')) removed++;
	}
	return { added, removed };
};

/**
 * A change as `watch --added` prints it: the version header and only the lines
 * it added, so an append only channel such as the inbox does not repeat its
 * context with every message. Removed lines are only counted.
 */
export const formatAdded = (
	change: { readonly from: number; readonly to: number; readonly by: ReadonlyArray<Author> },
	diff: string | null
): string => {
	const header = formatVersionHeader(change.from, change.to, change.by);
	if (diff === null) return `${header}: too large to show, run do-it diff --since ${change.from}`;
	const { added, removed } = diffLines(diff);
	const gone = removed
		? [`(${removed} ${removed === 1 ? 'line' : 'lines'} removed, run do-it diff --since ${change.from})`]
		: [];
	return [added.length || gone.length ? `${header}:` : header, ...added, ...gone].join('\n');
};

export const exitCodeFor = (error: RpcFailure): 1 | 2 | 3 | 4 | 9 => {
	switch (error._tag) {
		case 'Refused':
			return error.code === 'invalid' ? 2 : 1;
		case 'NothingYet':
			return 4;
		case 'DocumentGone':
			return 9;
		case 'Unauthorized':
			return 3;
		case 'VersionMismatch':
		case 'Forgotten':
			return 1;
	}
};
