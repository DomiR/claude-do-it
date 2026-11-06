import { Document, isNotFound } from '@do-it/doc';
import { Context, Effect, Fiber, FileSystem, Path, Scope } from 'effect';
import { Digest } from 'effect/crypto';
import { readJson, writeJson } from './files';
import type { Log } from './log';

interface VersionEntry {
	version: number;
	sha256: string;
}
const MAX_ENTRIES = 256;
const encoder = new TextEncoder();

/** The last version number and text hash of recently open documents, kept across restarts. */
export class Versions {
	private readonly entries = new Map<string, VersionEntry>();
	private timer: Fiber.Fiber<void> | undefined;
	private constructor(
		private readonly path: string,
		private readonly log: Log,
		private readonly digest: Digest.Digest['Service'],
		private readonly context: Context.Context<FileSystem.FileSystem>,
		private readonly scope: Scope.Scope
	) {}

	static readonly make = Effect.fn('Versions.make')(function* (home: string, log: Log) {
		const path = yield* Path.Path;
		const versions = new Versions(
			path.join(home, 'versions.json'),
			log,
			yield* Digest.Digest,
			yield* Effect.context<FileSystem.FileSystem>(),
			yield* Effect.scope
		);
		const value = yield* readJson(versions.path).pipe(
			Effect.catch((error) =>
				isNotFound(error)
					? Effect.succeed(undefined)
					: Effect.as(log.write('Could not read versions.json, starting with fresh version records'), undefined)
			)
		);
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			for (const [path, entry] of Object.entries(value)) {
				const item = entry as Partial<VersionEntry> | null;
				if (
					item &&
					Number.isSafeInteger(item.version) &&
					item.version! > 0 &&
					typeof item.sha256 === 'string' &&
					/^[a-f0-9]{64}$/.test(item.sha256)
				) {
					versions.entries.set(path, item as VersionEntry);
					versions.trim();
				}
			}
		}
		return versions;
	});

	sha256(text: string): Effect.Effect<string> {
		return this.digest.digestHex(Digest.sha256, encoder.encode(text));
	}
	has(path: string): boolean {
		return this.entries.has(path);
	}

	open(path: string, text: string): Effect.Effect<Document> {
		return Effect.gen({ self: this }, function* () {
			const old = this.entries.get(path);
			let doc: Document;
			if (old && old.sha256 !== (yield* this.sha256(text))) {
				// The persisted hash cannot reconstruct an old text. Make the file-origin
				// version through the public API, then forget the synthetic predecessor.
				doc = Document.open(text === '' ? '\n' : '', old.version);
				doc.mergeFile(text);
				doc.compact(0, 0, 1);
			} else doc = Document.open(text, old?.version);
			yield* this.record(path, doc.version, text);
			return doc;
		});
	}

	record(path: string, version: number, text: string): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			const sha256 = yield* this.sha256(text);
			this.entries.delete(path);
			this.entries.set(path, { version, sha256 });
			this.trim();
			if (!this.timer) {
				const save = Effect.suspend(() => {
					this.timer = undefined;
					return this.save();
				});
				this.timer = yield* Effect.forkIn(Effect.delay(save, '1 second'), this.scope);
			}
		});
	}

	/** Saves now and cancels a pending save. */
	flush(): Effect.Effect<void> {
		return Effect.suspend(() => {
			const timer = this.timer;
			this.timer = undefined;
			return Effect.andThen(timer ? Fiber.interrupt(timer) : Effect.void, this.save());
		});
	}

	private trim(): void {
		while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
	}
	private save(): Effect.Effect<void> {
		return writeJson(this.path, Object.fromEntries(this.entries)).pipe(
			Effect.provideContext(this.context),
			Effect.catch((error) => this.log.write(`Could not save versions: ${String(error)}`))
		);
	}
}
