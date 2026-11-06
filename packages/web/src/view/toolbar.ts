import type { Html, HtmlBuilder } from 'foldkit/html';

import { keysFor, toolbar, type Platform } from '../editor/keymap';
import type { EditorCommand } from '../editor/types';
import { Message } from '../message';
import { keysView } from './keys';

/** Stroke paths on a 16 by 16 grid, drawn in the current text colour. */
const icons: Partial<Record<EditorCommand, ReadonlyArray<string>>> = {
	bold: ['M4.5 2.5h4a2.6 2.6 0 0 1 0 5.2h-4z', 'M4.5 7.7h4.8a2.9 2.9 0 0 1 0 5.8H4.5z'],
	italic: ['M10.5 2.5H6.5', 'M9.5 13.5H5.5', 'M8.9 2.5 7.1 13.5'],
	strike: [
		'M11 4.6C10.5 3.3 9.4 2.5 7.9 2.5 6.1 2.5 4.9 3.5 4.9 4.9c0 1.2.8 1.9 2.1 2.4',
		'M10.6 9.3c.4.5.6 1 .6 1.7 0 1.5-1.4 2.5-3.3 2.5-1.6 0-2.9-.8-3.4-2.1',
		'M2.5 8h11'
	],
	code: ['M5.5 4 2 8l3.5 4', 'M10.5 4 14 8l-3.5 4'],
	editLink: [
		'M6.6 9.4l2.8-2.8',
		'M7.3 4.6l.9-.9a2.6 2.6 0 0 1 3.7 3.7l-.9.9',
		'M8.7 11.4l-.9.9a2.6 2.6 0 0 1-3.7-3.7l.9-.9'
	],
	toggleTask: [
		'M3 2.5h10a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z',
		'M5.2 8.2l1.9 1.9 3.8-4.2'
	],
	toggleBullet: ['M6.5 4h7', 'M6.5 8h7', 'M6.5 12h7', 'M2.8 4h.01', 'M2.8 8h.01', 'M2.8 12h.01'],
	toggleHeading: ['M6.2 2.5 4.8 13.5', 'M11.2 2.5 9.8 13.5', 'M3 6h10.5', 'M2.5 10H13']
};

const ariaKeys = (platform: Platform, key: string): string =>
	key
		.split('-')
		.map((part) =>
			part === 'Cmd' ? 'Meta' : part === 'Ctrl' ? 'Control' : part.length === 1 ? part.toUpperCase() : part
		)
		.join('+');

/**
 * The formatting bar above the editor, like a chat composer's. Each button
 * runs its editor command, which writes Markdown in one undoable change and
 * puts the focus back in the editor.
 */
const wrapIcon = ['M2.5 4h11', 'M2.5 8h8.5a2 2 0 0 1 0 4H8', 'M9.5 10.5 8 12l1.5 1.5', 'M2.5 12h3'];

/** The wrap toggle at the right end of the bar. Pressed means long lines wrap; otherwise they scroll. */
const wrapToggleView = (wrap: boolean, h: HtmlBuilder<Message>): Html =>
	h.button(
		[
			h.Class('pt-toolbar-button pt-toolbar-toggle'),
			h.Type('button'),
			h.AriaLabel('Wrap lines'),
			h.AriaPressed(wrap ? 'true' : 'false'),
			h.OnClick(Message.ClickedWrapToggle())
		],
		[
			h.svg(
				[
					h.Class('pt-toolbar-icon'),
					h.ViewBox('0 0 16 16'),
					h.Width('16'),
					h.Height('16'),
					h.Fill('none'),
					h.Stroke('currentColor'),
					h.StrokeWidth('1.5'),
					h.StrokeLinecap('round'),
					h.StrokeLinejoin('round'),
					h.AriaHidden(true)
				],
				wrapIcon.map((path) => h.path([h.D(path)], []))
			),
			h.span(
				[h.Class('pt-tooltip pt-tooltip-end'), h.AriaHidden(true)],
				[h.span([h.Class('pt-tooltip-label')], [wrap ? 'Wrap lines: on' : 'Wrap lines: off, lines scroll'])]
			)
		]
	);

export const toolbarView = (platform: Platform, wrap: boolean, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class('pt-toolbar'), h.Role('toolbar'), h.AriaLabel('Formatting')],
		[
			...toolbar.flatMap((group, index) => [
				...(index > 0 ? [h.span([h.Class('pt-toolbar-divider'), h.AriaHidden(true)], [])] : []),
				...group.map(({ command, label }) => {
					const key = keysFor(platform, command)[0];
					return h.button(
						[
							h.Class('pt-toolbar-button'),
							h.Type('button'),
							h.AriaLabel(label),
							...(key ? [h.AriaKeyshortcuts(ariaKeys(platform, key))] : []),
							h.OnClick(Message.PressedEditorCommand({ command }))
						],
						[
							h.svg(
								[
									h.Class('pt-toolbar-icon'),
									h.ViewBox('0 0 16 16'),
									h.Width('16'),
									h.Height('16'),
									h.Fill('none'),
									h.Stroke('currentColor'),
									h.StrokeWidth(command === 'bold' ? '1.9' : '1.5'),
									h.StrokeLinecap('round'),
									h.StrokeLinejoin('round'),
									h.AriaHidden(true)
								],
								(icons[command] ?? []).map((path) => h.path([h.D(path)], []))
							),
							// The button's label and aria-keyshortcuts already name it, so the tooltip is for sight only.
							h.span(
								[h.Class('pt-tooltip'), h.AriaHidden(true)],
								[h.span([h.Class('pt-tooltip-label')], [label]), ...(key ? [keysView(platform, key, h)] : [])]
							)
						]
					);
				})
			]),
			h.span([h.Class('pt-toolbar-spacer')], []),
			wrapToggleView(wrap, h)
		]
	);
