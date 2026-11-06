import { Option } from 'effect';
import type { Html, HtmlBuilder } from 'foldkit/html';

import { commands, keysFor } from '../editor/keymap';
import { classifyDocument } from '../editor/lines';
import type { EditorCommand } from '../editor/types';
import { Message } from '../message';
import type { Model, Theme } from '../model';
import { FocusPaletteInput } from '../mount';
import { keysView } from './keys';

type PaletteItem =
	| {
			readonly kind: 'Command';
			readonly title: string;
			readonly detail: string;
			readonly keys: ReadonlyArray<string>;
			readonly command: EditorCommand;
	  }
	| {
			readonly kind: 'Project';
			readonly title: string;
			readonly detail: string;
			readonly keys: ReadonlyArray<string>;
			readonly offset: number;
	  }
	| {
			readonly kind: 'Theme';
			readonly title: string;
			readonly detail: string;
			readonly keys: ReadonlyArray<string>;
			readonly theme: Theme;
	  };

const themeChoices: ReadonlyArray<{ readonly theme: Theme; readonly detail: string }> = [
	{ theme: 'System', detail: 'Follow the system light or dark setting' },
	{ theme: 'Light', detail: 'Always use the light theme' },
	{ theme: 'Dark', detail: 'Always use the dark theme' }
];

export const matchesSubsequence = (text: string, query: string): boolean => {
	const candidate = text.toLowerCase();
	let offset = 0;
	for (const character of query.toLowerCase()) {
		const found = candidate.indexOf(character, offset);
		if (found === -1) return false;
		offset = found + character.length;
	}
	return true;
};

export const paletteItems = (model: Model, draft: string): ReadonlyArray<PaletteItem> => {
	const palette = model.palette;
	if (palette._tag !== 'Open') return [];
	const items: ReadonlyArray<PaletteItem> =
		palette.kind === 'Projects'
			? classifyDocument(draft).projects.map((project) => ({
					kind: 'Project',
					title: project.title,
					detail: `Heading ${project.level}, line ${project.line + 1}`,
					keys: [],
					offset: project.from
				}))
			: commands
					.filter((command) => palette.kind === 'Shortcuts' || command.inPalette)
					.map((command) => ({
						kind: 'Command',
						title: command.title,
						detail: command.description,
						command: command.command,
						keys: keysFor(model.platform, command.command)
					}));
	const themes: ReadonlyArray<PaletteItem> =
		palette.kind === 'Commands'
			? themeChoices.map(({ theme, detail }) => ({
					kind: 'Theme',
					title: `Theme: ${theme}`,
					detail: theme === model.theme ? `Current, ${detail.toLowerCase()}` : detail,
					keys: [],
					theme
				}))
			: [];
	return [...items, ...themes].filter((item) => matchesSubsequence(item.title, palette.query));
};

export const paletteView = (model: Model, draft: string, h: HtmlBuilder<Message>): Html => {
	const palette = model.palette;
	if (palette._tag === 'Closed') return h.div([]);
	const items = paletteItems(model, draft);
	const active = items.length ? Math.min(palette.active, items.length - 1) : 0;
	return h.keyed('div')(
		'palette',
		[h.Class('pt-palette-backdrop')],
		[
			h.div(
				[h.Class('pt-palette'), h.Role('dialog'), h.AriaModal(true), h.AriaLabel(palette.kind)],
				[
					h.keyed('input')(palette.kind, [
						h.Class('pt-palette-input'),
						h.Type('text'),
						h.Value(palette.query),
						h.Placeholder(
							palette.kind === 'Projects'
								? 'Go to project'
								: palette.kind === 'Shortcuts'
									? 'Keyboard shortcuts'
									: 'Search commands'
						),
						h.AriaLabel(`Filter ${palette.kind.toLowerCase()}`),
						h.Role('combobox'),
						h.AriaExpanded(true),
						h.AriaControls('pt-palette-list'),
						...(items.length ? [h.Attribute('aria-activedescendant', `pt-palette-item-${active}`)] : []),
						h.OnInput((query) => Message.UpdatedPaletteQuery({ query })),
						h.OnKeyDownPreventDefault((key) =>
							key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === 'Escape'
								? Option.some(Message.PressedPaletteKey({ key }))
								: Option.none()
						),
						h.OnMount(FocusPaletteInput())
					]),
					h.ul(
						[h.Class('pt-palette-list'), h.Id('pt-palette-list'), h.Role('listbox'), h.AriaLabel(palette.kind)],
						items.length
							? items.map((item, index) =>
									h.li(
										[h.Role('presentation')],
										[
											h.button(
												[
													h.Class(`pt-palette-item${index === active ? ' pt-palette-item-active' : ''}`),
													h.Type('button'),
													h.Role('option'),
													h.AriaSelected(index === active),
													h.Id(`pt-palette-item-${index}`),
													h.Attribute('tabindex', '-1'),
													h.OnClick(Message.ClickedPaletteItem({ index }))
												],
												[
													h.span(
														[],
														[
															h.span([h.Class('pt-palette-title')], [item.title]),
															h.span([h.Class('pt-palette-detail')], [item.detail])
														]
													),
													// Alternatives get an "or" between them, so two shortcuts never read as one longer chord.
													h.span(
														[h.Class('pt-palette-keys')],
														(palette.kind === 'Shortcuts' ? item.keys : item.keys.slice(0, 1)).flatMap((key, index) => [
															...(index > 0 ? [h.span([h.Class('pt-palette-or')], ['or'])] : []),
															keysView(model.platform, key, h)
														])
													)
												]
											)
										]
									)
								)
							: [h.li([h.Class('pt-palette-empty')], ['No matches'])]
					),
					...(palette.kind === 'Shortcuts'
						? [
								h.p(
									[h.Class('pt-palette-detail pt-palette-note')],
									[
										'Type ',
										keysView(model.platform, '?', h),
										' outside the editor, or ',
										keysView(model.platform, model.platform === 'mac' ? 'Cmd-/' : 'Ctrl-/', h),
										' inside it'
									]
								),
								h.p(
									[h.Class('pt-palette-detail pt-palette-note')],
									[
										keysView(model.platform, 'Escape', h),
										' then ',
										keysView(model.platform, 'Tab', h),
										' leaves the editor'
									]
								),
								h.p(
									[h.Class('pt-palette-detail pt-palette-note')],
									[
										keysView(model.platform, 'Tab', h),
										' indents or adds a tag, ',
										keysView(model.platform, 'Shift-Tab', h),
										' outdents'
									]
								),
								h.p(
									[h.Class('pt-palette-detail pt-palette-note')],
									[
										'Toggle Tab focus mode: ',
										keysView(model.platform, model.platform === 'mac' ? 'Alt-Shift-m' : 'Ctrl-m', h)
									]
								),
								h.p(
									[h.Class('pt-palette-detail pt-palette-note')],
									['Browser shortcuts kept: reload, hard reload, tab search']
								)
							]
						: [])
				]
			)
		]
	);
};
