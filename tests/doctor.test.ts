import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { APP_VERSION } from '@do-it/protocol';
import { appendFileSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonLine, makeFixture, runCli } from './helpers';

setDefaultTimeout(30_000);

const repo = realpathSync(join(import.meta.dir, '..'));
const bin = join(repo, 'packages', 'cli', 'src', 'bin.ts');
const fixtures: string[] = [];
const stops: Array<Record<string, string>> = [];
afterAll(async () => {
	for (const env of stops) await runCli(['stop'], env);
	for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

interface Report {
	ok: boolean;
	checks: Array<{ name: string; status: string; message: string; fix: string[] }>;
}

/** A fixture whose PATH, HOME, and Claude config are all inside its own directory. */
function doctorFixture(withDoIt = true) {
	const fixture = makeFixture();
	fixtures.push(fixture.root);
	const dir = join(fixture.root, 'bin');
	mkdirSync(dir);
	symlinkSync(process.execPath, join(dir, 'bun'));
	if (withDoIt) symlinkSync(bin, join(dir, 'do-it'));
	const user = join(fixture.root, 'user');
	const claude = join(fixture.root, 'claude');
	const env = {
		...fixture.env,
		PATH: dir,
		HOME: user,
		CLAUDE_CONFIG_DIR: claude,
		BUN_INSTALL: join(fixture.root, 'bun')
	};
	return { ...fixture, env, user, skill: join(claude, 'skills', 'do-it') };
}

async function doctor(env: Record<string, string>, args: string[] = []) {
	const result = await runCli(['doctor', '--json', ...args], env);
	const report = jsonLine<Report>(result);
	return { code: result.code, report, check: (name: string) => report.checks.find((item) => item.name === name)! };
}

describe('do-it doctor', () => {
	it('reports a missing skill without starting a daemon, then passes once it is installed', async () => {
		const fixture = doctorFixture();
		const first = await doctor(fixture.env);
		expect(first.code).toBe(1);
		expect(first.check('bun').status).toBe('ok');
		expect(first.check('path').status).toBe('ok');
		expect(first.check('daemon').status).toBe('ok');
		expect(first.check('skill')).toMatchObject({ status: 'problem', fix: ['do-it skill install'] });
		const text = await runCli(['doctor'], fixture.env);
		expect(text.code).toBe(1);
		expect(text.stdout).toContain('\n        fix: do-it skill install\n');
		expect(text.stdout).toContain('1 problem found.');
		expect(text.stdout).not.toMatch(/[\u2013\u2014]| - /);
		expect(existsSync(join(fixture.home, 'daemon.json'))).toBe(false);

		expect((await runCli(['skill', 'install'], fixture.env)).code).toBe(0);
		const passed = await runCli(['doctor'], fixture.env);
		expect(passed.code).toBe(0);
		expect(passed.stdout).toEndWith('All checks passed.\n');
	});

	it('prints the fix for each kind of skill drift', async () => {
		const fixture = doctorFixture();
		expect((await runCli(['skill', 'install'], fixture.env)).code).toBe(0);
		appendFileSync(join(fixture.skill, 'SKILL.md'), 'edited\n');
		const edited = await doctor(fixture.env);
		expect(edited.code).toBe(1);
		expect(edited.check('skill').fix).toEqual(['do-it skill install']);
		rmSync(join(fixture.skill, '.do-it-version'));
		expect((await doctor(fixture.env)).check('skill').fix).toEqual(['do-it skill install --force']);
		rmSync(fixture.skill, { recursive: true });
		symlinkSync(join(repo, 'skill'), fixture.skill);
		expect((await doctor(fixture.env)).code).toBe(0);
		const other = join(fixture.root, 'other');
		expect((await doctor(fixture.env, ['--skill-dir', other])).check('skill').fix).toEqual([
			`do-it skill install --dir ${other}`
		]);
	});

	it('fixes PATH when do-it is not on it, and runs this CLI directly in the other fixes', async () => {
		const fixture = doctorFixture(false);
		const result = await doctor(fixture.env);
		expect(result.code).toBe(1);
		expect(result.check('path').fix).toContain(`ln -sf ${bin} ${fixture.user}/.local/bin/do-it`);
		expect(result.check('skill').fix).toEqual([`bun ${bin} skill install`]);
	});

	it("asks to stop a daemon of another build, and accepts this CLI's daemon", async () => {
		const fixture = doctorFixture();
		expect((await runCli(['skill', 'install'], fixture.env)).code).toBe(0);
		let build: string | undefined = 'other';
		const fake = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			fetch: () =>
				Response.json({
					ok: true,
					pid: process.pid,
					appVersion: APP_VERSION,
					...(build === undefined ? {} : { build })
				})
		});
		try {
			mkdirSync(fixture.home, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(fixture.home, 'daemon.json'),
				JSON.stringify({
					pid: process.pid,
					port: fake.port,
					appVersion: APP_VERSION,
					build: 'other',
					startedAt: Date.now()
				}),
				{ mode: 0o600 }
			);
			writeFileSync(join(fixture.home, 'token'), 'a'.repeat(64), { mode: 0o600 });
			const other = await doctor(fixture.env);
			expect(other.code).toBe(1);
			expect(other.check('daemon')).toMatchObject({ status: 'problem', fix: ['do-it stop'] });
			expect(other.check('daemon').message).toContain('runs build other');
			build = undefined;
			expect((await doctor(fixture.env)).check('daemon').message).toContain('reports no build id');
		} finally {
			void fake.stop(true);
			rmSync(join(fixture.home, 'daemon.json'), { force: true });
		}
		stops.push(fixture.env);
		expect((await runCli(['open', fixture.file, '--no-browser'], fixture.env)).code).toBe(0);
		const ours = await doctor(fixture.env);
		expect(ours.check('daemon')).toMatchObject({ status: 'ok', fix: [] });
		expect(ours.code).toBe(0);
	});
});
