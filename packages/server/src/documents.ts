import { Document, DocError, readFile, stamp, writeAtomic, type Format, type Stamp } from '@do-it/doc';
import { DocumentGone, Forgotten, Refused, VersionMismatch, type RpcFailure } from '@do-it/protocol';
import { Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Scope, Semaphore } from 'effect';
import { TEMPLATE } from './config';
import type { Log } from './log';
import type { Versions } from './versions';
import { watchFile } from './watcher';

const MAX_OPEN = 64;
const WRITE_DEBOUNCE = '25 millis';
const MISSING_GRACE = '500 millis';

export interface OpenDocument {
	path: string;
	doc: Document;
	signal: Deferred.Deferred<void>;
	format: Format;
	stamp: Stamp;
	watchers: number;
	waiters: number;
	lastUsed: number;
	deleted: boolean;
	/** Set once the entry has left the registry and its document has been freed. */
	closed: boolean;
	/** Serialises this document's disk reads and writes. */
	lock: Semaphore.Semaphore;
	/** Owns the file watcher. */
	scope: Scope.Closeable;
	writing: Fiber.Fiber<void> | undefined;
	missing: Fiber.Fiber<void> | undefined;
	/** The newest version hashed so far. In one entry a version number always names one text. */
	hash: { version: number; value: string } | undefined;
}

export function rpcError(error: unknown, latest = 1): RpcFailure {
	if (error instanceof DocError) {
		if (error.code === 'conflict' && error.conflict) {
			const c = error.conflict;
			return new VersionMismatch({ latest: c.current, since: c.expected, diff: c.diff, forgotten: c.forgotten });
		}
		if (error.code === 'forgotten') return new Forgotten({ latest });
		return new Refused({ code: error.code === 'conflict' ? 'invalid' : error.code, message: error.message });
	}
	if (
		error instanceof Refused ||
		error instanceof DocumentGone ||
		error instanceof Forgotten ||
		error instanceof VersionMismatch
	)
		return error;
	return new Refused({ code: 'invalid', message: error instanceof Error ? error.message : String(error) });
}

export function rpcTry<A>(f: () => A, latest?: () => number): Effect.Effect<A, RpcFailure> {
	return Effect.try({ try: f, catch: (error) => rpcError(error, latest?.()) });
}

function same(a: Stamp, b: Stamp): boolean {
	return a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.size === b.size;
}

type Disk = FileSystem.FileSystem | Path.Path;

export class DocumentRegistry {
	private readonly entries = new Map<string, OpenDocument>();
	/** Two first opens of one path must not both create an entry. */
	private readonly opening = Semaphore.makeUnsafe(1);
	totalWatchers = 0;
	private closing = false;
	private constructor(
		readonly versions: Versions,
		private readonly log: Log,
		private readonly context: Context.Context<Disk>,
		private readonly scope: Scope.Scope
	) {}

	/** Timers and watchers run in the scope this is made in. */
	static readonly make = Effect.fn('DocumentRegistry.make')(function* (versions: Versions, log: Log) {
		return new DocumentRegistry(versions, log, yield* Effect.context<Disk>(), yield* Effect.scope);
	});

	private disk<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Disk>> {
		return Effect.provideContext(effect, this.context);
	}

	/** Logs a failure instead of propagating it. Interruption still propagates. */
	private logged<E>(message: string, effect: Effect.Effect<void, E>): Effect.Effect<void> {
		return effect.pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.failCause(cause as Cause.Cause<never>)
					: this.log.write(`${message}: ${String(Cause.squash(cause))}`)
			)
		);
	}

	validate(input: string): Effect.Effect<string, RpcFailure> {
		return this.disk(
			Effect.gen({ self: this }, function* () {
				const paths = yield* Path.Path;
				const fs = yield* FileSystem.FileSystem;
				if (!paths.isAbsolute(input) || !['.md', '.markdown'].includes(paths.extname(input).toLowerCase())) {
					return yield* Effect.fail(
						new Refused({ code: 'invalid', message: 'The path must be absolute and end in .md or .markdown' })
					);
				}
				const path = paths.resolve(input);
				const directory = yield* fs.stat(paths.dirname(path)).pipe(
					Effect.map((info) => info.type === 'Directory'),
					Effect.catch(() => Effect.succeed(false))
				);
				if (!directory) {
					if (this.entries.has(path) || this.versions.has(path)) return yield* Effect.fail(new DocumentGone({ path }));
					return yield* Effect.fail(
						new Refused({ code: 'invalid', message: "The document's parent directory must exist" })
					);
				}
				return path;
			})
		);
	}

	open(input: string, create = false): Effect.Effect<{ entry: OpenDocument; created: boolean }, RpcFailure> {
		return this.acquire(input, create, false);
	}

	get(path: string): Effect.Effect<OpenDocument, RpcFailure> {
		return Effect.map(this.open(path), ({ entry }) => entry);
	}

	/** Runs `use` with the open document, which cannot be evicted until `use` completes. */
	withEntry<A, E, R>(
		path: string,
		use: (entry: OpenDocument) => Effect.Effect<A, E, R>,
		create = false
	): Effect.Effect<A, E | RpcFailure, R> {
		return this.withOpened(path, ({ entry }) => use(entry), create);
	}

	withOpened<A, E, R>(
		path: string,
		use: (opened: { entry: OpenDocument; created: boolean }) => Effect.Effect<A, E, R>,
		create = false
	): Effect.Effect<A, E | RpcFailure, R> {
		return Effect.acquireUseRelease(this.acquire(path, create, true), use, ({ entry }) =>
			Effect.sync(() => {
				entry.waiters--;
				entry.lastUsed = Date.now();
			})
		);
	}

	private acquire(
		input: string,
		create: boolean,
		pin: boolean
	): Effect.Effect<{ entry: OpenDocument; created: boolean }, RpcFailure> {
		return Effect.gen({ self: this }, function* () {
			const path = yield* this.validate(input);
			while (true) {
				if (this.closing)
					return yield* Effect.fail(new Refused({ code: 'invalid', message: 'The daemon is shutting down' }));
				const existing = this.entries.get(path);
				const opened = existing
					? yield* this.reuse(existing)
					: yield* this.opening.withPermit(
							Effect.suspend(() => {
								const raced = this.entries.get(path);
								return raced ? this.reuse(raced) : this.create(path, create);
							})
						);
				// An idle entry can be evicted while its file is checked. Open it again.
				if (opened.entry.closed) continue;
				// Checked and pinned in one step, so an eviction sees the pin or this sees the eviction.
				if (pin) opened.entry.waiters++;
				return opened;
			}
		}).pipe(Effect.mapError((error) => rpcError(error)));
	}
	status() {
		return [...this.entries.values()].map((entry) => ({
			path: entry.path,
			version: entry.doc.version,
			watchers: entry.watchers
		}));
	}

	private reuse(entry: OpenDocument) {
		entry.lastUsed = Date.now();
		return this.disk(stamp(entry.path)).pipe(
			Effect.flatMap((current) =>
				entry.deleted || current === null
					? Effect.fail(new DocumentGone({ path: entry.path }))
					: Effect.succeed({ entry, created: false })
			)
		);
	}

	private create(path: string, create: boolean) {
		const prepare = Effect.gen({ self: this }, function* () {
			const missing = (yield* this.disk(stamp(path))) === null;
			if (missing && !create) {
				if (this.versions.has(path)) return yield* Effect.fail(new DocumentGone({ path }));
				return yield* Effect.fail(
					new Refused({ code: 'invalid', message: 'The document does not exist, open it with create enabled' })
				);
			}
			yield* this.makeRoom();
			if (missing) yield* this.disk(writeAtomic(path, TEMPLATE, { bom: false, crlf: false }));
			return { missing, file: yield* this.disk(readFile(path)) };
		});
		// Once the document exists it must reach the registry, or it would never be freed.
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen({ self: this }, function* () {
				const { missing, file } = yield* restore(prepare);
				const doc = yield* this.versions.open(path, file.text);
				const entry: OpenDocument = {
					path,
					doc,
					signal: Deferred.makeUnsafe<void>(),
					format: file.format,
					stamp: file.stamp,
					watchers: 0,
					waiters: 0,
					lastUsed: Date.now(),
					deleted: false,
					closed: false,
					lock: Semaphore.makeUnsafe(1),
					scope: yield* Scope.fork(this.scope),
					writing: undefined,
					missing: undefined,
					hash: undefined
				};
				this.entries.set(path, entry);
				yield* this.disk(watchFile(path, this.poll(entry))).pipe(Scope.provide(entry.scope));
				return { entry, created: missing };
			})
		);
	}

	private makeRoom(): Effect.Effect<void, Refused> {
		return Effect.gen({ self: this }, function* () {
			if (this.entries.size < MAX_OPEN) return;
			const idle = [...this.entries.values()]
				.filter((entry) => entry.watchers === 0 && entry.waiters === 0)
				.sort((a, b) => a.lastUsed - b.lastUsed);
			for (const entry of idle) {
				yield* this.flush(entry);
				if (yield* this.evict(entry)) return;
			}
			return yield* Effect.fail(
				new Refused({
					code: 'too-large',
					message: 'At most 64 documents may be open, all available documents are busy'
				})
			);
		});
	}

	notify(entry: OpenDocument): void {
		const signal = entry.signal;
		entry.signal = Deferred.makeUnsafe<void>();
		Deferred.doneUnsafe(signal, Effect.void);
	}

	/** Call after changing `entry.doc` in memory: wakes waiters, records the version, and schedules a write. */
	changed(entry: OpenDocument, previous: number): Effect.Effect<void> {
		if (entry.doc.version === previous) return Effect.void;
		entry.lastUsed = Date.now();
		this.notify(entry);
		return Effect.andThen(
			this.versions.record(entry.path, entry.doc.version, entry.doc.text),
			this.scheduleWrite(entry)
		);
	}

	/** The hash of `text`, which the entry held at `version`. Takes the text so a caller can read it before yielding. */
	hashOf(entry: OpenDocument, version: number, text: string): Effect.Effect<string> {
		return Effect.suspend(() => {
			if (entry.hash?.version === version) return Effect.succeed(entry.hash.value);
			return Effect.tap(this.versions.sha256(text), (value) =>
				Effect.sync(() => {
					if (version > (entry.hash?.version ?? 0)) entry.hash = { version, value };
				})
			);
		});
	}

	/** The hash of the text at `version`, or null when the document no longer keeps that version. */
	hashAt(entry: OpenDocument, version: number): Effect.Effect<string | null> {
		return Effect.suspend(() => {
			if (entry.hash?.version === version) return Effect.succeed(entry.hash.value);
			const text = entry.doc.textAt(version);
			return text === null ? Effect.succeed(null) : this.hashOf(entry, version, text);
		});
	}

	subscribe(entry: OpenDocument): () => void {
		if (entry.deleted) throw new DocumentGone({ path: entry.path });
		if (entry.watchers >= 32 || this.totalWatchers >= 256) {
			throw new Refused({ code: 'too-large', message: 'The document or daemon watch stream limit has been reached' });
		}
		entry.watchers++;
		this.totalWatchers++;
		return () => {
			entry.watchers--;
			this.totalWatchers--;
			entry.lastUsed = Date.now();
		};
	}

	private scheduleWrite(entry: OpenDocument): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (entry.writing || this.closing || entry.deleted || entry.closed || !entry.doc.dirty) return Effect.void;
			const write = Effect.suspend(() => {
				entry.writing = undefined;
				return this.flushNow(entry);
			});
			return Effect.forkIn(Effect.delay(write, WRITE_DEBOUNCE), this.scope).pipe(
				Effect.map((fiber) => {
					entry.writing = fiber;
				})
			);
		});
	}

	/** Merges the file into the document when it changed on disk. */
	poll(entry: OpenDocument): Effect.Effect<void> {
		return entry.lock.withPermit(this.pollLocked(entry));
	}

	private pollLocked(entry: OpenDocument): Effect.Effect<void> {
		return this.logged(
			`Could not merge ${entry.path}`,
			Effect.gen({ self: this }, function* () {
				if (entry.deleted || entry.closed || this.closing) return;
				const current = yield* this.disk(stamp(entry.path));
				if (!current) {
					if (!entry.missing) entry.missing = yield* Effect.forkIn(this.recheck(entry), this.scope);
					return;
				}
				if (entry.missing) {
					const missing = entry.missing;
					entry.missing = undefined;
					yield* Fiber.interrupt(missing);
				}
				if (!same(entry.stamp, current)) {
					const file = yield* this.disk(readFile(entry.path));
					const previous = entry.doc.version;
					entry.doc.mergeFile(file.text);
					entry.format = file.format;
					entry.stamp = file.stamp;
					yield* this.changed(entry, previous);
					yield* this.versions.record(entry.path, entry.doc.version, entry.doc.text);
					yield* this.compact(entry);
				}
				yield* this.scheduleWrite(entry);
			}).pipe(Effect.uninterruptible)
		);
	}

	/** A file can vanish briefly while an editor replaces it. Only a lasting absence deletes the document. */
	private recheck(entry: OpenDocument): Effect.Effect<void> {
		const check = Effect.suspend(() => {
			entry.missing = undefined;
			return entry.lock
				.withPermit(
					Effect.gen({ self: this }, function* () {
						if (entry.deleted || entry.closed || this.closing) return false;
						if ((yield* this.disk(stamp(entry.path))) === null) return true;
						yield* this.pollLocked(entry);
						return false;
					})
				)
				.pipe(Effect.flatMap((gone) => (gone ? this.deleted(entry) : Effect.void)));
		});
		return this.logged(`Could not check ${entry.path}`, Effect.delay(check, MISSING_GRACE));
	}

	/** Writes pending changes now, cancelling the debounce. */
	flush(entry: OpenDocument): Effect.Effect<void> {
		return Effect.suspend(() => {
			const timer = entry.writing;
			entry.writing = undefined;
			return Effect.andThen(timer ? Fiber.interrupt(timer) : Effect.void, this.flushNow(entry));
		});
	}

	private flushNow(entry: OpenDocument): Effect.Effect<void> {
		return entry.lock.withPermit(this.flushLocked(entry));
	}

	private flushLocked(entry: OpenDocument): Effect.Effect<void> {
		let ticket: ReturnType<Document['toWrite']> | undefined;
		const write = Effect.gen({ self: this }, function* () {
			if (entry.deleted || entry.closed) return;
			// Read before writing so an external edit arriving during the debounce
			// becomes a merge, rather than being silently overwritten.
			const current = yield* this.disk(stamp(entry.path));
			if (!current) {
				if (!this.closing) yield* this.pollLocked(entry);
				return;
			}
			if (!same(entry.stamp, current)) {
				const file = yield* this.disk(readFile(entry.path));
				const previous = entry.doc.version;
				entry.doc.mergeFile(file.text);
				entry.format = file.format;
				entry.stamp = file.stamp;
				if (entry.doc.version !== previous) this.notify(entry);
			}
			if (entry.doc.dirty) {
				ticket = entry.doc.toWrite();
				entry.stamp = yield* this.disk(writeAtomic(entry.path, ticket.text, entry.format));
				entry.doc.wrote(ticket);
				ticket = undefined;
			}
			yield* this.versions.record(entry.path, entry.doc.version, entry.doc.text);
			yield* this.compact(entry);
		}).pipe(
			Effect.onError(() =>
				Effect.sync(() => {
					if (ticket) entry.doc.notWritten(ticket);
				})
			)
		);
		return this.logged(`Could not write ${entry.path}`, Effect.uninterruptible(write));
	}

	private compact(entry: OpenDocument): Effect.Effect<void> {
		const compacted = entry.doc.compact();
		return compacted
			? this.log.write(
					`Compacted ${entry.path} at version ${entry.doc.version} (${compacted.reason}: ${compacted.ops} ops, ${compacted.peers} peers), kept versions ${compacted.oldest}-${entry.doc.version}`
				)
			: Effect.void;
	}

	private deleted(entry: OpenDocument): Effect.Effect<void> {
		return Effect.suspend(() => {
			entry.deleted = true;
			this.notify(entry);
			return this.closeEntry(entry);
		});
	}

	/** Closes an idle entry with nothing left to write. False when it became busy or still has changes. */
	private evict(entry: OpenDocument): Effect.Effect<boolean> {
		return entry.lock.withPermit(
			Effect.suspend(() => {
				if (entry.closed) return Effect.succeed(true);
				if (entry.watchers > 0 || entry.waiters > 0 || (!entry.deleted && entry.doc.dirty))
					return Effect.succeed(false);
				return Effect.as(this.closeLocked(entry), true);
			})
		);
	}

	private closeEntry(entry: OpenDocument): Effect.Effect<void> {
		return entry.lock.withPermit(this.closeLocked(entry));
	}

	private closeLocked(entry: OpenDocument): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (entry.closed) return Effect.void;
			entry.closed = true;
			// A timer clears its own field before it runs, so this never interrupts the calling fiber.
			const timers = [entry.writing, entry.missing].filter((fiber) => fiber !== undefined);
			entry.writing = undefined;
			entry.missing = undefined;
			if (this.entries.get(entry.path) === entry) {
				this.entries.delete(entry.path);
				entry.doc.free();
			}
			return Effect.andThen(Fiber.interruptAll(timers), Scope.close(entry.scope, Exit.void));
		});
	}

	/** Writes every document and closes it. Watchers see Deleted. Only the first call does anything. */
	close(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (this.closing) return;
			this.closing = true;
			for (const entry of [...this.entries.values()]) {
				yield* this.flush(entry);
				entry.deleted = true;
				this.notify(entry);
				yield* this.closeEntry(entry);
			}
			yield* this.versions.flush();
		});
	}
}

export class Documents extends Context.Service<Documents, DocumentRegistry>()('@do-it/server/Documents') {}
export function DocumentsLive(versions: Versions, log: Log) {
	return Layer.effect(
		Documents,
		Effect.acquireRelease(DocumentRegistry.make(versions, log), (registry) => registry.close())
	);
}
