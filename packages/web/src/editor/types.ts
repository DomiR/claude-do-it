import type { Edit } from '@do-it/doc/text'

/** One selection range in UTF-16 offsets. `anchor` stays put, `head` is where the caret is. */
export interface Range {
  readonly anchor: number
  readonly head: number
}

/** Every range of the editor selection; `main` indexes the primary range. */
export interface TextSelection {
  readonly ranges: ReadonlyArray<Range>
  readonly main: number
}

/** Text changing PlainTasks actions, all computed by `runAction` in actions.ts. */
export type ActionId =
  | 'newTask'
  | 'toggleDone'
  | 'toggleCancelled'
  | 'archive'
  | 'moveUp'
  | 'moveDown'
  | 'continueTask'
  | 'indent'
  | 'outdent'

/** Everything the keymap and the command palette can invoke. */
export type EditorCommand =
  | ActionId
  | 'openLink'
  | 'gotoProject'
  | 'commandPalette'
  | 'find'
  | 'showShortcuts'

/**
 * `Applied.edits` are sorted, non overlapping, and in offsets of the text the action ran on
 * (CodeMirror `ChangeSet.of` semantics). `Applied.selection` is in offsets of the new text.
 * `Unavailable.reason` is a short sentence for the status bar, with no dash separators.
 */
export type ActionResult =
  | { readonly _tag: 'Applied'; readonly edits: ReadonlyArray<Edit>; readonly selection: TextSelection }
  | { readonly _tag: 'Unavailable'; readonly reason: string }
