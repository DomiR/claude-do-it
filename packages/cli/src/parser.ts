import { APP_VERSION } from '@do-it/protocol';
import { BunServices } from '@effect/platform-bun';
import { Config, Effect, Option, Path, Schema } from 'effect';
import { Argument, CliConfig, CliError, CliOutput, Command, Flag, GlobalFlag } from 'effect/cli';

import type { ParsedCommand } from './types';

export type { ParsedCommand } from './types';

export type CommandRunner = (command: ParsedCommand) => Effect.Effect<void, never, Command.Environment>;

export const cliFormatter: CliOutput.Formatter = {
	// defaultFormatter returns a plain object, so the spread keeps every member.
	// oxlint-disable-next-line typescript/no-misused-spread
	...CliOutput.defaultFormatter({ colors: false }),
	formatVersion: (name, version) => `${name} ${version}`
};

export const cliPresenter = CliOutput.layerPresenter({
	present: (event) =>
		(event._tag === 'Help' && event.reason === 'Requested') || event._tag === 'Version'
			? CliOutput.defaultPresenter.present(event)
			: Effect.void
});

const subcommands = new Set([
	'open',
	'read',
	'sections',
	'edit',
	'append',
	'todo',
	'diff',
	'watch',
	'status',
	'stop',
	'doctor'
]);
const valueFlags = new Set([
	'--old',
	'--new',
	'--section',
	'--version',
	'--since',
	'--wait',
	'--settle',
	'--settle-line',
	'--as',
	'--skill-dir'
]);

/** Effect CLI treats a following dash-prefixed token as short flags. Make the
 * values of our string/number flags explicit while preserving `--` text. */
export function normalizeArgv(input: ReadonlyArray<string>): ReadonlyArray<string> {
	// `do-it --skill` prints the skill, the same as `do-it skill show`.
	if (input[0] === '--skill') return normalizeArgv(['skill', 'show', ...input.slice(1)]);
	const result: string[] = [];
	let options = true;
	for (let index = 0; index < input.length; index += 1) {
		const value = input[index]!;
		if (options && value === '--') {
			options = false;
			result.push(value);
			continue;
		}
		if (options && valueFlags.has(value) && index + 1 < input.length && input[index + 1] !== '--') {
			result.push(`${value}=${input[index + 1]!}`);
			index += 1;
			continue;
		}
		result.push(value);
	}
	return result;
}

function hasNonGlobalArgument(input: ReadonlyArray<string>, end: number): boolean {
	let skipAsValue = false;
	for (const [index, value] of input.entries()) {
		if (index >= end) break;
		if (skipAsValue) {
			skipAsValue = false;
			continue;
		}
		if (value === '--as') {
			skipAsValue = true;
			continue;
		}
		if (value === '--json' || value.startsWith('--as=') || value === '--help' || value === '-h') continue;
		if (value.startsWith('-')) continue;
		return true;
	}
	return false;
}

export function cliConfigFor(input: ReadonlyArray<string>): ReturnType<typeof CliConfig.make> {
	const versionIndex = input.findIndex((value) => value === '--version' || value === '-v');
	const rootVersion = versionIndex >= 0 && !hasNonGlobalArgument(input, versionIndex);
	return CliConfig.make({
		builtIns:
			rootVersion || !input.some((value) => subcommands.has(value))
				? GlobalFlag.BuiltIns
				: GlobalFlag.BuiltIns.filter((builtIn) => builtIn !== GlobalFlag.Version)
	});
}

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
const Seconds = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 600 })));
const AgentName = Schema.String.pipe(
	Schema.check(Schema.isBetweenLength(1, 64), Schema.isPattern(/^[A-Za-z0-9._-]+$/))
);

const section = Flag.String('section').pipe(Flag.optional);
const version = Flag.Int('version').pipe(Flag.withSchema(PositiveInt));
const since = Flag.Int('since').pipe(Flag.withSchema(PositiveInt));
const optionalSince = Flag.Int('since').pipe(Flag.withSchema(PositiveInt), Flag.optional);
const wait = Flag.Finite('wait').pipe(Flag.withDefault(0), Flag.withSchema(Seconds));
const settle = Flag.Finite('settle').pipe(
	Flag.withSchema(Seconds),
	Flag.withDescription(
		'Print one "Settled at version N by WHO" line once nobody changed the document for this many seconds'
	),
	Flag.optional
);
const settleLine = Flag.Finite('settle-line').pipe(
	Flag.withSchema(Seconds),
	Flag.withDefault(2),
	Flag.withDescription(
		"With --settle, wait only this many seconds (default 2) when the person's latest change adds a line, as Enter does at the end of a task or inside one. Every other change (typing, editing or deleting text, toggling a box) keeps the full --settle. Set it to the --settle value to always wait the full period"
	)
);

const optionValue = <A>(value: Option.Option<A>): A | undefined => (Option.isSome(value) ? value.value : undefined);
/** `path` is relative to the working directory here. `withCommon` resolves it. */
const pathValue = (value: string | undefined, optional = false): { path: string; displayPath: string } => {
	const displayPath = optional ? (value ?? 'TODO.md') : value!;
	return { displayPath, path: displayPath };
};
const defaultAgent = Config.option(Config.String('DO_IT_AGENT')).pipe(
	Effect.map((name) => Option.getOrElse(name, () => '').trim() || 'agent'),
	Effect.orDie
);
const commonFlags = {
	json: Flag.Boolean('json').pipe(Flag.withDefault(false)),
	as: Flag.String('as').pipe(Flag.withDefault(defaultAgent), Flag.withSchema(AgentName))
};

function withCommon<
	Values,
	Name extends string,
	Input,
	ContextInput extends { readonly json: boolean; readonly as: string },
	E,
	R
>(
	root: Command.Command<Name, Input, ContextInput, E, R>,
	input: Values,
	run: CommandRunner,
	make: (values: Values, common: ContextInput) => ParsedCommand
): Effect.Effect<void, E, R | Command.CommandContext<Name> | Command.Environment> {
	return Effect.gen(function* () {
		const globals = yield* root;
		const path = yield* Path.Path;
		const command = make(input, globals);
		yield* run('path' in command ? { ...command, path: path.resolve(command.path) } : command);
	});
}

export function makeCli(run: CommandRunner) {
	const root = Command.make('do-it').pipe(
		Command.withDescription(
			'Commands: open, read, sections, edit, append, todo add, todo start, todo check, todo uncheck, todo cancel, todo uncancel, todo list, diff, watch, status, stop, doctor, skill install, skill path, skill show (or --skill)'
		),
		Command.withSharedFlags(commonFlags)
	);

	const open = Command.make(
		'open',
		{
			path: Argument.String('path').pipe(Argument.optional),
			noBrowser: Flag.Boolean('no-browser').pipe(Flag.withDefault(false))
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'open',
				options: common,
				...pathValue(optionValue(config.path), true),
				noBrowser: config.noBrowser
			}))
	);

	const read = Command.make(
		'read',
		{
			path: Argument.String('path'),
			section
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'read',
				options: common,
				...pathValue(config.path),
				section: optionValue(config.section)
			}))
	);

	const sections = Command.make(
		'sections',
		{
			path: Argument.String('path')
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'sections',
				options: common,
				...pathValue(config.path)
			}))
	);

	const edit = Command.make(
		'edit',
		{
			path: Argument.String('path'),
			version,
			section,
			old: Flag.String('old'),
			next: Flag.String('new')
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'edit',
				options: common,
				...pathValue(config.path),
				version: config.version,
				section: optionValue(config.section),
				old: config.old,
				next: config.next
			}))
	);

	const append = Command.make(
		'append',
		{
			path: Argument.String('path'),
			version,
			section,
			text: Argument.String('text')
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'append',
				options: common,
				...pathValue(config.path),
				version: config.version,
				section: optionValue(config.section),
				text: config.text
			}))
	);

	const todoAdd = Command.make(
		'add',
		{
			path: Argument.String('path'),
			version,
			section,
			text: Argument.String('text')
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'todo-add',
				options: common,
				...pathValue(config.path),
				version: config.version,
				section: optionValue(config.section),
				text: config.text
			}))
	);

	const todoSet = (name: 'check' | 'uncheck' | 'cancel' | 'uncancel', state: 'done' | 'open' | 'cancelled') =>
		Command.make(
			name,
			{
				path: Argument.String('path'),
				version,
				section,
				target: Argument.String('target')
			},
			(input) =>
				withCommon(root, input, run, (config, common) => ({
					kind: 'todo-set',
					options: common,
					...pathValue(config.path),
					version: config.version,
					section: optionValue(config.section),
					target: config.target,
					state
				}))
		);

	const todoStart = Command.make(
		'start',
		{
			path: Argument.String('path'),
			version,
			section,
			target: Argument.String('target')
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'todo-start',
				options: common,
				...pathValue(config.path),
				version: config.version,
				section: optionValue(config.section),
				target: config.target
			}))
	);

	const todoList = Command.make(
		'list',
		{
			path: Argument.String('path'),
			section
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'todo-list',
				options: common,
				...pathValue(config.path),
				section: optionValue(config.section)
			}))
	);

	const todo = Command.make('todo').pipe(
		Command.withSubcommands([
			todoAdd,
			todoStart,
			todoSet('check', 'done'),
			todoSet('uncheck', 'open'),
			todoSet('cancel', 'cancelled'),
			todoSet('uncancel', 'open'),
			todoList
		])
	);

	const diff = Command.make(
		'diff',
		{
			path: Argument.String('path'),
			since,
			wait
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'diff',
				options: common,
				...pathValue(config.path),
				since: config.since,
				wait: config.wait
			}))
	);

	const watch = Command.make(
		'watch',
		{
			path: Argument.String('path'),
			optionalSince,
			section,
			todos: Flag.Boolean('todos').pipe(Flag.withDefault(false)),
			settle,
			settleLine,
			quiet: Flag.Boolean('quiet').pipe(Flag.withDefault(false))
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'watch',
				options: common,
				...pathValue(config.path),
				since: optionValue(config.optionalSince),
				section: optionValue(config.section),
				todos: config.todos,
				settle: optionValue(config.settle),
				settleLine: config.settleLine,
				quiet: config.quiet
			}))
	).pipe(Command.withDescription('Print every change to PATH as it lands, or with --settle one line per pause'));

	const status = Command.make('status', {}, (input) =>
		withCommon(root, input, run, (_config, common) => ({ kind: 'status', options: common }))
	);
	const stop = Command.make('stop', {}, (input) =>
		withCommon(root, input, run, (_config, common) => ({ kind: 'stop', options: common }))
	);

	const doctor = Command.make('doctor', { skillDir: Flag.String('skill-dir').pipe(Flag.optional) }, (input) =>
		withCommon(root, input, run, (config, common) => ({
			kind: 'doctor',
			options: common,
			skillDir: optionValue(config.skillDir)
		}))
	).pipe(
		Command.withDescription(
			"Check Bun, the do-it on PATH, the daemon's version and build, and the installed skill, and print the fix for each problem"
		)
	);

	const skillInstall = Command.make(
		'install',
		{
			dir: Flag.String('dir').pipe(Flag.optional),
			force: Flag.Boolean('force').pipe(Flag.withDefault(false))
		},
		(input) =>
			withCommon(root, input, run, (config, common) => ({
				kind: 'skill-install',
				options: common,
				dir: optionValue(config.dir),
				force: config.force
			}))
	);
	const skillPath = Command.make('path', {}, (input) =>
		withCommon(root, input, run, (_config, common) => ({ kind: 'skill-path', options: common }))
	);
	const skillShow = Command.make('show', {}, (input) =>
		withCommon(root, input, run, (_config, common) => ({ kind: 'skill-show', options: common }))
	);
	const skill = Command.make('skill').pipe(
		Command.withDescription('Install the /do-it skill for Claude Code, print it, or print where this CLI keeps it'),
		Command.withSubcommands([skillInstall, skillPath, skillShow])
	);

	return root.pipe(
		Command.withSubcommands([open, read, sections, edit, append, todo, diff, watch, status, stop, doctor, skill])
	);
}

export function parseArgs(
	input: ReadonlyArray<string>
): Effect.Effect<ParsedCommand, CliError.CliError, BunServices.BunServices> {
	let parsed: ParsedCommand | undefined;
	const command = makeCli((value) =>
		Effect.sync(() => {
			parsed = value;
		})
	);
	const normalized = normalizeArgv(input);
	return Effect.gen(function* () {
		yield* Command.runWith(command, { version: APP_VERSION, renderErrors: false })(normalized).pipe(
			Effect.provide(CliConfig.layer(cliConfigFor(normalized))),
			Effect.provide(CliOutput.layer(cliFormatter))
		);
		if (!parsed) return yield* Effect.fail(new CliError.UserError({ cause: 'No command was selected' }));
		return parsed;
	});
}
