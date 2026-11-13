import { Duration, Effect, FiberHandle, type Scope } from 'effect';
import { describeAuthor } from './format.js';
import type { Author } from './schema.js';

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

/** Whether every author of a change is the agent `name`, whose own changes a watch skips. */
export function onlyAgent(by: ReadonlyArray<Author>, name: string): boolean {
	return by.length > 0 && by.every((author) => author._tag === 'Agent' && author.name === name);
}

/** Why a settle fired: a quiet period, the shorter period after a new line, or the person asking now (Cmd-S). */
export type SettleReason = 'line' | 'quiet' | 'nudge';

export interface Settled {
	readonly version: number;
	/** Who made the changes since the last settle, each once, as `describeAuthor` names them. */
	readonly by: ReadonlyArray<string>;
	readonly reason: SettleReason;
}

export interface Settler {
	/** A change by `by` to `version`; `before` and `after` are the whole texts, when known. */
	readonly change: (
		version: number,
		by: ReadonlyArray<Author>,
		before: string | undefined,
		after: string | undefined
	) => Effect.Effect<void>;
	/** The watch missed changes and is now at `version`. */
	readonly resync: (version: number) => Effect.Effect<void>;
	/** The person asked to send the latest version now: a pending settle fires at once. */
	readonly nudge: Effect.Effect<void>;
	/** Whether a change waits to settle. */
	readonly pending: () => boolean;
}

/**
 * The settle timer behind `watch --settle` and a registered pane: one `emit`
 * after `settle` quiet seconds, or after `settleLine` seconds when the person's
 * latest change adds a line. Agent changes keep the mode of the person's
 * pending change. The timer runs in the enclosing scope.
 */
export const makeSettler = Effect.fn('makeSettler')(function* (
	options: { readonly settle: number; readonly settleLine: number },
	emit: (settled: Settled) => Effect.Effect<void>
): Effect.fn.Return<Settler, never, Scope.Scope> {
	const timer = yield* FiberHandle.make<void, never>();
	let pending = false;
	let version = 0;
	let by: ReadonlyArray<string> = [];
	let lineAdded = false;
	const fire = (delay: Duration.Duration, reason: SettleReason) =>
		Effect.sleep(delay).pipe(
			Effect.andThen(
				Effect.uninterruptible(
					Effect.suspend(() => {
						// Taking and resetting the state is one synchronous step, so a change
						// that arrives while the event is emitted starts a fresh settle period.
						const settled: Settled = { version, by, reason };
						pending = false;
						by = [];
						lineAdded = false;
						return emit(settled);
					})
				)
			)
		);
	const schedule = (next: number, authors: ReadonlyArray<Author>) =>
		Effect.suspend(() => {
			const names = authors.map(describeAuthor);
			version = next;
			by = [...new Set(pending ? [...by, ...names] : names)];
			pending = true;
			const short = lineAdded && options.settleLine < options.settle;
			return FiberHandle.run(
				timer,
				fire(Duration.millis((short ? options.settleLine : options.settle) * 1000), short ? 'line' : 'quiet')
			).pipe(Effect.asVoid);
		});
	return {
		change: (next, authors, before, after) =>
			Effect.suspend(() => {
				if (authors.some((author) => author._tag !== 'Agent')) lineAdded = personAddsLine(before, after, authors);
				return schedule(next, authors);
			}),
		resync: (next) =>
			Effect.suspend(() => {
				lineAdded = false;
				return schedule(next, []);
			}),
		pending: () => pending,
		nudge: Effect.suspend(() => (pending ? FiberHandle.run(timer, fire(Duration.zero, 'nudge')) : Effect.void)).pipe(
			Effect.asVoid
		)
	};
});
