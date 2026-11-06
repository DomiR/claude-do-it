import type { Document, Html, HtmlBuilder } from 'foldkit/html';

import { Message } from '../message';
import { DocumentState, Model } from '../model';
import { editorView, emptyView } from './editor';

const terminalView = (path: string, status: string, message: string, h: HtmlBuilder<Message>): Html =>
	h.main(
		[h.Class('message-shell')],
		[
			h.div([h.Class('eyebrow')], ['DO IT']),
			h.h1([h.Class('file-name')], [path.split('/').at(-1) ?? path]),
			h.div([h.Class('file-path')], [path]),
			h.span([h.Class(`connection-status connection-${status.toLowerCase()}`)], [status]),
			h.h2([h.Class('message-title')], [message])
		]
	);

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
	title: 'do it',
	body: DocumentState.match(model.document, {
		NoPath: () => emptyView(h),
		Connecting: ({ path }) =>
			h.main(
				[h.Class('loading-shell')],
				[
					h.div([h.Class('eyebrow')], ['DO IT']),
					h.h1([h.Class('loading-title')], [path.split('/').at(-1) ?? path]),
					h.p([h.Class('loading-copy')], ['Connecting to the live document…'])
				]
			),
		Ready: ({ document }) => editorView(model, document, h),
		Deleted: ({ path }) => terminalView(path, 'Deleted', 'This file was deleted or moved', h),
		Unauthorized: ({ path }) => terminalView(path, 'Reconnecting', 'Session expired: run do-it open again', h)
	})
});
