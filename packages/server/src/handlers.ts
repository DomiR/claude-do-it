import {
	addTodo,
	appendBlock,
	findSection,
	findTodo,
	replaceUnique,
	sections,
	setTodoStateStamped,
	stampTodo,
	todos,
	type Origin
} from '@do-it/doc';
import {
	DoItRpcs,
	DocumentGone,
	Forgotten,
	NothingYet,
	type Author,
	type DiffSuccess,
	type SyncPayload,
	type WatchEvent,
	type WatchPayload
} from '@do-it/protocol';
import { Cause, Deferred, Effect, Stream } from 'effect';
import { Auth } from './auth';
import { APP_VERSION } from './config';
import { Documents, DocumentRegistry, rpcTry, type OpenDocument } from './documents';
import { Notifier } from './notify';
import { author, changes, watchDocument } from './watch';

export interface RuntimeInfo {
	port: number;
	startedAt: number;
	build: string;
	stop: Effect.Effect<void>;
}
function origin(by: Author): Origin {
	return by._tag === 'Agent' ? { kind: 'agent', name: by.name } : { kind: by._tag === 'User' ? 'user' : 'file' };
}
/** Merges the text a browser edited from `base`. */
export function syncDocument(registry: DocumentRegistry, request: SyncPayload) {
	return registry.withEntry(request.path, (entry) =>
		Effect.gen(function* () {
			// A restarted daemon can give the base's number to another text. A merge
			// from that text would delete what the sender never saw, so it must resync.
			if (request.baseHash !== undefined && (yield* registry.hashAt(entry, request.base)) !== request.baseHash) {
				return yield* Effect.fail(new Forgotten({ latest: entry.doc.version }));
			}
			// Hashing can yield, and a file deleted meanwhile frees the document.
			if (entry.deleted || entry.closed) return yield* Effect.fail(new DocumentGone({ path: entry.path }));
			const previous = entry.doc.version;
			yield* rpcTry(
				() => entry.doc.userEdit(request.base, request.text),
				() => entry.doc.version
			);
			// Read the reply before yielding: a deleted file frees the document.
			const { version, text } = entry.doc;
			yield* registry.changed(entry, previous);
			return { version, text, hash: yield* registry.hashOf(entry, version, text) };
		})
	);
}

export function HandlersLive(auth: Auth, runtime: RuntimeInfo) {
	return DoItRpcs.toLayer(
		Effect.gen(function* () {
			const registry = yield* Documents;
			const notifier = yield* Notifier;
			return {
				status: () =>
					Effect.sync(() => ({
						pid: process.pid,
						appVersion: APP_VERSION,
						port: runtime.port,
						startedAt: runtime.startedAt,
						build: runtime.build,
						documents: registry.status(),
						notifications: notifier.list()
					})).pipe(Effect.withSpan('rpc.status')),
				stop: Effect.fn('rpc.stop')(function* () {
					yield* runtime.stop;
					return {};
				}),
				open: (request) =>
					registry
						.withOpened(
							request.path,
							({ entry, created }) =>
								Effect.gen(function* () {
									const version = entry.doc.version;
									const code = yield* auth.mint(entry.path);
									return {
										path: entry.path,
										version,
										created,
										url: `http://127.0.0.1:${runtime.port}/auth?code=${code}&path=${encodeURIComponent(entry.path)}`
									};
								}),
							request.create
						)
						.pipe(Effect.withSpan('rpc.open')),
				read: (request) =>
					registry
						.withEntry(request.path, (entry) =>
							Effect.gen(function* () {
								const { version, text } = entry.doc;
								const scope =
									request.section === undefined ? null : yield* rpcTry(() => findSection(text, request.section!));
								return {
									version,
									text: scope ? text.slice(scope.from, scope.to) : text,
									hash: yield* registry.hashOf(entry, version, text)
								};
							})
						)
						.pipe(Effect.withSpan('rpc.read')),
				sections: (request) =>
					registry
						.withEntry(request.path, (entry) =>
							Effect.sync(() => ({
								version: entry.doc.version,
								sections: sections(entry.doc.text).map(({ id, title, level, line }) => ({ id, title, level, line }))
							}))
						)
						.pipe(Effect.withSpan('rpc.sections')),
				todos: (request) =>
					registry
						.withEntry(request.path, (entry) =>
							rpcTry(() => {
								const all = todos(entry.doc.text);
								if (request.section === undefined) return { version: entry.doc.version, todos: all };
								const scope = findSection(entry.doc.text, request.section);
								const following =
									sections(entry.doc.text).find((section) => section.from === scope.to)?.line ?? Infinity;
								return {
									version: entry.doc.version,
									todos: all.filter((todo) => todo.line >= scope.line && todo.line < following)
								};
							})
						)
						.pipe(Effect.withSpan('rpc.todos')),
				edit: (request) =>
					registry
						.withEntry(request.path, (entry) =>
							Effect.gen(function* () {
								const previous = entry.doc.version;
								const result = yield* rpcTry(
									() =>
										entry.doc.agentEdit(
											origin(request.author),
											{ version: request.version, section: request.section },
											(text) => {
												const op = request.op;
												switch (op._tag) {
													case 'Replace':
														return replaceUnique(text, op.old, op.new, request.section);
													case 'Append':
														return appendBlock(text, op.text, request.section);
													case 'TodoAdd':
														return addTodo(text, op.text, request.section);
													case 'TodoSet':
														return setTodoStateStamped(
															text,
															findTodo(text, op.target, request.section),
															op.state,
															new Date()
														);
													case 'TodoStart':
														return stampTodo(text, findTodo(text, op.target, request.section), 'started', new Date());
												}
											}
										),
									() => entry.doc.version
								);
								yield* registry.changed(entry, previous);
								return { ...result, section: request.section ?? null };
							})
						)
						.pipe(Effect.withSpan('rpc.edit')),
				sync: (request) => syncDocument(registry, request).pipe(Effect.withSpan('rpc.sync')),
				diff: (request) =>
					registry
						.withEntry(request.path, (entry) =>
							Effect.gen(function* () {
								const deadline = Date.now() + request.wait * 1000;
								while (true) {
									const signal = entry.signal;
									if (entry.deleted) return yield* Effect.fail(new DocumentGone({ path: entry.path }));
									const result = changes(entry, request.since);
									if (!result) return yield* Effect.fail(new Forgotten({ latest: entry.doc.version }));
									if (entry.doc.version !== request.since) return result;
									const remaining = deadline - Date.now();
									if (remaining <= 0) return yield* Effect.fail(new NothingYet({}));
									yield* Deferred.await(signal).pipe(Effect.timeoutOption(remaining));
								}
							})
						)
						.pipe(Effect.withSpan('rpc.diff')),
				watch: (request) => watchDocument(registry, request),
				nudge: (request) =>
					registry
						.withEntry(request.path, (entry) =>
							Effect.sync(() => {
								registry.nudge(entry);
								return { version: entry.doc.version };
							})
						)
						.pipe(Effect.withSpan('rpc.nudge')),
				notify: (request) => notifier.register(request).pipe(Effect.withSpan('rpc.notify')),
				unnotify: (request) => notifier.unregister(request).pipe(Effect.withSpan('rpc.unnotify'))
			};
		})
	);
}
