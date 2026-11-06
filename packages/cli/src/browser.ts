import { Config, Effect, Option } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

/** Opens `url` with the `DO_IT_BROWSER` shell command, or the platform opener. `true` turns it off. */
export const openBrowser = (url: string) =>
	Effect.gen(function* () {
		const configured = Option.getOrUndefined(yield* Config.option(Config.String('DO_IT_BROWSER')));
		if (configured?.toLowerCase() === 'true') return;
		const command = configured || (process.platform === 'darwin' ? 'open' : 'xdg-open');
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		// The shell runs the configured command and receives the URL as "$1", so it needs no quoting.
		const opener = ChildProcess.make('/bin/sh', ['-c', `${command} "$1"`, 'sh', url], {
			detached: true,
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore'
		});
		yield* Effect.scoped(Effect.flatMap(spawner.spawn(opener), (child) => Effect.asVoid(child.unref)));
	}).pipe(Effect.ignore);
