import { Config, Effect, Option, Path } from 'effect';

export interface Paths {
	readonly home: string;
	readonly daemon: string;
	readonly token: string;
	readonly lock: string;
	readonly lockPid: string;
	readonly log: string;
	readonly versions: string;
}

/** The daemon home: `DO_IT_HOME`, else `$HOME/.do-it`. */
const defaultHome = Effect.gen(function* () {
	const path = yield* Path.Path;
	const configured = yield* Config.option(Config.String('DO_IT_HOME'));
	if (Option.isSome(configured)) return configured.value;
	return path.join(yield* Config.String('HOME'), '.do-it');
}).pipe(Effect.orDie);

export function paths(home?: string): Effect.Effect<Paths, never, Path.Path> {
	return Effect.gen(function* () {
		const path = yield* Path.Path;
		const root = path.resolve(home ?? (yield* defaultHome));
		const lock = path.join(root, 'daemon.lock');
		return {
			home: root,
			daemon: path.join(root, 'daemon.json'),
			token: path.join(root, 'token'),
			lock,
			lockPid: path.join(lock, 'pid'),
			log: path.join(root, 'daemon.log'),
			versions: path.join(root, 'versions.json')
		};
	});
}
