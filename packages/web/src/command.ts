import { Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { Duration, Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'

import { sections } from '@do-it/doc/text'
import type { RpcFailure } from '@do-it/protocol'
import { rebaseRemote } from './editor/changes'
import { remoteTransaction, runEditorCommand, setLineWrap } from './editor/extensions'
import { getEditor } from './editor/host'
import { storeWrap } from './editor/preferences'
import { Message, type SyncFailureKind } from './message'
import { EditorCommandName } from './model'
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
  args: { session: Schema.String, revision: Schema.Number },
  messages: [Message.CompletedWaitBeforeSync],
  execute: args => Effect.sleep('400 millis').pipe(Effect.as(Message.CompletedWaitBeforeSync(args))),
})

export const WaitBeforeSyncRetry = Command.define('WaitBeforeSyncRetry', {
  args: { session: Schema.String, attempt: Schema.Number },
  messages: [Message.CompletedWaitBeforeSyncRetry],
  execute: args => Effect.sleep('2 seconds').pipe(Effect.as(Message.CompletedWaitBeforeSyncRetry(args))),
})

export const WaitBeforeRemoteRetry = Command.define('WaitBeforeRemoteRetry', {
  args: { session: Schema.String, token: Schema.Number },
  messages: [Message.CompletedWaitBeforeRemoteRetry],
  execute: args => Effect.sleep('500 millis').pipe(Effect.as(Message.CompletedWaitBeforeRemoteRetry(args))),
})

export const syncFailureKind = (error: RpcFailure | { readonly _tag: 'RpcClientError' }): SyncFailureKind => {
  if (isUnauthorized(error)) return 'Unauthorized'
  switch (error._tag) {
    case 'Forgotten': return 'Forgotten'
    case 'DocumentGone': return 'DocumentGone'
    case 'VersionMismatch': return error.forgotten ? 'Forgotten' : 'Transient'
    default: return 'Transient'
  }
}

export const SyncDraft = Command.define('SyncDraft', {
  args: { path: Schema.String, base: Schema.Number, text: Schema.String },
  messages: [Message.SucceededSync, Message.FailedSync],
  execute: ({ path, base, text }) =>
    Effect.gen(function* () {
      const client = yield* DoItClient
      const result = yield* client.sync({ path, base, text })
      return Message.SucceededSync({ request: { base, text }, version: result.version, text: result.text })
    }).pipe(
      Effect.catch(error => Effect.succeed(Message.FailedSync({ request: { base, text }, kind: syncFailureKind(error) }))),
    ),
})

type RemoteResult = typeof Message.CompletedApplyRemoteText.Type | typeof Message.FailedApplyRemoteText.Type

export const ApplyRemoteText = Command.define('ApplyRemoteText', {
  args: { session: Schema.String, token: Schema.Number, from: Schema.String, to: Schema.String },
  messages: [Message.CompletedApplyRemoteText, Message.FailedApplyRemoteText],
  execute: ({ session, token, from, to }) => Effect.callback<RemoteResult>(resume => {
    const maybeView = getEditor(session)
    if (Option.isNone(maybeView)) {
      resume(Effect.succeed(Message.FailedApplyRemoteText({ token, reason: 'Editor is not mounted' })))
      return
    }
    const view = maybeView.value
    const ownerWindow = view.dom.ownerDocument.defaultView
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame: number | undefined
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (frame !== undefined) ownerWindow?.cancelAnimationFrame(frame)
      view.contentDOM.removeEventListener('compositionend', endedComposition)
    }
    const finish = (fact: RemoteResult) => {
      if (finished) return
      finished = true
      cleanup()
      resume(Effect.succeed(fact))
    }
    const apply = () => {
      if (finished) return
      const current = getEditor(session)
      if (Option.isNone(current) || current.value !== view) {
        finish(Message.FailedApplyRemoteText({ token, reason: 'Editor is no longer mounted' }))
        return
      }
      if (view.composing) return
      try {
        view.dispatch({
          changes: rebaseRemote(from, to, view.state.doc.toString()),
          annotations: [Transaction.addToHistory.of(false), remoteTransaction.of(token)],
        })
        finish(Message.CompletedApplyRemoteText({ token }))
      } catch {
        finish(Message.FailedApplyRemoteText({ token, reason: 'Could not apply the remote text' }))
      }
    }
    function endedComposition(): void {
      if (finished || !ownerWindow) return
      if (frame !== undefined) ownerWindow.cancelAnimationFrame(frame)
      frame = ownerWindow.requestAnimationFrame(() => { frame = undefined; apply() })
    }
    if (view.composing) {
      view.contentDOM.addEventListener('compositionend', endedComposition)
      timer = setTimeout(() => finish(Message.FailedApplyRemoteText({ token, reason: 'Composition did not finish in time' })), 2000)
    } else apply()
    return Effect.sync(() => { finished = true; cleanup() })
  }),
})

export const FocusEditor = Command.define('FocusEditor', {
  args: { session: Schema.String },
  messages: [Message.CompletedFocusEditor],
  execute: ({ session }) => Effect.sync(() => {
    const maybeView = getEditor(session)
    if (Option.isSome(maybeView)) maybeView.value.focus()
    return Message.CompletedFocusEditor()
  }),
})

export const RunEditorAction = Command.define('RunEditorAction', {
  args: { session: Schema.String, action: EditorCommandName },
  messages: [Message.CompletedRunEditorAction, Message.ShowedEditorNotice],
  execute: ({ session, action }) => Effect.try(() => {
    const maybeView = getEditor(session)
    if (Option.isNone(maybeView)) return Message.ShowedEditorNotice({ text: 'Editor is not mounted' })
    const view = maybeView.value
    view.focus()
    runEditorCommand(view, action)
    return Message.CompletedRunEditorAction()
  }).pipe(Effect.catch(() => Effect.succeed(Message.ShowedEditorNotice({ text: 'Could not run this command' })))),
})

const reveal = (view: EditorView, offset: number): void => {
  const head = Math.max(0, Math.min(offset, view.state.doc.length))
  view.dispatch({ selection: { anchor: head }, scrollIntoView: true })
  view.focus()
}

export const RevealEditorPosition = Command.define('RevealEditorPosition', {
  args: { session: Schema.String, offset: Schema.Number },
  messages: [Message.CompletedRevealEditorPosition],
  execute: ({ session, offset }) => Effect.sync(() => {
    const maybeView = getEditor(session)
    if (Option.isSome(maybeView)) reveal(maybeView.value, offset)
    return Message.CompletedRevealEditorPosition()
  }),
})

/** Turns line wrapping on or off in the open editor, remembers it for this browser, and returns focus to the text. */
export const SetEditorWrap = Command.define('SetEditorWrap', {
  args: { session: Schema.String, wrap: Schema.Boolean },
  messages: [Message.CompletedSetEditorWrap],
  execute: ({ session, wrap }) => Effect.sync(() => {
    storeWrap(wrap)
    const maybeView = getEditor(session)
    if (Option.isSome(maybeView)) {
      setLineWrap(maybeView.value, wrap)
      maybeView.value.focus()
    }
    return Message.CompletedSetEditorWrap()
  }),
})

export const OpenEditorLink = Command.define('OpenEditorLink', {
  args: { session: Schema.String, url: Schema.String },
  messages: [Message.CompletedOpenEditorLink, Message.ShowedEditorNotice],
  execute: ({ session, url }) => Effect.try(() => {
    if (/^(https?:|mailto:)/i.test(url)) {
      const opened = window.open(url, '_blank', 'noopener,noreferrer')
      // Browsers can withhold the handle for either a blocked popup or an
      // isolated window. Keep a normal link available in either case.
      return opened ? Message.CompletedOpenEditorLink() : Message.ShowedEditorNotice({ text: url })
    }
    if (url.startsWith('#')) {
      const maybeView = getEditor(session)
      if (Option.isSome(maybeView)) {
        const view = maybeView.value
        const section = sections(view.state.doc.toString()).find(candidate => candidate.id === decodeURIComponent(url.slice(1)))
        if (section) {
          reveal(view, section.from)
          return Message.CompletedOpenEditorLink()
        }
      }
      return Message.ShowedEditorNotice({ text: 'Project not found' })
    }
    return Message.ShowedEditorNotice({ text: 'This link cannot be opened here' })
  }).pipe(Effect.catch(() => Effect.succeed(Message.ShowedEditorNotice({ text: 'Could not open this link' })))),
})
