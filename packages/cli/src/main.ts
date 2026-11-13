import { BunRuntime, BunServices } from '@effect/platform-bun';
import { ensureDaemon, stopDaemon, withClient, type DaemonInfo, type DoItClient } from '@do-it/client';
import {
	APP_VERSION,
	formatVersionHeader,
	makeSettler,
	onlyAgent,
	type EditOp,
	type WatchEvent
} from '@do-it/protocol';
import { Cause, Config, Effect, Exit, Option, Stdio, Stream } from 'effect';
import { CliConfig, CliOutput, Command } from 'effect/cli';
import { openBrowser } from './browser';
import { doctorText, runDoctor } from './doctor';
import {
	changeJson,
	changeReply,
	diffText,
	editReply,
	errorFields,
	errorMessage,
	errorTag,
	mismatchReply,
	rpcErrorCode,
	rpcExitCode,
	todosText,
	writeJson,
	writeLine
} from './output';
import { cliConfigFor, cliFormatter, cliPresenter, makeCli, normalizeArgv } from './parser';
import { installSkill, readSkill, skillSource } from './skill';
import { resolveText } from './stdin';
import type { GlobalOptions, ParsedCommand } from './types';

type Result = number;

function outputText(options: GlobalOptions, text: string, json: unknown): Effect.Effect<void> {
	return options.json ? writeJson(json) : writeLine(text);
}
function rpc<A, E, R>(info: DaemonInfo, f: (client: DoItClient) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
	return withClient(info, f);
}

function openCommand(command: Extract<ParsedCommand, { kind: 'open' }>) {
	return Effect.gen(function* () {
		const info = yield* ensureDaemon();
		const result = yield* rpc(info, (client) => client.open({ path: command.path, create: true }));
		if (!command.noBrowser) yield* openBrowser(result.url);
		const path = command.options.json ? result.path : command.displayPath;
		yield* outputText(command.options, `Opened ${path} at version ${result.version}: ${result.url}`, {
			path,
			version: result.version,
			url: result.url,
			created: result.created
		});
		return 0;
	});
}

function readCommand(command: Extract<ParsedCommand, { kind: 'read' }>) {
	return Effect.gen(function* () {
		const info = yield* ensureDaemon();
		const result = yield* rpc(info, (client) =>
			client.read({ path: command.path, ...(command.section === undefined ? {} : { section: command.section }) })
		);
		if (command.options.json) yield* writeJson({ version: result.version, text: result.text });
		else yield* writeLine(`Version: ${result.version}\n${result.text}`.replace(/\n$/, ''));
		return 0;
	});
}

function sectionsCommand(command: Extract<ParsedCommand, { kind: 'sections' }>) {
	return Effect.gen(function* () {
		const info = yield* ensureDaemon();
		const result = yield* rpc(info, (client) => client.sections({ path: command.path }));
		const text = [
			`Version: ${result.version}`,
			...result.sections.map((section) => `${section.id}  (${section.level}) ${section.title}`)
		].join('\n');
		yield* outputText(command.options, text, { version: result.version, sections: result.sections });
		return 0;
	});
}

function operation(
	command: Extract<ParsedCommand, { kind: 'edit' | 'append' | 'todo-add' | 'todo-set' | 'todo-start' }>,
	text?: string
): EditOp {
	if (command.kind === 'edit') return { _tag: 'Replace', old: command.old, new: command.next };
	if (command.kind === 'append') return { _tag: 'Append', text: text ?? command.text };
	if (command.kind === 'todo-add') return { _tag: 'TodoAdd', text: text ?? command.text };
	if (command.kind === 'todo-start') {
		const target = /^[+]?\d+$/.test(command.target.trim()) ? Number(command.target.trim()) : command.target;
		return { _tag: 'TodoStart', target };
	}
	const target = /^[+]?\d+$/.test(command.target.trim()) ? Number(command.target.trim()) : command.target;
	return { _tag: 'TodoSet', target, state: command.state };
}

function editCommand(
	command: Extract<ParsedCommand, { kind: 'edit' | 'append' | 'todo-add' | 'todo-set' | 'todo-start' }>
) {
	return Effect.gen(function* () {
		const info = yield* ensureDaemon();
		const text =
			command.kind === 'append' || command.kind === 'todo-add' ? yield* resolveText(command.text) : undefined;
		const result = yield* rpc(info, (client) =>
			client.edit({
				path: command.path,
				author: { _tag: 'Agent', name: command.options.as },
				version: command.version,
				...(command.section === undefined ? {} : { section: command.section }),
				op: operation(command, text)
			})
		);
		const reply = editReply(result);
		yield* outputText(command.options, reply.text, reply.json);
		return 0;
	});
}

function todoListCommand(command: Extract<ParsedCommand, { kind: 'todo-list' }>) {
	return Effect.gen(function* () {
		const info = yield* ensureDaemon();
		const result = yield* rpc(info, (client) =>
			client.todos({ path: command.path, ...(command.section === undefined ? {} : { section: command.section }) })
		);
		const lines = result.todos.map(
			(todo) => `${todo.number}. [${todo.state === 'done' ? 'x' : todo.state === 'cancelled' ? '-' : ' '}] ${todo.text}`
		);
		yield* outputText(command.options, [`Version: ${result.version}`, ...lines].join('\n'), {
			version: result.version,
			todos: result.todos
		});
		return 0;
	});
}

function diffCommand(command: Extract<ParsedCommand, { kind: 'diff' }>) {
	return Effect.gen(function* () {
		const info = yield* ensureDaemon();
		const result = yield* rpc(info, (client) =>
			client.diff({ path: command.path, since: command.since, wait: command.wait })
		);
		const text = diffText(formatVersionHeader(result.from, result.to, result.by), result.diff);
		yield* outputText(command.options, text, {
			from: result.from,
			to: result.to,
			by: result.by,
			diff: result.diff,
			todos: result.todos
		});
		return 0;
	});
}

function statusCommand(command: Extract<ParsedCommand, { kind: 'status' }>) {
	return Effect.gen(function* () {
		const info = yield* ensureDaemon({ spawn: false });
		const result = yield* rpc(info, (client) => client.status({}));
		const upSeconds = Math.floor(Math.max(0, Date.now() - result.startedAt) / 1000);
		const minutes = Math.floor(upSeconds / 60);
		if (command.options.json)
			yield* writeJson({
				pid: result.pid,
				port: result.port,
				startedAt: result.startedAt,
				appVersion: result.appVersion,
				...(result.build === undefined ? {} : { build: result.build }),
				documents: result.documents,
				notifications: result.notifications ?? [],
				upSeconds
			});
		else
			yield* writeLine(
				[
					`Daemon pid ${result.pid} on 127.0.0.1:${result.port}, up ${minutes}m`,
					...result.documents.map(
						(document) => `  ${document.path}  version ${document.version}  ${document.watchers} watchers`
					),
					...(result.notifications ?? []).map(
						(notification) =>
							`  prompting pane ${notification.target.pane} about ${notification.path}${notification.section === undefined ? '' : ` (section ${notification.section})`}`
					)
				].join('\n')
			);
		return 0;
	});
}

const herdrEnv = (name: string) =>
	Config.option(Config.String(name)).pipe(
		Effect.map((value) => Option.getOrUndefined(value)?.trim() || undefined),
		Effect.orDie
	);

function notifyCommand(command: Extract<ParsedCommand, { kind: 'notify' }>) {
	return Effect.gen(function* () {
		const pane = command.pane ?? (yield* herdrEnv('HERDR_PANE_ID'));
		if (pane === undefined) {
			const message = 'Not inside a Herdr pane: run it in Herdr, or pass --pane ID';
			yield* outputText(command.options, message, { error: { code: 'NoPane', message } });
			return 2;
		}
		if (command.path === undefined && !command.off) {
			const message = 'Name the document to notify about, or pass --off to stop every registration of the pane';
			yield* outputText(command.options, message, { error: { code: 'NoPath', message } });
			return 2;
		}
		const info = yield* ensureDaemon();
		if (command.off) {
			const result = yield* rpc(info, (client) =>
				client.unnotify({ pane, ...(command.path === undefined ? {} : { path: command.path }) })
			);
			const about = command.displayPath === undefined ? '' : ` about ${command.displayPath}`;
			yield* outputText(
				command.options,
				result.removed
					? `Stopped prompting pane ${pane}${about} (${result.removed} ${result.removed === 1 ? 'registration' : 'registrations'})`
					: `Pane ${pane} was not registered${about}`,
				{ pane, removed: result.removed }
			);
			return 0;
		}
		const bin = yield* herdrEnv('HERDR_BIN_PATH');
		const socket = yield* herdrEnv('HERDR_SOCKET_PATH');
		const result = yield* rpc(info, (client) =>
			client.notify({
				path: command.path!,
				label: command.displayPath ?? command.path!,
				target: {
					pane,
					...(bin?.startsWith('/') ? { bin } : {}),
					...(socket?.startsWith('/') ? { socket } : {})
				},
				as: command.options.as,
				todos: command.todos,
				...(command.since === undefined ? {} : { since: command.since }),
				...(command.section === undefined ? {} : { section: command.section }),
				...(command.settle === undefined
					? {}
					: { settle: command.settle, settleLine: Math.min(command.settleLine, command.settle) })
			})
		);
		const from = command.since ?? result.version;
		yield* outputText(
			command.options,
			`${result.replaced ? 'Still prompting' : 'Prompting'} pane ${pane} about ${command.displayPath} from version ${from}`,
			{ pane, version: result.version, since: from, replaced: result.replaced }
		);
		return 0;
	});
}

function stopCommand(command: Extract<ParsedCommand, { kind: 'stop' }>) {
	return Effect.gen(function* () {
		const stopped = yield* stopDaemon();
		yield* outputText(command.options, stopped ? 'Stopped' : 'Not running', { stopped });
		return 0;
	});
}

function doctorCommand(command: Extract<ParsedCommand, { kind: 'doctor' }>) {
	return Effect.gen(function* () {
		const report = yield* runDoctor(command.skillDir === undefined ? {} : { skillDir: command.skillDir });
		yield* outputText(command.options, doctorText(report), report);
		return report.ok ? 0 : 1;
	});
}

function skillInstallCommand(command: Extract<ParsedCommand, { kind: 'skill-install' }>) {
	return Effect.gen(function* () {
		const result = yield* installSkill(command.dir, command.force);
		if (result.kind === 'occupied') {
			yield* outputText(
				command.options,
				`${result.path} already exists and was not installed by do-it. Pass --force to replace it.`,
				{ error: { code: 'Refused', message: 'The skill directory already exists', path: result.path } }
			);
			return 1;
		}
		const text =
			result.kind === 'linked'
				? `${result.path} already links to this skill.`
				: `${result.replaced ? 'Updated' : 'Installed'} the do-it skill in ${result.path}. In Claude Code, run /do-it to start.`;
		yield* outputText(command.options, text, { kind: result.kind, path: result.path });
		return 0;
	});
}

function skillPathCommand(command: Extract<ParsedCommand, { kind: 'skill-path' }>) {
	return Effect.gen(function* () {
		const path = yield* skillSource;
		yield* outputText(command.options, path, { path });
		return 0;
	});
}

function skillShowCommand(command: Extract<ParsedCommand, { kind: 'skill-show' }>) {
	return Effect.gen(function* () {
		const skill = yield* readSkill;
		yield* outputText(command.options, skill.content, skill);
		return 0;
	});
}

function initialWatchOutput(command: Extract<ParsedCommand, { kind: 'watch' }>, version: number): Effect.Effect<void> {
	if (command.quiet) return Effect.void;
	return outputText(command.options, `Watching ${command.displayPath} at version ${version}`, {
		event: 'watching',
		version
	});
}
function restartOutput(command: Extract<ParsedCommand, { kind: 'watch' }>, version: number): Effect.Effect<void> {
	return outputText(command.options, `Daemon restarted, now version ${version}`, { event: 'restarted', version });
}
function resyncOutput(command: Extract<ParsedCommand, { kind: 'watch' }>, version: number): Effect.Effect<void> {
	return outputText(command.options, `Missed changes, now at version ${version}: run do-it read`, {
		event: 'resync',
		version
	});
}
function deletedOutput(command: Extract<ParsedCommand, { kind: 'watch' }>): Effect.Effect<void> {
	return outputText(command.options, `Deleted ${command.displayPath}`, { event: 'deleted' });
}

function watchCommand(command: Extract<ParsedCommand, { kind: 'watch' }>) {
	return Effect.scoped(
		Effect.gen(function* () {
			let since = command.since;
			let pid: number | undefined;
			let first = true;
			let announce = false;
			let backoff = 250;
			let deleted = false;
			let lastFailure: string | undefined;
			// The settle timer: one "settled" line per pause, sooner after the person adds a line.
			let lastText: string | undefined;
			const settler =
				command.settle === undefined
					? undefined
					: yield* makeSettler({ settle: command.settle, settleLine: command.settleLine }, (settled) =>
							outputText(
								command.options,
								`Settled at version ${settled.version}${settled.by.length ? ` by ${settled.by.join(', ')}` : ''}`,
								{ event: 'settled', version: settled.version, by: settled.by, reason: settled.reason }
							)
						);
			while (!deleted) {
				const daemon = yield* Effect.exit(ensureDaemon());
				if (Exit.isFailure(daemon)) {
					if (Cause.hasInterruptsOnly(daemon.cause)) break;
					const failure = Cause.squash(daemon.cause);
					const tag = errorTag(failure);
					if (tag !== 'DaemonUnavailable') {
						const message = errorMessage(failure);
						if (message !== lastFailure)
							yield* outputText(command.options, `Watch failed: ${message}, retrying`, { event: 'error', message });
						lastFailure = message;
					} else lastFailure = undefined;
					yield* Effect.sleep(`${backoff} millis`);
					backoff = Math.min(5000, backoff * 2);
					continue;
				}
				const info = daemon.value;
				if (pid !== undefined && pid !== info.pid) announce = true;
				pid = info.pid;
				const payload = {
					path: command.path,
					...(since === undefined ? {} : { since }),
					...(command.section === undefined ? {} : { section: command.section }),
					text: command.settle !== undefined,
					...(command.settle === undefined ? {} : { nudges: true })
				};
				const exit = yield* Effect.exit(
					rpc(info, (client) =>
						client.watch(payload).pipe(
							Stream.runForEach((event: WatchEvent) =>
								Effect.gen(function* () {
									lastFailure = undefined;
									if (event._tag === 'Watching') {
										backoff = 250;
										if (first) {
											yield* initialWatchOutput(command, event.version);
											first = false;
										} else if (announce) {
											yield* restartOutput(command, event.version);
											announce = false;
										}
										// A resumed watch's Watching can be ahead of the Change that follows it.
										if (lastText === undefined) lastText = event.text;
										since = event.version;
										return;
									}
									if (event._tag === 'Resync') {
										lastText = event.text;
										yield* resyncOutput(command, event.version);
										if (settler) yield* settler.resync(event.version);
										since = event.version;
										announce = false;
										return;
									}
									if (event._tag === 'Deleted') {
										yield* deletedOutput(command);
										deleted = true;
										return;
									}
									if (event._tag === 'Nudge') {
										if (settler) yield* settler.nudge;
										return;
									}
									since = event.to;
									const before = lastText;
									lastText = event.text;
									if (onlyAgent(event.by, command.options.as)) return;
									if (settler) {
										yield* settler.change(event.to, event.by, before, event.text);
										return;
									}
									if (command.todos) {
										if (!event.todos.length) return;
										if (command.options.json) yield* writeJson(changeJson(event));
										else yield* writeLine(todosText(event.todos));
									} else if (command.options.json) yield* writeJson(changeJson(event));
									else yield* writeLine(changeReply(event, false));
								})
							)
						)
					)
				);
				if (deleted) break;
				if (Exit.isFailure(exit)) {
					if (Cause.hasInterruptsOnly(exit.cause)) break;
					const failure = Cause.squash(exit.cause);
					const tag = errorTag(failure);
					if (tag === 'DocumentGone' || tag === 'Refused') return yield* errorResult(command, failure);
					if (tag !== 'DaemonUnavailable' && tag !== 'RpcClientError') {
						const message = errorMessage(failure);
						if (message !== lastFailure)
							yield* outputText(command.options, `Watch failed: ${message}, retrying`, { event: 'error', message });
						lastFailure = message;
					} else lastFailure = undefined;
				} else lastFailure = undefined;
				yield* Effect.sleep(`${backoff} millis`);
				backoff = Math.min(5000, backoff * 2);
			}
			// Closing the scope also interrupts a pending settle timer.
			return deleted ? 9 : 0;
		})
	);
}

function commandEffect(command: ParsedCommand) {
	switch (command.kind) {
		case 'open':
			return openCommand(command);
		case 'read':
			return readCommand(command);
		case 'sections':
			return sectionsCommand(command);
		case 'edit':
		case 'append':
		case 'todo-add':
		case 'todo-set':
		case 'todo-start':
			return editCommand(command);
		case 'todo-list':
			return todoListCommand(command);
		case 'diff':
			return diffCommand(command);
		case 'watch':
			return watchCommand(command);
		case 'notify':
			return notifyCommand(command);
		case 'status':
			return statusCommand(command);
		case 'stop':
			return stopCommand(command);
		case 'doctor':
			return doctorCommand(command);
		case 'skill-install':
			return skillInstallCommand(command);
		case 'skill-path':
			return skillPathCommand(command);
		case 'skill-show':
			return skillShowCommand(command);
	}
}

function errorResult(command: ParsedCommand, error: unknown): Effect.Effect<Result> {
	return Effect.gen(function* () {
		const requested = ('version' in command ? command.version : 'since' in command ? command.since : 0) ?? 0;
		const tag = errorTag(error);
		if (command.kind === 'status' && tag === 'DaemonUnavailable') {
			yield* outputText(command.options, 'Not running', {
				error: { code: 'DaemonUnavailable', message: 'Not running' }
			});
			return 3;
		}
		if (tag === 'VersionMismatch' || tag === 'Forgotten') {
			const reply = mismatchReply(error, requested);
			const { kind: _kind, ...fields } = reply.json;
			yield* outputText(command.options, reply.text, { error: { code: tag, message: reply.text, ...fields } });
			return 1;
		}
		const code = rpcExitCode(error);
		const message =
			tag === 'NothingYet' && command.kind === 'diff'
				? `No change since version ${command.since} in ${command.wait} ${command.wait === 1 ? 'second' : 'seconds'}`
				: errorMessage(error);
		const fields = errorFields(error);
		yield* outputText(command.options, message, { error: { code: rpcErrorCode(error), message, ...fields } });
		return code;
	});
}

function program() {
	let commandExit = 0;
	const cli = makeCli((command) =>
		Effect.gen(function* () {
			const result = yield* Effect.exit(commandEffect(command));
			commandExit = Exit.isSuccess(result) ? result.value : yield* errorResult(command, Cause.squash(result.cause));
		})
	);
	return Effect.gen(function* () {
		const args = yield* (yield* Stdio.Stdio).args;
		const input = normalizeArgv(args);
		const result = yield* Effect.exit(
			Command.runWith(cli, { version: APP_VERSION, renderErrors: true })(input).pipe(
				Effect.provide(CliConfig.layer(cliConfigFor(input))),
				Effect.provide(CliOutput.layer(cliFormatter)),
				Effect.provide(cliPresenter)
			)
		);
		if (Exit.isFailure(result)) {
			const message = errorMessage(Cause.squash(result.cause));
			if (args.includes('--json')) yield* writeJson({ error: { code: 'invalid', message } });
			else yield* writeLine(message);
			return 2;
		}
		return commandExit;
	}).pipe(Effect.provide(BunServices.layer));
}

const main: Effect.Effect<Result, never, never> = program();
BunRuntime.runMain(main, {
	disableErrorReporting: true,
	teardown: (exit, done) => done(Exit.isSuccess(exit) ? Number(exit.value) : 1)
});
