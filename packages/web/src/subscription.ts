import { Cause, Effect, Option, Schema, Stream } from 'effect';
import { Subscription } from 'foldkit';
import { streamFromKeyBindings } from 'foldkit/dom';

import { Message } from './message';
import { Cursor, DocumentState, Model } from './model';
import { DoItClient, isUnauthorized } from './rpc';

export const subscriptions = Subscription.make<Model, Message, DoItClient>()((entry) => ({
	watch: entry(
		{
			maybeWatch: Schema.Option(
				Schema.Struct({
					path: Schema.String,
					watchKey: Schema.Number,
					resumeFrom: Schema.Option(Cursor)
				})
			)
		},
		{
			modelToDependencies: (model) => ({
				maybeWatch: DocumentState.match(model.document, {
					NoPath: () => Option.none(),
					Deleted: () => Option.none(),
					Unauthorized: () => Option.none(),
					Connecting: ({ path, watchKey, resumeFrom }) => Option.some({ path, watchKey, resumeFrom }),
					Ready: ({ document }) =>
						Option.some({
							path: document.path,
							watchKey: document.watchKey,
							resumeFrom: document.resumeFrom
						})
				})
			}),
			dependenciesToStream: ({ maybeWatch }) =>
				Option.match(maybeWatch, {
					onNone: () => Stream.empty,
					onSome: ({ path, resumeFrom }) =>
						Effect.gen(function* () {
							const client = yield* DoItClient;
							// Omit an absent cursor. Effect's JSON codec encodes a present
							// undefined as null, which older running daemons reject.
							const since = Option.match(resumeFrom, {
								onNone: () => ({}),
								onSome: ({ version, hash }) => ({ since: version, ...(hash === undefined ? {} : { sinceHash: hash }) })
							});
							return client.watch({ path, text: true, ...since }).pipe(
								Stream.map((event) => Message.ReceivedWatchEvent({ event })),
								Stream.concat(Stream.succeed(Message.WatchEnded())),
								Stream.catchCause((cause) =>
									Stream.succeed(
										Message.FailedWatch({
											unauthorized: Option.match(Cause.findErrorOption(cause), {
												onNone: () => false,
												onSome: isUnauthorized
											})
										})
									)
								)
							);
						}).pipe(Stream.unwrap)
				})
		}
	),
	keyboard: Subscription.persistentEntry(
		streamFromKeyBindings({
			bindings: [
				{ keys: '?', mapEvent: () => Message.PressedHelpKey() },
				{ keys: 'Shift+?', mapEvent: () => Message.PressedHelpKey() }
			]
		})
	)
}));
