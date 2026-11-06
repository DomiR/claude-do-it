import { Effect, FileSystem, Option, Path, PlatformError } from 'effect';
import { SecureRandom } from 'effect/crypto';
import { MAX_BYTES } from './constants';
import { checkText } from './edit';
import { DocError } from './errors';

export interface Stamp {
	mtimeMs: number;
	size: number;
	ino: number;
}
export interface Format {
	bom: boolean;
	crlf: boolean;
}

function of(info: FileSystem.File.Info): Stamp {
	return {
		mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
		size: Number(info.size),
		ino: Number(Option.getOrElse(info.ino, () => 0n))
	};
}
/** True when a file system call failed because the path does not exist. */
export function isNotFound(error: unknown): boolean {
	return PlatformError.isPlatformError(error) && error.reason._tag === 'NotFound';
}
function ioError(path: string, error: unknown): DocError {
	if (error instanceof DocError) return error;
	return new DocError({
		code: isNotFound(error) ? 'not-found' : 'invalid',
		message: `Could not access ${path}: ${error instanceof Error ? error.message : String(error)}`
	});
}
function checkBytes(size: number): Effect.Effect<void, DocError> {
	return size > MAX_BYTES
		? Effect.fail(
				new DocError({ code: 'too-large', message: `The file is ${size} bytes, over the limit of ${MAX_BYTES}` })
			)
		: Effect.void;
}
const notRegular = (path: string) => new DocError({ code: 'invalid', message: `${path} is not a regular file` });

/** The file's identity for change detection, or null when it does not exist. */
export const stamp = Effect.fn('stamp')(function* (path: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs.stat(path).pipe(
		Effect.map((info): Stamp | null => of(info)),
		Effect.catchIf(isNotFound, () => Effect.succeed(null)),
		Effect.mapError((error) => ioError(path, error))
	);
});

export const readFile = Effect.fn('readFile')(
	function* (path: string) {
		const fs = yield* FileSystem.FileSystem;
		// Opening a FIFO blocks until a writer appears, so refuse anything that is
		// not a regular file before opening it. The descriptor is checked again below.
		if ((yield* fs.stat(path)).type !== 'File') return yield* Effect.fail(notRegular(path));
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const file = yield* fs.open(path, { flag: 'r' });
				const info = yield* file.stat;
				if (info.type !== 'File') return yield* Effect.fail(notRegular(path));
				yield* checkBytes(Number(info.size));
				// The extra byte detects growth during the read without ever reading an
				// unbounded file into memory. Metadata and contents use the same descriptor.
				const bytes = new Uint8Array(MAX_BYTES + 1);
				let size = 0;
				while (size < bytes.length) {
					const read = yield* file.read(bytes.subarray(size));
					if (!read) break;
					size += read;
				}
				yield* checkBytes(size);
				let raw: string;
				try {
					raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
				} catch {
					return yield* Effect.fail(new DocError({ code: 'invalid', message: `${path} is not valid UTF-8 text` }));
				}
				const bom = raw.startsWith('\ufeff');
				if (bom) raw = raw.slice(1);
				const firstBreak = raw.indexOf('\n');
				const crlf = firstBreak > 0 && raw[firstBreak - 1] === '\r';
				return { text: raw.replace(/\r\n/g, '\n'), stamp: of(info), format: { bom, crlf } satisfies Format };
			})
		);
	},
	(effect, path) => Effect.mapError(effect, (error) => ioError(path, error))
);

export const writeAtomic = Effect.fn('writeAtomic')(
	function* (path: string, text: string, format: Format) {
		const fs = yield* FileSystem.FileSystem;
		const paths = yield* Path.Path;
		yield* Effect.try({ try: () => checkText(text), catch: (error) => error });
		const encoded = new TextEncoder().encode(
			(format.bom ? '\ufeff' : '') + (format.crlf ? text.replace(/\n/g, '\r\n') : text)
		);
		yield* checkBytes(encoded.length);
		const temporary = paths.join(
			paths.dirname(path),
			`.${paths.basename(path)}.do-it-${SecureRandom.uuidV4Unsafe()}.tmp`
		);
		const mode = yield* fs.stat(path).pipe(
			Effect.map((info): number | undefined => info.mode & 0o7777),
			Effect.catchIf(isNotFound, () => Effect.succeed(undefined))
		);
		let created = false;
		const write = Effect.scoped(
			Effect.gen(function* () {
				const file = yield* fs.open(temporary, { flag: 'wx', mode: mode ?? 0o666 });
				created = true;
				yield* file.writeAll(encoded);
				// The umask narrows the mode given to open, so set the original mode again.
				if (mode !== undefined) yield* fs.chmod(temporary, mode);
				yield* file.sync;
				return of(yield* file.stat);
			})
		);
		return yield* write.pipe(
			Effect.tap(() => fs.rename(temporary, path)),
			Effect.onError(() => (created ? Effect.ignore(fs.remove(temporary)) : Effect.void))
		);
	},
	(effect, path) => Effect.mapError(effect, (error) => ioError(path, error))
);
