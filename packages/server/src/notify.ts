import { findSection, isNotFound } from '@do-it/doc';
import {
	Notification,
	Refused,
	formatTodoChange,
	formatVersionHeader,
	makeSettler,
	onlyAgent,
	type HerdrPane,
	type NotifyPayload,
	type NotifySuccess,
	type RpcFailure,
	type UnnotifyPayload,
	type UnnotifySuccess,
	type WatchEvent
} from '@do-it/protocol';
import { Cause, Context, Effect, Fiber, FileSystem, Path, Queue, Schema, Scope, Semaphore, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { rpcTry, type DocumentRegistry } from './documents';
import { readJson, writeJson } from './files';
import { watchDocument } from './watch';
import type { Log } from './log';

type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

const MAX_NOTIFICATIONS = 64;
/** The longest single event, and the most one prompt carries when the pane was busy for a while. */
const MAX_EVENT = 16 * 1024;
const MAX_PROMPT = 64 * 1024;
const RETRY_SECONDS = [2, 5, 10, 30, 60];
const HERDR_TIMEOUT = '30 seconds';

const Saved = Schema.Array(Schema.Struct({ ...Notification.fields, since: Schema.Finite }));

interface Running {
	readonly key: string;
	readonly notification: Notification;
	/** The version the pane has been told about, where a restored or replacing registration resumes. */
	since: number;
	/** Events queued for the pane and not yet sent. `since` moves only past what was sent. */
	outstanding: number;
	/** The newest version that needed no prompt, taken into `since` once nothing is outstanding. */
	quiet: number;
	fiber: Fiber.Fiber<void> | undefined;
}

interface Outgoing {
	readonly text: string;
	readonly version: number;
}

type Delivery = 'sent' | 'retry' | 'gone';

function keyOf(notification: { target: HerdrPane; path: string; section?: string | undefined }): string {
	return JSON.stringify([notification.target.pane, notification.path, notification.section ?? null]);
}

function capped(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n(cut at ${max} characters, run do-it read)`;
}

/**
 * The Herdr panes registered with `do-it notify`. Each one gets the events a
 * `do-it watch` with the same options would print, as prompts sent with
 * `herdr agent prompt`, so the agent in the pane needs no watch of its own.
 * Registrations are kept in notify.json and come back when the daemon restarts.
 * A registration ends when its document is deleted or its pane is closed.
 */
export class Notifications {
	private readonly running = new Map<string, Running>();
	/** Registering and unregistering one at a time, so two calls for one pane never both start a prompt loop. */
	private readonly lock = Semaphore.makeUnsafe(1);
	private closing = false;
	private saving: Fiber.Fiber<void> | undefined;
	private constructor(
		private readonly file: string,
		private readonly registry: DocumentRegistry,
		private readonly log: Log,
		private readonly context: Context.Context<Platform>,
		private readonly scope: Scope.Scope
	) {}

	/** Restores the saved registrations. Their prompts run in the scope this is made in. */
	static readonly make = Effect.fn('Notifications.make')(function* (
		home: string,
		registry: DocumentRegistry,
		log: Log
	) {
		const path = yield* Path.Path;
		const notifications = new Notifications(
			path.join(home, 'notify.json'),
			registry,
			log,
			yield* Effect.context<Platform>(),
			// Its own scope, closed after `close`: the enclosing scope would interrupt the
			// prompts first, and they would look ended and be dropped from notify.json.
			yield* Scope.fork(yield* Effect.scope)
		);
		const saved = yield* readJson(notifications.file).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Saved)),
			Effect.catch((error) =>
				isNotFound(error)
					? Effect.succeed([])
					: Effect.as(log.write(`Could not read notify.json, starting without registered panes: ${String(error)}`), [])
			)
		);
		yield* Effect.forEach(
			saved.slice(0, MAX_NOTIFICATIONS),
			({ since, ...notification }) => notifications.start(notification, since),
			{ discard: true }
		);
		return notifications;
	});

	list(): ReadonlyArray<Notification> {
		return [...this.running.values()].map((running) => running.notification);
	}

	register(payload: NotifyPayload): Effect.Effect<NotifySuccess, RpcFailure> {
		return Effect.gen({ self: this }, function* () {
			const { since, ...rest } = payload;
			const path = yield* this.registry.validate(payload.path);
			const version = yield* this.registry.withEntry(path, (entry) =>
				Effect.as(
					payload.section === undefined ? Effect.void : rpcTry(() => findSection(entry.doc.text, payload.section!)),
					entry.doc.version
				)
			);
			const notification: Notification = { ...rest, path };
			if (this.closing)
				return yield* Effect.fail(new Refused({ code: 'invalid', message: 'The daemon is shutting down' }));
			const old = this.running.get(keyOf(notification));
			if (!old && this.running.size >= MAX_NOTIFICATIONS)
				return yield* Effect.fail(
					new Refused({ code: 'too-large', message: `At most ${MAX_NOTIFICATIONS} panes may be registered` })
				);
			if (old) yield* this.stop(old);
			// A replacement resumes where the old one was, so the events it had not sent yet still come.
			yield* this.start(notification, since ?? old?.since ?? version);
			yield* this.save;
			return { version, replaced: old !== undefined };
		}).pipe((effect) => this.lock.withPermit(effect));
	}

	unregister(payload: UnnotifyPayload): Effect.Effect<UnnotifySuccess, RpcFailure> {
		return Effect.gen({ self: this }, function* () {
			const paths = yield* Path.Path.pipe(Effect.provideContext(this.context));
			const path = payload.path === undefined ? undefined : paths.resolve(payload.path);
			const matching = [...this.running.values()].filter(
				(running) =>
					running.notification.target.pane === payload.pane &&
					(path === undefined || running.notification.path === path)
			);
			yield* Effect.forEach(matching, (running) => this.stop(running), { discard: true });
			if (matching.length) yield* this.save;
			return { removed: matching.length };
		}).pipe((effect) => this.lock.withPermit(effect));
	}

	/** Saves where every pane is and stops prompting. The registrations come back with the next daemon. */
	close(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (this.closing) return;
			this.closing = true;
			const saving = this.saving;
			this.saving = undefined;
			if (saving) yield* Fiber.interrupt(saving);
			// Stopped first, so no `since` moves after it is written.
			yield* Fiber.interruptAll(
				[...this.running.values()].flatMap((running) => (running.fiber ? [running.fiber] : []))
			);
			yield* this.write;
		});
	}

	private start(notification: Notification, since: number): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			const running: Running = {
				key: keyOf(notification),
				notification,
				since,
				outstanding: 0,
				quiet: since,
				fiber: undefined
			};
			this.running.set(running.key, running);
			running.fiber = yield* Effect.forkIn(
				this.run(running).pipe(
					Effect.ensuring(
						Effect.suspend(() => {
							// A registration that ended by itself is forgotten. One stopped for a
							// replacement or a shutdown is not, or the shutdown would lose it.
							if (this.closing || this.running.get(running.key) !== running) return Effect.void;
							this.running.delete(running.key);
							return this.save;
						})
					)
				),
				this.scope
			);
		});
	}

	private stop(running: Running): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (this.running.get(running.key) === running) this.running.delete(running.key);
			return running.fiber ? Fiber.interrupt(running.fiber) : Effect.void;
		});
	}

	/** Watches the document and prompts the pane until the document or the pane is gone. */
	private run(running: Running): Effect.Effect<void> {
		const notification = running.notification;
		return Effect.scoped(
			Effect.gen({ self: this }, function* () {
				// null marks the end: the prompts before it still go out.
				const outbox = yield* Queue.unbounded<Outgoing | null>();
				const say = (text: string, version: number) =>
					Effect.suspend(() => {
						running.outstanding++;
						return Queue.offer(outbox, { text: capped(text, MAX_EVENT), version });
					});
				const settle = notification.settle;
				const settler =
					settle === undefined
						? undefined
						: yield* makeSettler({ settle, settleLine: Math.min(notification.settleLine ?? 2, settle) }, (settled) =>
								say(
									`Settled at version ${settled.version}${settled.by.length ? ` by ${settled.by.join(', ')}` : ''}`,
									settled.version
								)
							);
				// A change the pane needs no prompt for. Once nothing waits to go out, a restart
				// need not report it as missed.
				const passed = (version: number) => {
					if (settler?.pending()) return;
					running.quiet = Math.max(running.quiet, version);
					if (running.outstanding === 0) running.since = Math.max(running.since, running.quiet);
				};
				let lastText: string | undefined;
				const onEvent = (event: WatchEvent): Effect.Effect<boolean> =>
					Effect.gen(function* () {
						switch (event._tag) {
							case 'Watching':
								lastText = event.text;
								return true;
							case 'Resync':
								lastText = event.text;
								yield* say(`Missed changes, now at version ${event.version}: run do-it read`, event.version);
								if (settler) yield* settler.resync(event.version);
								return true;
							case 'Deleted':
								yield* say(`Deleted ${notification.label}, no more prompts for it`, running.since);
								return false;
							case 'Nudge':
								if (settler) yield* settler.nudge;
								return true;
							case 'Change': {
								const before = lastText;
								lastText = event.text;
								if (onlyAgent(event.by, notification.as)) {
									passed(event.to);
									return true;
								}
								if (settler) yield* settler.change(event.to, event.by, before, event.text);
								else if (!notification.todos)
									yield* say(
										event.diff
											? `${formatVersionHeader(event.from, event.to, event.by)}\n${event.diff}`
											: formatVersionHeader(event.from, event.to, event.by),
										event.to
									);
								else if (event.todos.length) yield* say(event.todos.map(formatTodoChange).join('\n'), event.to);
								else passed(event.to);
								return true;
							}
						}
					});
				const watch = watchDocument(this.registry, {
					path: notification.path,
					since: running.since,
					...(notification.section === undefined ? {} : { section: notification.section }),
					text: settler !== undefined,
					nudges: true
				}).pipe(
					Stream.takeWhileEffect(onEvent),
					Stream.runDrain,
					Effect.catchCauseIf(
						(cause) => !Cause.hasInterruptsOnly(cause),
						(cause) =>
							say(`Stopped prompting about ${notification.label}: ${String(Cause.squash(cause))}`, running.since)
					),
					Effect.andThen(Queue.offer(outbox, null))
				);
				yield* Effect.forkScoped(watch);
				yield* this.deliver(running, outbox);
			})
		);
	}

	/** Sends the outbox to the pane, all waiting events in one prompt. Returns at the end mark or when the pane is gone. */
	private deliver(running: Running, outbox: Queue.Queue<Outgoing | null>): Effect.Effect<void> {
		const notification = running.notification;
		return Effect.gen({ self: this }, function* () {
			let held: Outgoing[] = [];
			let heldVersion = 0;
			let dropped = 0;
			let ending = false;
			let attempt = 0;
			const absorb = (items: ReadonlyArray<Outgoing | null>) => {
				for (const item of items) {
					if (item === null) ending = true;
					else {
						held.push(item);
						heldVersion = Math.max(heldVersion, item.version);
					}
				}
				while (held.length > 1 && held.reduce((total, item) => total + item.text.length + 1, 0) > MAX_PROMPT) {
					held.shift();
					dropped++;
				}
			};
			while (true) {
				if (held.length === 0) {
					if (ending) return;
					absorb(yield* Queue.takeAll(outbox));
					continue;
				}
				const events = [
					...(dropped ? [`${dropped} earlier events left out, run do-it read`] : []),
					...held.map((item) => item.text)
				];
				const text = events.map((event) => `[do-it] ${notification.label}: ${event}`).join('\n');
				const result = yield* this.prompt(notification.target, text);
				if (result === 'gone') {
					yield* this.log.write(
						`Pane ${notification.target.pane} is gone, stopped prompting about ${notification.path}`
					);
					return;
				}
				if (result === 'sent') {
					running.outstanding -= held.length + dropped;
					running.since = Math.max(running.since, heldVersion);
					if (running.outstanding === 0) running.since = Math.max(running.since, running.quiet);
					yield* this.save;
					held = [];
					heldVersion = 0;
					dropped = 0;
					attempt = 0;
					continue;
				}
				yield* Effect.sleep(`${RETRY_SECONDS[Math.min(attempt++, RETRY_SECONDS.length - 1)]!} seconds`);
				absorb(yield* Queue.clear(outbox));
			}
		});
	}

	/** One `herdr agent prompt`. A pane that still exists without an agent in it is tried again later. */
	private prompt(target: HerdrPane, text: string): Effect.Effect<Delivery> {
		return Effect.gen({ self: this }, function* () {
			const sent = yield* this.herdr(target, ['agent', 'prompt', target.pane, text]);
			if (sent.code === 0) return 'sent';
			if (sent.error === 'pane_not_found') return 'gone';
			if (sent.error === 'agent_not_found') {
				const pane = yield* this.herdr(target, ['pane', 'get', target.pane]);
				if (pane.error === 'pane_not_found') return 'gone';
			}
			// An agent at an approval dialog refuses prompts until the person answers it.
			if (sent.error !== 'agent_blocked')
				yield* this.log.write(
					`Could not prompt pane ${target.pane}, trying again: ${sent.error ?? `exit ${sent.code}`} ${sent.output.slice(0, 500)}`
				);
			return 'retry';
		});
	}

	private herdr(
		target: HerdrPane,
		args: ReadonlyArray<string>
	): Effect.Effect<{ code: number; error: string | undefined; output: string }> {
		// Only a program named herdr: the daemon must not become a way to run any binary.
		const bin = target.bin !== undefined && /(^|\/)herdr$/.test(target.bin) ? target.bin : 'herdr';
		const command = ChildProcess.make(bin, args, {
			env: target.socket === undefined ? {} : { HERDR_SOCKET_PATH: target.socket },
			extendEnv: true,
			stdin: 'ignore'
		});
		return Effect.scoped(
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const child = yield* spawner.spawn(command);
				const [output, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(child.all)), child.exitCode], {
					concurrency: 2
				});
				const error = /"code"\s*:\s*"([a-z_]+)"/.exec(output)?.[1];
				return { code: Number(code), error, output };
			})
		).pipe(
			Effect.timeout(HERDR_TIMEOUT),
			Effect.catch((error) => Effect.succeed({ code: -1, error: undefined, output: String(error) })),
			Effect.provideContext(this.context)
		);
	}

	/** Saves the registrations a second after the first change, so a burst of events writes once. */
	private get save(): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (this.closing || this.saving) return Effect.void;
			const save = Effect.suspend(() => {
				this.saving = undefined;
				return this.write;
			});
			return Effect.asVoid(
				Effect.tap(Effect.forkIn(Effect.delay(save, '1 second'), this.scope), (fiber) =>
					Effect.sync(() => {
						this.saving = fiber;
					})
				)
			);
		});
	}

	private get write(): Effect.Effect<void> {
		return Effect.suspend(() =>
			writeJson(
				this.file,
				[...this.running.values()].map((running) => ({ ...running.notification, since: running.since }))
			).pipe(
				Effect.provideContext(this.context),
				Effect.catch((error) => this.log.write(`Could not save notify.json: ${String(error)}`))
			)
		);
	}
}

export class Notifier extends Context.Service<Notifier, Notifications>()('@do-it/server/Notifier') {}
