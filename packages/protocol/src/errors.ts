import { Schema } from 'effect';

import { Path, Text, Version } from './schema.js';

export class VersionMismatch extends Schema.TaggedError<VersionMismatch>()('VersionMismatch', {
	latest: Version,
	since: Version,
	diff: Schema.NullOr(Text),
	forgotten: Schema.Boolean
}) {}

export const RefusedCode = Schema.Literals(['not-found', 'ambiguous', 'too-large', 'invalid']);
export type RefusedCode = typeof RefusedCode.Type;

export class Refused extends Schema.TaggedError<Refused>()('Refused', {
	code: RefusedCode,
	message: Text
}) {}

export class Forgotten extends Schema.TaggedError<Forgotten>()('Forgotten', {
	latest: Version
}) {}

export class NothingYet extends Schema.TaggedError<NothingYet>()('NothingYet', {}) {}

export class DocumentGone extends Schema.TaggedError<DocumentGone>()('DocumentGone', {
	path: Path
}) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', {}) {}

export const RpcFailure = Schema.Union([VersionMismatch, Refused, Forgotten, NothingYet, DocumentGone, Unauthorized]);
export type RpcFailure = typeof RpcFailure.Type;
