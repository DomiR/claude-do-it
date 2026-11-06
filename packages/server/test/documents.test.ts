import { expect, test } from 'bun:test';
import { COMPACT_KEEP, appendBlock, replaceUnique } from '@do-it/doc';
import { Deferred, Effect, Scope, Stream } from 'effect';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../src/auth';
import { DocumentRegistry } from '../src/documents';
import { watchDocument } from '../src/handlers';
import { Log } from '../src/log';
import { ServerServices } from '../src/services';
import { Versions } from '../src/versions';
import { isolateDaemonEnvironment } from '../../client/test/environment';

isolateDaemonEnvironment();
type Services = typeof ServerServices extends import('effect').Layer.Layer<infer A, any, any> ? A : never;
function run<A, E>(effect: Effect.Effect<A, E, Scope.Scope | Services>): Promise<A> {
	return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(ServerServices)));
}
/** A registry in a fresh home, closed and removed when the test's scope closes. */
const fixture = Effect.gen(function* () {
	const home = mkdtempSync(join(tmpdir(), 'do-it-documents-'));
	yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(home, { recursive: true, force: true })));
	const log = yield* Log.make(home);
	const versions = yield* Versions.make(home, log);
	const registry = yield* DocumentRegistry.make(versions, log);
	yield* Effect.addFinalizer(() => registry.close());
	let counter = 0;
	return {
		home,
		log,
		versions,
		registry,
		file: (text = '# Tasks\n- [ ] ship\n') => {
			const path = join(home, `${counter++}.md`);
			writeFileSync(path, text);
			return path;
		}
	};
});

test('a slow watch pull coalesces a burst into one Change from A to N', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			const path = file();
			const entry = yield* registry.get(path);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const pull = yield* Stream.toPull(watchDocument(registry, { path, text: true }));
					expect(yield* pull).toEqual([{ _tag: 'Watching', version: 1, text: entry.doc.text }]);
					expect(entry.watchers).toBe(1);
					for (let i = 0; i < 20; i++) {
						const previous = entry.doc.version;
						entry.doc.agentEdit({ kind: 'agent', name: 'burst' }, { version: previous }, (text) =>
							appendBlock(text, `note ${i}`)
						);
						yield* registry.changed(entry, previous);
					}
					const result = yield* pull;
					expect(result).toHaveLength(1);
					expect(result[0]).toMatchObject({
						_tag: 'Change',
						from: 1,
						to: 21,
						by: [{ _tag: 'Agent', name: 'burst' }],
						text: entry.doc.text
					});
					if (result[0]._tag === 'Change') expect(result[0].diff).toContain('+note 19');
					// A new pull subscribes to the fresh signal; it cannot lose this next edit.
					yield* Effect.forkChild(
						Effect.gen(function* () {
							yield* Effect.sleep(5);
							const previous = entry.doc.version;
							entry.doc.userEdit(previous, `${entry.doc.text}next\n`);
							yield* registry.changed(entry, previous);
						})
					);
					expect((yield* pull)[0]).toMatchObject({ _tag: 'Change', from: 21, to: 22, by: [{ _tag: 'User' }] });
				})
			);
			expect(entry.watchers).toBe(0);
			expect(registry.totalWatchers).toBe(0);
		})
	));

test('watch resyncs forgotten history as its first event and includes full text for a section', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			const path = file('## A\na\n## B\nb\n');
			const entry = yield* registry.get(path);
			for (let i = 0; i < COMPACT_KEEP + 1; i++) {
				const previous = entry.doc.version;
				entry.doc.userEdit(previous, `${entry.doc.text}note ${i}\n`);
				yield* registry.changed(entry, previous);
			}
			yield* registry.flush(entry);
			entry.doc.compact(0, 0);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const pull = yield* Stream.toPull(watchDocument(registry, { path, since: 1, section: 'a', text: true }));
					expect(yield* pull).toEqual([{ _tag: 'Resync', version: entry.doc.version, text: entry.doc.text }]);
				})
			);
		})
	));

test('watch starts with Watching for kept history and then delivers the change', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			const path = file();
			const entry = yield* registry.get(path);
			entry.doc.userEdit(1, `${entry.doc.text}before\n`);
			yield* registry.changed(entry, 1);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const pull = yield* Stream.toPull(watchDocument(registry, { path, since: 1, text: false }));
					expect(yield* pull).toEqual([{ _tag: 'Watching', version: 2 }]);
					expect(yield* pull).toMatchObject([{ _tag: 'Change', from: 1, to: 2 }]);
				})
			);
		})
	));

for (const text of [false, true]) {
	test(`watch resyncs a future version and delivers the next change (text: ${text})`, () =>
		run(
			Effect.gen(function* () {
				const { registry, file } = yield* fixture;
				const path = file();
				const entry = yield* registry.get(path);
				const version = entry.doc.version;
				yield* Effect.scoped(
					Effect.gen(function* () {
						const pull = yield* Stream.toPull(watchDocument(registry, { path, since: version + 5, text }));
						expect(yield* pull).toEqual([{ _tag: 'Resync', version, ...(text ? { text: entry.doc.text } : {}) }]);
						entry.doc.userEdit(version, `${entry.doc.text}next\n`);
						yield* registry.changed(entry, version);
						const event = (yield* pull)[0];
						expect(event).toMatchObject({ _tag: 'Change', from: version, to: version + 1, by: [{ _tag: 'User' }] });
						if (text) expect(event).toHaveProperty('text', entry.doc.text);
						else expect(event).not.toHaveProperty('text');
					})
				).pipe(Effect.timeout(1000));
				expect(entry.watchers).toBe(0);
			})
		));
}

test('all three writers survive when disk changes during the write debounce', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			const base = '# Todo\n- [ ] alpha\n- [ ] beta\n';
			const path = file(base);
			const entry = yield* registry.get(path);
			entry.doc.userEdit(1, base.replace('alpha', 'alpha USER'));
			yield* registry.changed(entry, 1);
			entry.doc.agentEdit({ kind: 'agent', name: 'agent' }, { version: 2 }, (text) =>
				replaceUnique(text, 'beta', 'beta AGENT')
			);
			yield* registry.changed(entry, 2);
			writeFileSync(path, '# Todo\n- [ ] alpha\n- [x] beta\n- [ ] gamma\n');
			yield* registry.flush(entry);
			expect(entry.doc.text).toBe('# Todo\n- [ ] alpha USER\n- [x] beta AGENT\n- [ ] gamma\n');
			expect(readFileSync(path, 'utf8')).toBe(entry.doc.text);
			expect(entry.doc.version).toBe(4);
			expect(entry.doc.origin(4)).toEqual({ kind: 'file' });
			yield* registry.poll(entry);
			expect(entry.doc.version).toBe(4);
		})
	));

test('transient disappearance is tolerated and a missing file is never recreated by a pending write', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			const path = file('old\n');
			const entry = yield* registry.get(path);
			entry.doc.userEdit(1, 'new\n');
			yield* registry.changed(entry, 1);
			unlinkSync(path);
			yield* registry.flush(entry);
			expect(existsSync(path)).toBe(false);
			writeFileSync(path, 'old\n');
			yield* registry.poll(entry);
			yield* Effect.sleep(550);
			expect(entry.deleted).toBe(false);
			expect(readFileSync(path, 'utf8')).toBe('new\n');
		})
	));

test('a lasting disappearance deletes the document and wakes its watchers', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			const path = file();
			const entry = yield* registry.get(path);
			const signal = entry.signal;
			unlinkSync(path);
			yield* registry.poll(entry);
			yield* Effect.sleep(600);
			expect(entry.deleted).toBe(true);
			expect(entry.closed).toBe(true);
			expect(registry.status()).toHaveLength(0);
			expect(yield* Effect.flip(registry.get(path))).toMatchObject({ _tag: 'DocumentGone' });
			expect(yield* Deferred.isDone(signal)).toBe(true);
		})
	));

test('concurrent first opens of one path share a single entry', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			const path = file();
			const entries = yield* Effect.all(
				Array.from({ length: 8 }, () => registry.get(path)),
				{ concurrency: 'unbounded' }
			);
			expect(new Set(entries).size).toBe(1);
			expect(registry.status()).toHaveLength(1);
		})
	));

test('64 open documents evict the oldest idle document, but never one with subscribers', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			const first = yield* registry.get(file());
			first.lastUsed = 0;
			for (let i = 1; i < 64; i++) yield* registry.get(file());
			yield* registry.get(file());
			expect(registry.status()).toHaveLength(64);
			expect(registry.status().some((entry) => entry.path === first.path)).toBe(false);
			const releases: Array<() => void> = [];
			for (const entry of registry.status()) releases.push(registry.subscribe(yield* registry.get(entry.path)));
			expect(yield* Effect.flip(registry.get(file()))).toMatchObject({ _tag: 'Refused', code: 'too-large' });
			for (const release of releases) release();
		})
	));

test('a document in use is never evicted, and an evicted one is opened again', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			const firstPath = file();
			const first = yield* registry.get(firstPath);
			first.lastUsed = 0;
			for (let i = 1; i < 64; i++) yield* registry.get(file());
			yield* registry.withEntry(firstPath, (entry) =>
				Effect.gen(function* () {
					expect(entry.waiters).toBe(1);
					yield* registry.get(file());
					expect(entry.closed).toBe(false);
				})
			);
			expect(first.waiters).toBe(0);
			expect(registry.status()).toHaveLength(64);
			expect(registry.status().some((entry) => entry.path === firstPath)).toBe(true);
			first.lastUsed = 0;
			yield* registry.get(file());
			expect(first.closed).toBe(true);
			const reopened = yield* registry.get(firstPath);
			expect(reopened).not.toBe(first);
			expect(reopened.closed).toBe(false);
		})
	));

test('a closing registry refuses new opens', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			yield* registry.close();
			expect(yield* Effect.flip(registry.get(file()))).toMatchObject({
				_tag: 'Refused',
				message: 'The daemon is shutting down'
			});
		})
	));

test('subscriber counts are capped per document and globally, and release restores capacity', () =>
	run(
		Effect.gen(function* () {
			const { registry, file } = yield* fixture;
			const entries = yield* Effect.forEach(Array.from({ length: 9 }), () => registry.get(file()));
			const releases: Array<() => void> = [];
			for (const entry of entries.slice(0, 8)) {
				for (let i = 0; i < 32; i++) releases.push(registry.subscribe(entry));
				expect(() => registry.subscribe(entry)).toThrow(
					expect.objectContaining({ _tag: 'Refused', code: 'too-large' })
				);
			}
			expect(registry.totalWatchers).toBe(256);
			expect(() => registry.subscribe(entries[8]!)).toThrow(
				expect.objectContaining({ _tag: 'Refused', code: 'too-large' })
			);
			releases.pop()!();
			const release = registry.subscribe(entries[8]!);
			release();
			for (const release of releases) release();
			expect(registry.totalWatchers).toBe(0);
		})
	));

test('versions persist at most 256 LRU entries and offline changes are authored by file', () =>
	run(
		Effect.gen(function* () {
			const { home, log, versions } = yield* fixture;
			for (let i = 0; i < 256; i++) yield* versions.record(`/notes/${i}.md`, i + 1, `text ${i}`);
			yield* versions.record('/notes/0.md', 1, 'text 0');
			yield* versions.record('/notes/new.md', 17, 'before');
			yield* versions.flush();
			const json = JSON.parse(readFileSync(join(home, 'versions.json'), 'utf8'));
			expect(Object.keys(json)).toHaveLength(256);
			expect(json['/notes/0.md']).toBeDefined();
			expect(json['/notes/1.md']).toBeUndefined();
			const restored = yield* Versions.make(home, log);
			const same = yield* restored.open('/notes/0.md', 'text 0');
			const changed = yield* restored.open('/notes/new.md', 'after');
			try {
				expect(same.version).toBe(1);
				expect(changed.version).toBe(18);
				expect(changed.origin(18)).toEqual({ kind: 'file' });
				expect(changed.textAt(17)).toBeNull();
			} finally {
				same.free();
				changed.free();
			}
			yield* restored.flush();
		})
	));

test('version hashes are SHA-256 of the text', () =>
	run(
		Effect.gen(function* () {
			const { versions } = yield* fixture;
			expect(yield* versions.sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		})
	));

test('auth caps codes, expires them after five minutes, and keeps cookies across restarts', () =>
	run(
		Effect.gen(function* () {
			const { home } = yield* fixture;
			const auth = yield* Auth.make(home);
			const codes: string[] = [];
			for (let i = 0; i < 64; i++) codes.push(yield* auth.mint('/notes.md', 1000));
			expect(yield* Effect.flip(auth.mint('/notes.md', 1000))).toMatchObject({ code: 'too-large' });
			expect(auth.consume(codes[0]!, '/different.md', 2000)).toBe(false);
			expect(auth.consume(codes[0]!, '/notes.md', 2000)).toBe(true);
			expect(auth.consume(codes[0]!, '/notes.md', 2000)).toBe(false);
			expect(auth.consume(codes[1]!, '/notes.md', 301000)).toBe(false);
			expect(yield* auth.mint('/notes.md', 301000)).toHaveLength(64);
			const restarted = yield* Auth.make(home);
			expect(restarted.token).toBe(auth.token);
			expect(restarted.cookie).toBe(auth.cookie);
			expect(restarted.authorized(undefined, auth.cookie)).toBe(true);
			expect(restarted.authorized(undefined, auth.token)).toBe(false);
			expect(restarted.authorized(`Bearer ${auth.token}`, undefined)).toBe(true);
			expect(restarted.cookie).toBe(new Bun.CryptoHasher('sha256', auth.token).update('web cookie').digest('hex'));
		})
	));

test('log rotation keeps one old file', () =>
	run(
		Effect.gen(function* () {
			const { home, log } = yield* fixture;
			const path = join(home, 'daemon.log');
			writeFileSync(path, 'a'.repeat(1024 * 1024));
			yield* log.write('first');
			expect(readFileSync(`${path}.old`, 'utf8').length).toBe(1024 * 1024);
			expect(readFileSync(path, 'utf8')).toContain('first');
			writeFileSync(path, 'b'.repeat(1024 * 1024));
			yield* log.write('second');
			expect(readFileSync(`${path}.old`, 'utf8')[0]).toBe('b');
			expect(readFileSync(path, 'utf8')).toContain('second');
			const inherited = openSync(path, 'a');
			try {
				writeFileSync(path, 'c'.repeat(1024 * 1024));
				yield* log.rotate();
				writeFileSync(inherited, 'inherited stderr\n');
				expect(readFileSync(path, 'utf8')).toBe('inherited stderr\n');
				expect(readFileSync(`${path}.old`, 'utf8').length).toBe(1024 * 1024);
			} finally {
				closeSync(inherited);
			}
		})
	));
