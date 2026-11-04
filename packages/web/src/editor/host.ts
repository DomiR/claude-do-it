import type { EditorView } from '@codemirror/view'
import { Option } from 'effect'

const editors = new Map<string, EditorView>()

export const setEditor = (session: string, view: EditorView): void => {
  editors.set(session, view)
}

export const getEditor = (session: string): Option.Option<EditorView> =>
  Option.fromNullishOr(editors.get(session))

export const removeEditor = (session: string, view: EditorView): void => {
  try { view.destroy() }
  finally { if (editors.get(session) === view) editors.delete(session) }
}
