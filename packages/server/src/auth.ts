import { Refused } from '@do-it/protocol';
import { Data, Effect, FileSystem, Path, PlatformError } from 'effect';
import { Mac, SecureRandom } from 'effect/crypto';
import { Hex } from 'effect/encoding';

const encoder = new TextEncoder();
const CODE_LIFETIME = 5 * 60 * 1000;

export class InvalidToken extends Data.TaggedError('InvalidToken')<{ readonly message: string }> {}

function equal(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	return left.length === right.length && Mac.timingSafeEqual(left, right);
}
function alreadyExists(error: PlatformError.PlatformError): boolean {
	return error.reason._tag === 'AlreadyExists';
}

export class Auth {
	private readonly codes = new Map<string, { path: string; until: number }>();
	private constructor(
		readonly token: string,
		readonly cookie: string,
		private readonly random: SecureRandom.SecureRandom['Service']
	) {}

	/** Loads the daemon token from `home`, creating it on first start. */
	static readonly make = Effect.fn('Auth.make')(function* (home: string) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const random = yield* SecureRandom.SecureRandom;
		const mac = yield* Mac.Mac;
		const file = path.join(home, 'token');
		const fresh = Hex.encode(yield* random.randomBytes(32));
		yield* fs
			.writeFileString(file, fresh, { flag: 'wx', mode: 0o600 })
			.pipe(Effect.catchIf(alreadyExists, () => Effect.void));
		const invalid = new InvalidToken({ message: 'The daemon token file is invalid' });
		if (Number((yield* fs.stat(file)).size) > 128) return yield* Effect.fail(invalid);
		const token = (yield* fs.readFileString(file)).trim();
		if (!/^[a-f0-9]{64}$/.test(token)) return yield* Effect.fail(invalid);
		yield* fs.chmod(file, 0o600);
		const key = yield* Mac.key(Mac.hmacSha256, encoder.encode(token));
		const cookie = Hex.encode(yield* mac.sign(key, encoder.encode('web cookie')));
		return new Auth(token, cookie, random);
	});

	authorized(authorization: string | undefined, cookie: string | undefined): boolean {
		return (
			(authorization !== undefined && equal(authorization, `Bearer ${this.token}`)) ||
			(cookie !== undefined && equal(cookie, this.cookie))
		);
	}

	/** A one-time browser sign-in code for `path`, valid for five minutes. */
	mint(path: string, now = Date.now()): Effect.Effect<string, Refused> {
		return Effect.gen({ self: this }, function* () {
			for (const [code, entry] of this.codes) if (entry.until <= now) this.codes.delete(code);
			if (this.codes.size >= 64) {
				return yield* Effect.fail(
					new Refused({
						code: 'too-large',
						message: 'Too many unused browser sign-in codes, use an existing link or wait five minutes'
					})
				);
			}
			const code = Hex.encode(yield* this.random.randomBytes(32));
			this.codes.set(code, { path, until: now + CODE_LIFETIME });
			return code;
		});
	}

	consume(code: string, path: string, now = Date.now()): boolean {
		const entry = this.codes.get(code);
		if (!entry) return false;
		if (entry.until <= now) {
			this.codes.delete(code);
			return false;
		}
		if (entry.path !== path) return false;
		this.codes.delete(code);
		return true;
	}
}
