import { StateField } from '@codemirror/state'

import { classifyDocument, type ClassifiedDocument } from './lines'

/** The shared classification for editor fields, refreshed only when text changes. */
export const classifiedDocument = StateField.define<ClassifiedDocument>({
  create: state => classifyDocument(state.doc.toString()),
  update: (value, transaction) => transaction.docChanged ? classifyDocument(transaction.newDoc.toString()) : value,
})
