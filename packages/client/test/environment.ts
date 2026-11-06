import { afterAll, beforeAll } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { ConfigProvider, Effect } from 'effect';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDaemonInfo, stopDaemon, type ClientServices } from '../src';

/**
 * Runs a client effect with the Bun platform services. The default
 * ConfigProvider keeps the environment it first read for the whole process,
 * so each run reads `process.env` again: a test that changes `DO_IT_HOME`
 * must not reach a home an earlier read saw.
 */
export function runClient<A, E>(effect: Effect.Effect<A, E, ClientServices>): Promise<A> {
	return Effect.runPromise(
		effect.pipe(
			Effect.provide(BunServices.layer),
			Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv())
		)
	);
}

/** Even a lifecycle call that forgets its explicit home stays in a temp directory. */
export function isolateDaemonEnvironment(): string {
	const home = mkdtempSync(join(tmpdir(), 'do-it-test-default-'));
	let previousHome: string | undefined;
	let previousPort: string | undefined;
	beforeAll(() => {
		previousHome = process.env.DO_IT_HOME;
		previousPort = process.env.DO_IT_PORT;
		process.env.DO_IT_HOME = home;
		process.env.DO_IT_PORT = '0';
	});
	afterAll(async () => {
		try {
			const info = await runClient(readDaemonInfo(home));
			const stopped = await runClient(stopDaemon(home));
			if (!stopped && info && info.pid !== process.pid) {
				try {
					process.kill(info.pid, 'SIGKILL');
				} catch {
					/* Already exited. */
				}
			}
		} finally {
			if (previousHome === undefined) delete process.env.DO_IT_HOME;
			else process.env.DO_IT_HOME = previousHome;
			if (previousPort === undefined) delete process.env.DO_IT_PORT;
			else process.env.DO_IT_PORT = previousPort;
			rmSync(home, { recursive: true, force: true });
		}
	});
	return home;
}
