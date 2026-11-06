import { Data, Effect, FileSystem } from 'effect';
import { SecureRandom } from 'effect/crypto';

export class StateFileError extends Data.TaggedError('StateFileError')<{ readonly message: string }> {}

/** Reads a JSON state file, refusing one larger than `maxBytes`. */
export const readJson = Effect.fn('readJson')(function* (path: string, maxBytes = 2 * 1024 * 1024) {
	const fs = yield* FileSystem.FileSystem;
	const bytes = yield* Effect.scoped(
		Effect.gen(function* () {
			const file = yield* fs.open(path, { flag: 'r' });
			const data = new Uint8Array(maxBytes + 1);
			let size = 0;
			while (size <= maxBytes) {
				const count = yield* file.read(data.subarray(size));
				if (count === 0) return data.subarray(0, size);
				size += count;
			}
			return yield* Effect.fail(new StateFileError({ message: `State file exceeds ${maxBytes} bytes` }));
		})
	);
	return yield* Effect.try({
		try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
		catch: (error) => new StateFileError({ message: `State file is not JSON: ${String(error)}` })
	});
});

/** Replaces a state file atomically, readable by the owner only. */
export const writeJson = Effect.fn('writeJson')(function* (path: string, data: unknown) {
	const fs = yield* FileSystem.FileSystem;
	const temporary = `${path}.${SecureRandom.uuidV4Unsafe()}.tmp`;
	let created = false;
	yield* Effect.scoped(
		Effect.gen(function* () {
			const file = yield* fs.open(temporary, { flag: 'wx', mode: 0o600 });
			created = true;
			yield* file.writeAll(new TextEncoder().encode(JSON.stringify(data) + '\n'));
			yield* file.sync;
		})
	).pipe(
		Effect.andThen(fs.rename(temporary, path)),
		Effect.onError(() => (created ? Effect.ignore(fs.remove(temporary)) : Effect.void))
	);
});
