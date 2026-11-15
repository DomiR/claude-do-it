import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { Effect } from 'effect';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDaemon, withClient } from '@do-it/client';
import { runClient } from '../packages/client/test/environment';
import { jsonLine, makeFixture, readLines, runCli, startCli, wait, writeDocument } from './helpers';

setDefaultTimeout(30_000);

interface Call {
	args: ReadonlyArray<string>;
	socket: string | undefined;
}

/** A herdr stand-in that records each call. `mode` holds ok, blocked, or gone. */
function fakeHerdr(root: string) {
	const script = join(root, 'herdr.js');
	writeFileSync(
		script,
		`const { appendFileSync, readFileSync } = require('node:fs');
const dir = ${JSON.stringify(root)};
let mode = 'ok';
try { mode = readFileSync(dir + '/mode', 'utf8').trim(); } catch {}
appendFileSync(dir + '/calls', JSON.stringify({ args: process.argv.slice(2), socket: process.env.HERDR_SOCKET_PATH }) + '\\n');
if (mode === 'gone') { console.log(JSON.stringify({ error: { code: 'pane_not_found', message: 'pane not found' } })); process.exit(1); }
if (mode === 'blocked' && process.argv[2] === 'agent') { console.log(JSON.stringify({ error: { code: 'agent_blocked', message: 'blocked' } })); process.exit(1); }
`
	);
	const bin = join(root, 'herdr');
	writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
	chmodSync(bin, 0o755);
	const callsPath = join(root, 'calls');
	const calls = (): Call[] =>
		existsSync(callsPath)
			? readFileSync(callsPath, 'utf8')
					.split('\n')
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Call)
			: [];
	const prompts = () => calls().filter((call) => call.args[0] === 'agent' && call.args[1] === 'prompt');
	return {
		env: { HERDR_BIN_PATH: bin, HERDR_PANE_ID: 'test:p1', HERDR_SOCKET_PATH: join(root, 'herdr.sock') },
		mode: (mode: 'ok' | 'blocked' | 'gone') => writeFileSync(join(root, 'mode'), mode),
		calls,
		prompts,
		/** Waits until the pane has been prompted `count` times. */
		promptCount: async (count: number, timeout = 8000) => {
			for (let waited = 0; waited < timeout && prompts().length < count; waited += 50) await wait(50);
			return prompts();
		}
	};
}

async function setup(text = '# TODO\n\n- [ ] first\n') {
	const fixture = makeFixture();
	const herdr = fakeHerdr(fixture.root);
	const env = { ...fixture.env, ...herdr.env };
	writeDocument(fixture.file, text);
	expect((await runCli(['open', fixture.file, '--no-browser'], env)).code).toBe(0);
	const version = async () =>
		jsonLine<{ version: number }>(await runCli(['read', fixture.file, '--json'], env)).version;
	const add = async (as: string, text: string) => {
		const result = await runCli(
			['todo', 'add', fixture.file, '--version', String(await version()), '--as', as, text],
			env
		);
		expect(result.code).toBe(0);
	};
	const status = async () =>
		jsonLine<{ notifications: ReadonlyArray<{ path: string; target: { pane: string } }> }>(
			await runCli(['status', '--json'], env)
		).notifications;
	return { fixture, herdr, env, add, version, status };
}

describe('do-it notify', () => {
	it('needs a pane', async () => {
		const fixture = makeFixture();
		const result = await runCli(['notify', fixture.file], { ...fixture.env, HERDR_PANE_ID: '' });
		expect(result.code).toBe(2);
		expect(result.stdout).toContain('Not inside a Herdr pane');
	});

	it('prompts the pane once a burst settles, skips its own changes, survives a restart, and ends with the pane', async () => {
		const { fixture, herdr, env, add, status } = await setup();
		const registered = await runCli(
			['notify', fixture.file, '--settle', '2', '--settle-line', '2', '--as', 'conductor'],
			env
		);
		expect(registered.code).toBe(0);
		expect(registered.stdout).toContain(`Prompting pane test:p1 about ${fixture.file} from version 1`);

		await add('t1', 'one');
		await add('t1', 'two');
		const [first] = await herdr.promptCount(1);
		expect(first!.args).toEqual(['agent', 'prompt', 'test:p1', `[do-it] ${fixture.file}: Settled at version 3 by t1`]);
		expect(first!.socket).toBe(herdr.env.HERDR_SOCKET_PATH);

		await add('conductor', 'mine');
		await wait(3000);
		expect(herdr.prompts()).toHaveLength(1);
		expect(await status()).toMatchObject([{ path: fixture.file, target: { pane: 'test:p1' } }]);

		// A new daemon picks the registration up from notify.json, with nothing reported as missed.
		await runCli(['stop'], env);
		await add('t2', 'after restart');
		const prompts = await herdr.promptCount(2);
		expect(prompts[1]!.args[3]).toBe(`[do-it] ${fixture.file}: Settled at version 5 by t2`);
		expect(prompts).toHaveLength(2);

		herdr.mode('gone');
		await add('t3', 'nobody listens');
		for (let waited = 0; waited < 8000 && (await status()).length > 0; waited += 100) await wait(100);
		expect(await status()).toEqual([]);
		await runCli(['stop'], env);
	});

	it('keeps events while the agent is blocked and sends them in one prompt', async () => {
		const { fixture, herdr, env, add } = await setup();
		herdr.mode('blocked');
		expect((await runCli(['notify', fixture.file, '--todos', '--as', 'conductor'], env)).code).toBe(0);
		await add('t1', 'one');
		for (let waited = 0; waited < 5000 && herdr.prompts().length === 0; waited += 50) await wait(50);
		await add('t1', 'two');
		herdr.mode('ok');
		const prompts = await herdr.promptCount(2, 12_000);
		expect(prompts.at(-1)!.args[3]).toBe(
			`[do-it] ${fixture.file}: added 2. one\n[do-it] ${fixture.file}: added 3. two`
		);
		await runCli(['stop'], env);
	});

	it('keeps unsent events across a restart, and reports nothing missed for changes without a prompt', async () => {
		const { fixture, herdr, env, add, version } = await setup();
		expect((await runCli(['notify', fixture.file, '--todos', '--as', 'conductor'], env)).code).toBe(0);
		// Not a todo change: no prompt, and a restart must not call it missed.
		const appended = await runCli(
			['append', fixture.file, '--version', String(await version()), '--as', 't1', 'a plain note'],
			env
		);
		expect(appended.code).toBe(0);
		await wait(500);
		await runCli(['stop'], env);
		await add('t1', 'one');
		const [first] = await herdr.promptCount(1);
		expect(first!.args[3]).toBe(`[do-it] ${fixture.file}: added 2. one`);

		// The pane cannot take it, and the daemon stops before it could.
		herdr.mode('blocked');
		await add('t1', 'two');
		for (let waited = 0; waited < 5000 && herdr.prompts().length < 2; waited += 50) await wait(50);
		await runCli(['stop'], env);
		herdr.mode('ok');
		await version();
		const prompts = await herdr.promptCount(3);
		expect(prompts.at(-1)!.args[3]).toContain('Missed changes, now at version');
		await runCli(['stop'], env);
	});

	it('prompts a section with only the lines it added', async () => {
		const { fixture, herdr, env, version } = await setup('# Inbox\n\n## Messages\n\n- t1 progress: one\n');
		expect((await runCli(['notify', fixture.file, '--section', 'messages', '--as', 'conductor'], env)).code).toBe(0);
		const appended = await runCli(
			[
				'append',
				fixture.file,
				'--version',
				String(await version()),
				'--section',
				'messages',
				'--as',
				't2',
				'--',
				'- t2 done: two'
			],
			env
		);
		expect(appended.code).toBe(0);
		const [prompt] = await herdr.promptCount(1);
		expect(prompt!.args[3]).toBe(`[do-it] ${fixture.file}: Version 2 by t2:\n- t2 done: two`);
		await runCli(['stop'], env);
	});

	it('fires a pending settle when the person asks (Cmd-S), and stops with --off', async () => {
		const { fixture, herdr, env, add, status } = await setup();
		expect((await runCli(['notify', fixture.file, '--settle', '30', '--as', 'conductor'], env)).code).toBe(0);
		const watcher = await startCli(['watch', fixture.file, '--settle', '30', '--json', '--as', 'watcher'], env);
		const lines = await readLines(watcher);
		expect(JSON.parse((await lines.next()).value as string).event).toBe('watching');
		await add('t1', 'one');
		await wait(300);
		expect(herdr.prompts()).toHaveLength(0);
		const info = await runClient(ensureDaemon({ home: fixture.home }));
		await Effect.runPromise(withClient(info, (client) => client.nudge({ path: fixture.file })));
		const [prompt] = await herdr.promptCount(1, 3000);
		expect(prompt!.args[3]).toBe(`[do-it] ${fixture.file}: Settled at version 2 by t1`);
		expect(JSON.parse((await lines.next()).value as string)).toMatchObject({
			event: 'settled',
			version: 2,
			reason: 'nudge'
		});
		watcher.kill();

		const off = await runCli(['notify', '--off'], env);
		expect(off.stdout).toContain('Stopped prompting pane test:p1 (1 registration)');
		expect(await status()).toEqual([]);
		await runCli(['stop'], env);
	});
});
