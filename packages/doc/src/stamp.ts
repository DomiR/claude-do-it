import type { Edit } from './edit';
import { lines } from './markdown';
import type { TaskState, Todo } from './todo';

export type StampTag = 'started' | 'done' | 'cancelled' | 'lasted';

const stampNames = 'started|done|cancelled|lasted';

/**
 * A stamp is a tag with its parentheses, such as `@started(26-11-05 10:00)`
 * or `@done (26-11-05 10:00)`. A bare `@started` is the person's own word and
 * is never matched, replaced or removed.
 */
function stampPattern(tag?: StampTag): RegExp {
	const name = tag ?? stampNames;
	return new RegExp(`(?:^|[ \\t]+)@(?:${name})(?![A-Za-z0-9_])[ \\t]*\\([^()\\r\\n]*\\)`, 'g');
}

function removeStamp(label: string, tag: StampTag): string {
	return label.replace(stampPattern(tag), '');
}

function hasStamp(label: string, tag: StampTag): boolean {
	return stampPattern(tag).test(label);
}

function taskLabel(text: string, todo: Todo): { from: number; to: number; body: string } | null {
	const line = lines(text)[todo.line];
	if (!line || line.state === undefined) return null;
	return { from: line.content, to: line.to, body: text.slice(line.content, line.to) };
}

function stampText(label: string, stamp: string): string {
	const trailing = /[ \t]*$/.exec(label)!;
	const core = label.slice(0, trailing.index);
	const project = /[ \t]+@project(?:[ \t]*\([^()\r\n]*\))?$/.exec(core);
	const beforeProject = project ? core.slice(0, project.index) : core;
	const prefix = beforeProject.trimEnd();
	const withStamp = prefix ? `${prefix} ${stamp}` : stamp;
	return `${withStamp}${project?.[0] ?? ''}${trailing[0]}`;
}

function labelEdit(text: string, todo: Todo, make: (label: string) => string): Edit[] {
	const target = taskLabel(text, todo);
	if (!target) return [];
	const insert = make(target.body);
	return insert === target.body ? [] : [{ from: target.from, to: target.to, insert }];
}

function stampTextFor(tag: StampTag, date: Date): string {
	const formatted = formatStamp(date);
	return tag === 'started' ? `@${tag}(${formatted})` : `@${tag} (${formatted})`;
}

/** The date of a `@started(yy-mm-dd HH:MM)` stamp, in local time, or null when there is none. */
export function startedAt(label: string): Date | null {
	const match = /(?:^|[ \t])@started[ \t]*\((\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\)/.exec(label);
	if (!match) return null;
	const [, year, month, day, hours, minutes] = match.map(Number);
	return new Date(2000 + year!, month! - 1, day!, hours!, minutes!);
}

/**
 * A local time's wall clock reading in milliseconds, to the minute. Spans
 * between two readings ignore daylight saving changes, as PlainTasks' naive
 * dates do, and match the minutes the stamps show.
 */
const wallClock = (date: Date): number =>
	Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes());

/**
 * How long a task lasted, as PlainTasks writes it: Python's timedelta text
 * with zero seconds and a zero time of day dropped, such as `0:05`, `2:30`,
 * `1 day, 2:30` or `3 days`. Stamps have minute precision, and a negative
 * span (a clock moved back) counts as none.
 */
export function formatLasted(milliseconds: number): string {
	const total = Math.max(0, Math.floor(milliseconds / 60_000));
	const days = Math.floor(total / 1440);
	const hours = Math.floor((total % 1440) / 60);
	const minutes = total % 60;
	const time = `${hours}:${String(minutes).padStart(2, '0')}`;
	if (!days) return time;
	const dayText = `${days} day${days === 1 ? '' : 's'}`;
	return hours || minutes ? `${dayText}, ${time}` : dayText;
}

function checkboxEdit(text: string, todo: Todo, state: TaskState): Edit[] {
	const line = lines(text)[todo.line];
	if (!line || line.checkbox === undefined || line.state === state) return [];
	const insert = state === 'done' ? '[x]' : state === 'cancelled' ? '[-]' : '[ ]';
	return [{ from: line.checkbox, to: line.checkbox + 3, insert }];
}

export function formatStamp(date: Date): string {
	const two = (value: number): string => String(value).padStart(2, '0');
	return `${two(date.getFullYear() % 100)}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function stampTodo(text: string, todo: Todo, tag: StampTag, date: Date): Edit[] {
	const stamp = stampTextFor(tag, date);
	return labelEdit(text, todo, (label) => stampText(removeStamp(label, tag), stamp));
}

export function unstampTodo(text: string, todo: Todo, tag: StampTag): Edit[] {
	return labelEdit(text, todo, (label) => removeStamp(label, tag));
}

export function setTodoStateStamped(text: string, todo: Todo, state: TaskState, date: Date): Edit[] {
	const currentState = lines(text)[todo.line]?.state;
	const edits = checkboxEdit(text, todo, state);
	const tag = state === 'done' ? 'done' : state === 'cancelled' ? 'cancelled' : null;
	const labelEdits = labelEdit(text, todo, (label) => {
		let next = label;
		// @lasted belongs to @done, so it goes whenever @done does.
		if (state === 'done') next = removeStamp(next, 'cancelled');
		else if (state === 'cancelled') next = removeStamp(removeStamp(next, 'done'), 'lasted');
		else next = removeStamp(removeStamp(removeStamp(next, 'done'), 'cancelled'), 'lasted');
		if (tag && (currentState !== state || !hasStamp(next, tag))) {
			let stamp = stampTextFor(tag, date);
			// As PlainTasks does: a started task records how long it took when it is done.
			const started = tag === 'done' ? startedAt(next) : null;
			if (started) stamp += ` @lasted(${formatLasted(wallClock(date) - wallClock(started))})`;
			next = stampText(removeStamp(removeStamp(next, tag), 'lasted'), stamp);
		}
		return next;
	});
	return [...edits, ...labelEdits].sort((a, b) => a.from - b.from || a.to - b.to);
}

/** The label without PlainTasks stamp tags (@started, @done, @cancelled with or without dates). */
export function withoutStamps(label: string): string {
	return label.replace(stampPattern(), '').trim();
}
