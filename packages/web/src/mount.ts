import { Effect, Queue, Stream } from 'effect'
import { Mount } from 'foldkit'

import { Message } from './message'

export const CaptureEditorInput = Mount.defineStream('CaptureEditorInput', {
  messages: [Message.UpdatedMarkdown],
  execute: ({ element }) =>
    Stream.callback<typeof Message.UpdatedMarkdown.Type>(queue =>
      Effect.gen(function* () {
        const textarea = element as HTMLTextAreaElement
        const handler = () =>
          Queue.offerUnsafe(
            queue,
            Message.UpdatedMarkdown({
              text: textarea.value,
              selectionStart: textarea.selectionStart,
              selectionEnd: textarea.selectionEnd,
            }),
          )
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            textarea.addEventListener('input', handler)
            return handler
          }),
          registeredHandler => Effect.sync(() => textarea.removeEventListener('input', registeredHandler)),
        )
        return yield* Effect.never
      }),
    ),
})
