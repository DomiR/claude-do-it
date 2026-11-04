import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import { WatchEvent } from '@do-it/protocol'

export const Message = defineMessageUnion({
  SelectedMode: { mode: Schema.Literals(['Tasks', 'Markdown']) },
  UpdatedMarkdown: { text: Schema.String, selectionStart: Schema.Number, selectionEnd: Schema.Number },
  UpdatedTaskInput: { section: Schema.NullOr(Schema.String), text: Schema.String },
  ClickedAddTask: { section: Schema.NullOr(Schema.String) },
  ClickedTodo: { number: Schema.Number },
  ReceivedWatchEvent: { event: WatchEvent },
  WatchEnded: {},
  FailedWatch: { unauthorized: Schema.Boolean },
  CompletedWaitBeforeReconnect: {},
  CompletedWaitBeforeSync: { revision: Schema.Number },
  SucceededSync: {
    request: Schema.Struct({ base: Schema.Number, text: Schema.String }),
    version: Schema.Number,
    text: Schema.String,
  },
  FailedSync: { unauthorized: Schema.Boolean },
  CompletedApplySelection: {},
})
export type Message = typeof Message.Type
