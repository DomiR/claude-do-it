import { Effect, FileSystem, Option, Path, PlatformError, Semaphore } from 'effect';

const MAX_LOG = 1024 * 1024;
const MAX_LINE = 16 * 1024;

export class Log {
	/** Rotation and appends must not interleave, or a line could land in the copied file. */
	private readonly lock = Semaphore.makeUnsafe(1);
	private constructor(
		private readonly fs: FileSystem.FileSystem,
		readonly path: string
	) {}

	static readonly make = Effect.fn('Log.make')(function* (home: string) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return new Log(fs, path.join(home, 'daemon.log'));
	});

	rotate(): Effect.Effect<void, PlatformError.PlatformError> {
		return this.lock.withPermit(this.rotateUnlocked());
	}

	/** Appends one timestamped line. Logging never fails the caller. */
	write(message: string): Effect.Effect<void> {
		const { fs, path } = this;
		return this.lock
			.withPermit(
				Effect.gen({ self: this }, function* () {
					yield* this.rotateUnlocked();
					const line = new TextEncoder().encode(`${new Date().toISOString()} ${message}\n`);
					if (line.length <= MAX_LINE) yield* fs.writeFile(path, line, { flag: 'a', mode: 0o600 });
				})
			)
			.pipe(Effect.ignore);
	}

	private rotateUnlocked(): Effect.Effect<void, PlatformError.PlatformError> {
		const { fs, path } = this;
		return Effect.gen(function* () {
			const info = yield* fs.stat(path).pipe(Effect.option);
			if (Option.isNone(info) || Number(info.value.size) < MAX_LOG) return;
			// Keep the inode: the daemon's stdout and stderr hold append descriptors
			// to this file and would otherwise keep filling the renamed old log.
			yield* fs.copyFile(path, `${path}.old`);
			yield* fs.truncate(path, 0);
		});
	}
}
