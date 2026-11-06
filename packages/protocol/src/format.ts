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
