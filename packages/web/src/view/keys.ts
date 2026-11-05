import type { Html, HtmlBuilder } from 'foldkit/html'

import { keyCaps, spokenKeys, type KeyIcon, type Platform } from '../editor/keymap'
import type { Message } from '../message'

/** Stroke paths on a 16 by 16 grid for keys whose font glyphs render unevenly. */
const keyIcons: Record<KeyIcon, ReadonlyArray<string>> = {
  command: [
    'M6 6h4v4H6z',
    'M6 6V4.5A1.5 1.5 0 1 0 4.5 6H6',
    'M10 6V4.5A1.5 1.5 0 1 1 11.5 6H10',
    'M10 10v1.5a1.5 1.5 0 1 0 1.5-1.5H10',
    'M6 10v1.5A1.5 1.5 0 1 1 4.5 10H6',
  ],
  shift: ['M8 2.5 2.5 8.5h3v5h5v-5h3z'],
  option: ['M2 4.5h3.5l5 7H14', 'M9.5 4.5H14'],
  control: ['M4 9.5 8 5.5l4 4'],
  enter: ['M13 3.5v4A2.5 2.5 0 0 1 10.5 10h-7', 'M6.5 7l-3 3 3 3'],
  backspace: ['M5.5 3.5H13A1.5 1.5 0 0 1 14.5 5v6a1.5 1.5 0 0 1-1.5 1.5H5.5L1.5 8z', 'M8 6l3 4', 'M11 6l-3 4'],
  tab: ['M2 8h9.5', 'M8.5 4.5 12 8l-3.5 3.5', 'M14 3.5v9'],
  up: ['M8 13V3', 'M4 7l4-4 4 4'],
  down: ['M8 3v10', 'M4 9l4 4 4-4'],
  left: ['M13 8H3', 'M7 4 3 8l4 4'],
  right: ['M3 8h10', 'M9 4l4 4-4 4'],
}

const iconView = (icon: KeyIcon, h: HtmlBuilder<Message>): Html => h.svg([
  h.Class('pt-key-svg'), h.ViewBox('0 0 16 16'), h.Width('12'), h.Height('12'), h.Fill('none'),
  h.Stroke('currentColor'), h.StrokeWidth('1.6'), h.StrokeLinecap('round'), h.StrokeLinejoin('round'), h.AriaHidden(true),
], keyIcons[icon].map(path => h.path([h.D(path)], [])))

/**
 * A shortcut as one small keycap per key, used everywhere the editor shows
 * one. The caps are hidden from assistive technology, which reads the
 * spoken form instead, such as "Shift Command P".
 */
export const keysView = (platform: Platform, key: string, h: HtmlBuilder<Message>): Html =>
  h.kbd([h.Class('pt-keys')], [
    h.span([h.Class('pt-visually-hidden')], [spokenKeys(platform, key)]),
    ...keyCaps(platform, key).map(cap => h.kbd(
      [h.Class(cap.icon ? 'pt-key pt-key-icon' : 'pt-key'), h.AriaHidden(true)],
      [cap.icon ? iconView(cap.icon, h) : cap.text ?? ''],
    )),
  ])
