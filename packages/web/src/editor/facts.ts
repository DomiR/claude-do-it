import { Annotation, Facet, StateEffect } from '@codemirror/state';

import { Message } from '../message';

/** Marks a transaction that applies another writer's changes. */
export const remoteTransaction = Annotation.define<number>();
export const clearRemoteHighlight = StateEffect.define<null>();

export type EditorFact = typeof Message.PressedEditorCommand.Type | typeof Message.ShowedEditorNotice.Type;

/** Where the editor reports what the shell should handle, such as opening a link. */
export const editorFacts = Facet.define<(fact: EditorFact) => void, (fact: EditorFact) => void>({
	combine: (listeners) => (fact) => {
		for (const listener of listeners) listener(fact);
	}
});
