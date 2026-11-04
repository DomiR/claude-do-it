import { Duration, Effect, Schema } from 'effect'
import { Command } from 'foldkit'

import { Message } from './message'
import { DoItClient, isUnauthorized } from './rpc'

export const WaitBeforeReconnect = Command.define('WaitBeforeReconnect', {
  args: { attempt: Schema.Number },
  messages: [Message.CompletedWaitBeforeReconnect],
  execute: ({ attempt }) =>
    Effect.sleep(Duration.millis(Math.min(500 * 2 ** Math.max(0, attempt - 1), 5000))).pipe(
      Effect.as(Message.CompletedWaitBeforeReconnect()),
    ),
})

export const WaitBeforeSync = Command.define('WaitBeforeSync', {
  args: { revision: Schema.Number },
  messages: [Message.CompletedWaitBeforeSync],
  execute: ({ revision }) =>
    Effect.sleep('400 millis').pipe(Effect.as(Message.CompletedWaitBeforeSync({ revision }))),
})

export const SyncDraft = Command.define('SyncDraft', {
  args: { path: Schema.String, base: Schema.Number, text: Schema.String },
  messages: [Message.SucceededSync, Message.FailedSync],
  execute: ({ path, base, text }) =>
    Effect.gen(function* () {
      const client = yield* DoItClient
      const result = yield* client.sync({ path, base, text })
      return Message.SucceededSync({ request: { base, text }, version: result.version, text: result.text })
    }).pipe(
      Effect.catch(error => Effect.succeed(Message.FailedSync({ unauthorized: isUnauthorized(error) }))),
    ),
})

export const ApplySelection = Command.define('ApplySelection', {
  args: { start: Schema.Number, end: Schema.Number },
  messages: [Message.CompletedApplySelection],
  execute: ({ start, end }) =>
    Effect.sync(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-editor-textarea]')
      textarea?.setSelectionRange(start, end)
      return Message.CompletedApplySelection()
    }),
})
