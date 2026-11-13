import { findSection, type Origin } from '@do-it/doc';
import type { Author, DiffSuccess, WatchEvent, WatchPayload } from '@do-it/protocol';
import { Cause, Deferred, Effect, Stream } from 'effect';
import { rpcTry, type DocumentRegistry, type OpenDocument } from './documents';

export function author(origin: Origin): Author {
	return origin.kind === 'agent'
		? { _tag: 'Agent', name: origin.name }
		: origin.kind === 'user'
			? { _tag: 'User' }
			: { _tag: 'File' };
}
export function changes(entry: OpenDocument, since: number, section?: string): DiffSuccess | null {
	const result = entry.doc.changes(since, section);
	return result ? { ...result, by: result.by.map(author) } : null;
}

/** One pull reads the newest document version. There is no subscriber queue. */
export function watchDocument(registry: DocumentRegistry, request: WatchPayload) {
	return Stream.fromPull(
		Effect.gen(function* () {
			// The subscription keeps the entry open once the stream exists.
			const { entry, release } = yield* registry.withEntry(request.path, (entry) =>
				Effect.gen(function* () {
					if (request.section !== undefined) yield* rpcTry(() => findSection(entry.doc.text, request.section!));
					return { entry, release: yield* rpcTry(() => registry.subscribe(entry)) };
				})
			);
			yield* Effect.addFinalizer(() => Effect.sync(release));
			let first = true;
			let ended = false;
			let since = request.since ?? entry.doc.version;
			let nudges = entry.nudges;
			const pull: Effect.Effect<readonly [WatchEvent], Cause.Done> = Effect.gen(function* () {
				if (ended) return yield* Cause.done();
				while (true) {
					const signal = entry.signal;
					if (first) {
						first = false;
						let resync =
							request.since !== undefined &&
							(since > entry.doc.version || (since < entry.doc.version && entry.doc.textAt(since) === null));
						// A restarted daemon can give the watcher's version number to another text.
						if (!resync && request.since !== undefined && request.sinceHash !== undefined) {
							resync = (yield* registry.hashAt(entry, since)) !== request.sinceHash;
						}
						if (request.since === undefined || resync) since = entry.doc.version;
						const { version, text } = entry.doc;
						return [
							{
								_tag: resync ? 'Resync' : 'Watching',
								version,
								hash: yield* registry.hashOf(entry, version, text),
								...(request.text ? { text } : {})
							} satisfies WatchEvent
						] as const;
					}
					if (entry.deleted) {
						ended = true;
						return [{ _tag: 'Deleted' } satisfies WatchEvent] as const;
					}
					if (entry.doc.version > since) {
						const result = changes(entry, since, request.section);
						since = entry.doc.version;
						const text = entry.doc.text;
						const hash = yield* registry.hashOf(entry, since, text);
						const event: WatchEvent = result
							? { _tag: 'Change', ...result, hash, ...(request.text ? { text } : {}) }
							: { _tag: 'Resync', version: since, hash, ...(request.text ? { text } : {}) };
						return [event] as const;
					}
					if (entry.nudges !== nudges) {
						nudges = entry.nudges;
						if (request.nudges) return [{ _tag: 'Nudge', version: entry.doc.version } satisfies WatchEvent] as const;
					}
					yield* Deferred.await(signal);
				}
			});
			return pull;
		})
	);
}
