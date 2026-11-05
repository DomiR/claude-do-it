import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Effect, Queue, Schema, Stream } from 'effect'
import { Mount } from 'foldkit'

import { editorExtensions, editorFacts, remoteTransaction } from './editor/extensions'
import { removeEditor, setEditor } from './editor/host'
import { storedWrap } from './editor/preferences'
import { Message } from './message'
import { Platform, Selection } from './model'

type MountEditorMessage =
  | typeof Message.SucceededMountEditor.Type
  | typeof Message.UpdatedEditor.Type
  | typeof Message.MovedEditorSelection.Type
  | typeof Message.PressedEditorCommand.Type
  | typeof Message.ShowedEditorNotice.Type
  | typeof Message.OpenedEditorLink.Type

export const MountEditor = Mount.defineStream('MountEditor', {
  args: { session: Schema.String, text: Schema.String, selection: Selection, platform: Platform },
  messages: [
    Message.SucceededMountEditor, Message.UpdatedEditor, Message.MovedEditorSelection,
    Message.PressedEditorCommand, Message.ShowedEditorNotice, Message.OpenedEditorLink,
  ],
  execute: ({ element, session, text, selection, platform }) =>
    Stream.callback<MountEditorMessage>(queue =>
      Effect.gen(function* () {
        const emit = (fact: MountEditorMessage) => { Queue.offerUnsafe(queue, fact) }
        yield* Effect.acquireRelease(
          Effect.try(() => {
            const view = new EditorView({
              parent: element,
              state: EditorState.create({
                doc: text,
                selection,
                extensions: [
                  // Read here rather than passed in, so toggling wrap never remounts the editor.
                  editorExtensions(platform, storedWrap()),
                  editorFacts.of(fact => {
                    if (fact._tag === 'PressedEditorCommand' && fact.command === 'openLink') {
                      emit(fact.link === undefined
                        ? Message.ShowedEditorNotice({ text: 'No link here' })
                        : Message.OpenedEditorLink({ url: fact.link }))
                    } else emit(fact)
                  }),
                  EditorView.updateListener.of(update => {
                    // A ViewUpdate can contain several transactions. Publish each
                    // transaction's own text and selection, in the same queue.
                    for (const transaction of update.transactions) {
                      const token = transaction.annotation(remoteTransaction)
                      const { anchor, head } = transaction.newSelection.main
                      // Even an empty remote change must acknowledge its token.
                      if (transaction.docChanged || token !== undefined) {
                        emit(Message.UpdatedEditor({
                          session, text: transaction.newDoc.toString(), anchor, head,
                          origin: token !== undefined ? 'Remote' : transaction.isUserEvent('input.action') ? 'Action' : 'Input',
                          token: token ?? null,
                        }))
                      } else if (!transaction.startState.selection.eq(transaction.newSelection)) {
                        emit(Message.MovedEditorSelection({ session, anchor, head }))
                      }
                    }
                  }),
                ],
              }),
            })
            setEditor(session, view)
            return view
          }),
          view => Effect.sync(() => removeEditor(session, view)),
        )
        emit(Message.SucceededMountEditor({ session }))
        return yield* Effect.never
      }).pipe(Effect.catch(() => Effect.sync(() => {
        Queue.offerUnsafe(queue, Message.ShowedEditorNotice({ text: 'Could not open the editor' }))
      }))),
    ),
})

export const FocusPaletteInput = Mount.define('FocusPaletteInput', {
  messages: [Message.CompletedFocusPaletteInput],
  execute: ({ element }) => Effect.sync(() => {
    if (element instanceof HTMLInputElement) element.focus({ preventScroll: true })
    return Message.CompletedFocusPaletteInput()
  }),
})
