import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { commands, keyLabel, keysFor } from '../editor/keymap'
import { classifyDocument } from '../editor/lines'
import type { EditorCommand } from '../editor/types'
import { Message } from '../message'
import type { Model } from '../model'
import { FocusPaletteInput } from '../mount'

type PaletteItem =
  | { readonly kind: 'Command'; readonly title: string; readonly detail: string; readonly keys: ReadonlyArray<string>; readonly command: EditorCommand }
  | { readonly kind: 'Project'; readonly title: string; readonly detail: string; readonly keys: ReadonlyArray<string>; readonly offset: number }

export const matchesSubsequence = (text: string, query: string): boolean => {
  const candidate = text.toLowerCase()
  let offset = 0
  for (const character of query.toLowerCase()) {
    const found = candidate.indexOf(character, offset)
    if (found === -1) return false
    offset = found + character.length
  }
  return true
}

export const paletteItems = (model: Model, draft: string): ReadonlyArray<PaletteItem> => {
  const palette = model.palette
  if (palette._tag !== 'Open') return []
  const items: ReadonlyArray<PaletteItem> = palette.kind === 'Projects'
    ? classifyDocument(draft).projects.map(project => ({
        kind: 'Project', title: project.title, detail: `Heading ${project.level}, line ${project.line + 1}`,
        keys: [], offset: project.from,
      }))
    : commands.filter(command => palette.kind === 'Shortcuts' || command.inPalette).map(command => ({
        kind: 'Command', title: command.title, detail: command.description, command: command.command,
        keys: keysFor(model.platform, command.command).map(key => keyLabel(model.platform, key)),
      }))
  return items.filter(item => matchesSubsequence(item.title, palette.query))
}

export const paletteView = (model: Model, draft: string, h: HtmlBuilder<Message>): Html => {
  const palette = model.palette
  if (palette._tag === 'Closed') return h.div([])
  const items = paletteItems(model, draft)
  const active = items.length ? Math.min(palette.active, items.length - 1) : 0
  return h.keyed('div')('palette', [h.Class('pt-palette-backdrop')], [
    h.div([h.Class('pt-palette'), h.Role('dialog'), h.AriaModal(true), h.AriaLabel(palette.kind)], [
      h.keyed('input')(palette.kind, [
        h.Class('pt-palette-input'), h.Type('text'), h.Value(palette.query),
        h.Placeholder(palette.kind === 'Projects' ? 'Go to project' : palette.kind === 'Shortcuts' ? 'Keyboard shortcuts' : 'Search commands'),
        h.AriaLabel(`Filter ${palette.kind.toLowerCase()}`), h.Role('combobox'), h.AriaExpanded(true),
        h.AriaControls('pt-palette-list'),
        ...(items.length ? [h.Attribute('aria-activedescendant', `pt-palette-item-${active}`)] : []),
        h.OnInput(query => Message.UpdatedPaletteQuery({ query })),
        h.OnKeyDownPreventDefault(key => key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === 'Escape'
          ? Option.some(Message.PressedPaletteKey({ key })) : Option.none()),
        h.OnMount(FocusPaletteInput()),
      ]),
      h.ul([h.Class('pt-palette-list'), h.Id('pt-palette-list'), h.Role('listbox'), h.AriaLabel(palette.kind)],
        items.length ? items.map((item, index) => h.li([h.Role('presentation')], [
          h.button([
            h.Class(`pt-palette-item${index === active ? ' pt-palette-item-active' : ''}`),
            h.Type('button'), h.Role('option'), h.AriaSelected(index === active),
            h.Id(`pt-palette-item-${index}`), h.Attribute('tabindex', '-1'),
            h.OnClick(Message.ClickedPaletteItem({ index })),
          ], [
            h.span([], [h.span([h.Class('pt-palette-title')], [item.title]), h.span([h.Class('pt-palette-detail')], [item.detail])]),
            h.span([h.Class('pt-palette-keys')], (palette.kind === 'Shortcuts' ? item.keys : item.keys.slice(0, 1))
              .map(key => h.kbd([h.Class('pt-palette-key')], [key]))),
          ]),
        ])) : [h.li([h.Class('pt-palette-empty')], ['No matches'])]),
      ...(palette.kind === 'Shortcuts'
        ? [h.p([h.Class('pt-palette-detail')], ['Browser shortcuts kept: reload, hard reload, tab search'])] : []),
    ]),
  ])
}
