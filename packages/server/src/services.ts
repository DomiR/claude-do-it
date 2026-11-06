import { BunCrypto, BunHttpPlatform, BunServices } from '@effect/platform-bun';
import { Layer } from 'effect';

/** The platform services the daemon needs: files, paths, hashing, HMAC, randomness, and file responses. */
export const ServerServices = Layer.mergeAll(
	BunServices.layer,
	BunCrypto.layerDigest,
	BunCrypto.layerMac,
	BunCrypto.layerSecureRandom,
	BunHttpPlatform.layer
);
