import { Context, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { RpcClient, RpcClientError, RpcSerialization } from 'effect/rpc';

import { DoItRpcs } from '@do-it/protocol';

type DoItRpcClient = RpcClient.FromGroup<typeof DoItRpcs, RpcClientError.RpcClientError>;

export class DoItClient extends Context.Service<DoItClient, DoItRpcClient>()('DoItClient') {}

const ProtocolLive = RpcClient.layerProtocolHttp({ url: '/rpc' }).pipe(
	Layer.provide(
		Layer.mergeAll(
			FetchHttpClient.layer,
			RpcSerialization.layerNdjson,
			Layer.succeed(FetchHttpClient.RequestInit, { credentials: 'same-origin' })
		)
	)
);

export const DoItClientLive = Layer.effect(DoItClient, RpcClient.make(DoItRpcs)).pipe(Layer.provide(ProtocolLive));

export const isUnauthorized = (error: unknown): boolean => {
	if (typeof error !== 'object' || error === null) return false;
	if ('_tag' in error && error._tag === 'Unauthorized') return true;
	if ('reason' in error && typeof error.reason === 'object' && error.reason !== null) {
		return 'message' in error.reason && String(error.reason.message).includes('401');
	}
	return false;
};
