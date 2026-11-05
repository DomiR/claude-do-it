import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import { WatchEvent } from '@do-it/protocol'
import { EditorCommandName, SyncRequest } from './model'

export const SyncFailureKind = Schema.Literals(['Unauthorized', 'Forgotten', 'DocumentGone', 'Transient'])
export type SyncFailureKind = typeof SyncFailureKind.Type

export const Message = defineMessageUnion({
  SucceededMountEditor: { session: Schema.String },
  UpdatedEditor: {
    session: Schema.String, text: Schema.String, anchor: Schema.Number, head: Schema.Number,
    origin: Schema.Literals(['Input', 'Action', 'Remote']), token: Schema.NullOr(Schema.Number),
  },
  MovedEditorSelection: { session: Schema.String, anchor: Schema.Number, head: Schema.Number },
  PressedEditorCommand: { command: EditorCommandName, link: Schema.optionalKey(Schema.String) },
  ShowedEditorNotice: { text: Schema.String },
  OpenedEditorLink: { url: Schema.String },
  ClickedCommands: {},
  PressedHelpKey: {},
  ClickedActivity: {},
  ClickedWrapToggle: {},
  CompletedSetEditorWrap: {},
  UpdatedPaletteQuery: { query: Schema.String },
  PressedPaletteKey: { key: Schema.Literals(['ArrowUp', 'ArrowDown', 'Enter', 'Escape']) },
  ClickedPaletteItem: { index: Schema.Number },
  CompletedFocusPaletteInput: {},
  CompletedFocusEditor: {},
  CompletedRunEditorAction: {},
  CompletedRevealEditorPosition: {},
  CompletedOpenEditorLink: {},
  CompletedApplyRemoteText: { token: Schema.Number },
  FailedApplyRemoteText: { token: Schema.Number, reason: Schema.String },
  CompletedWaitBeforeRemoteRetry: { session: Schema.String, token: Schema.Number },
  ReceivedWatchEvent: { event: WatchEvent },
  WatchEnded: {},
  FailedWatch: { unauthorized: Schema.Boolean },
  CompletedWaitBeforeReconnect: {},
  CompletedWaitBeforeSync: { session: Schema.String, revision: Schema.Number },
  CompletedWaitBeforeSyncRetry: { session: Schema.String, attempt: Schema.Number },
  SucceededSync: { request: SyncRequest, version: Schema.Number, text: Schema.String },
  FailedSync: { request: SyncRequest, kind: SyncFailureKind },
})
export type Message = typeof Message.Type
