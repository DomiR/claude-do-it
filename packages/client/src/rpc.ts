import { DoItRpcs } from '@do-it/protocol';
import { Context, Effect, Layer } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { RpcClient as Rpc, RpcClientError, RpcSerialization } from 'effect/rpc';
import type { DaemonInfo } from './info';

export type DoItClient = Rpc.FromGroup<typeof DoItRpcs, RpcClientError.RpcClientError>;
export class RpcClient extends Context.Service<RpcClient, DoItClient>()('@do-it/client/RpcClient') {}

export function RpcClientLive(info: DaemonInfo): Layer.Layer<RpcClient> {
	const http = Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, HttpClient.filterStatusOk)).pipe(
		Layer.provide(FetchHttpClient.layer)
	);
	const protocol = Rpc.layerProtocolHttp({
		url: `${info.baseUrl}/rpc`,
		transformClient: (client) =>
			HttpClient.mapRequest(client, (request) =>
				request.pipe(
					// Effect's prependUrl joins an empty request path with a trailing slash.
					HttpClientRequest.setUrl(`${info.baseUrl}/rpc`),
					HttpClientRequest.setHeader('Authorization', `Bearer ${info.token}`)
				)
			)
	}).pipe(Layer.provide([http, RpcSerialization.layerNdjson]));
	return Layer.effect(RpcClient, Rpc.make(DoItRpcs)).pipe(Layer.provide(protocol));
}

export function withClient<A, E, R>(info: DaemonInfo, f: (client: DoItClient) => Effect.Effect<A, E, R>) {
	return Effect.flatMap(RpcClient, f).pipe(Effect.provide(RpcClientLive(info)));
}
