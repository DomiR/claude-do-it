import { describe, expect as bunExpect, test } from 'bun:test'
import { Option } from 'effect'
import {
  Command, Mount, Subscription, all, click, expect, expectAll, find, given, keydown,
  scene, selector, tap, text, type as typeInto,
} from 'foldkit/scene'

import { FocusEditor, RunEditorAction, WaitBeforeReconnect } from './command'
import { Message } from './message'
import { makeInitialModel, type Model } from './model'
import { FocusPaletteInput, MountEditor } from './mount'
import { update } from './update'
import { view } from './view'

const path = '/tmp/DEMO.md'
const session = `${path}:0`
const sample = '# Tasks\n- [ ] Ship\n- [x] Review\n'
const ready = (): Model => update(makeInitialModel(path, 'mac'), Message.ReceivedWatchEvent({
  event: { _tag: 'Watching', version: 1, text: sample },
})).model

describe('PlainTasks shell', () => {
  test('has one childless keyed editor host, stats, location, and no textarea', () => {
    scene({ update, view }, given(ready()),
      Mount.expectExact(MountEditor({ session, text: sample, selection: { anchor: 0, head: 0 }, platform: 'mac' })),
      Mount.resolve(MountEditor, Message.SucceededMountEditor({ session })),
      expect(selector('.pt-file-name')).toHaveText('DEMO.md'),
      expect(selector('.pt-file-name')).toHaveAttr('title', path),
      expect(text('1/2 done')).toExist(), expect(text('Ln 1, Col 1')).toExist(), expect(text('Version 1')).toExist(),
      expect(text('Saved')).toExist(),
      expectAll(all.selector('.pt-editor-host')).toHaveCount(1),
      expectAll(all.selector('textarea')).toHaveCount(0),
      expect(selector('.pt-editor-host')).toBeEmpty(),
      expect(selector('.pt-activity')).toBeAbsent(),
      tap(({ html }) => bunExpect(Option.getOrThrow(find(html, '.pt-editor-host')).key).toBe(`editor:${session}`)),
    )
  })

  test('keeps the same host through Activity, palette, and connection changes', () => {
    let hostKey: unknown
    scene({ update, view }, given(ready()),
      Mount.resolve(MountEditor, Message.SucceededMountEditor({ session })),
      tap(({ html }) => { hostKey = Option.getOrThrow(find(html, '.pt-editor-host')).key }),
      click(text('Activity')), expect(selector('.pt-activity')).toExist(), Mount.expectNone(),
      click(text('Commands')), Mount.expectExact(FocusPaletteInput),
      Mount.resolve(FocusPaletteInput, Message.CompletedFocusPaletteInput()),
      expect(selector('.pt-palette')).toExist(),
      keydown(selector('.pt-palette-input'), 'Escape'),
      Mount.expectEnded(FocusPaletteInput),
      Command.resolve(FocusEditor, Message.CompletedFocusEditor()),
      Subscription.emit(Message.FailedWatch({ unauthorized: false })),
      Command.resolve(WaitBeforeReconnect, Message.CompletedWaitBeforeReconnect()),
      expect(text('Reconnecting')).toExist(), Mount.expectNone(),
      tap(({ html }) => {
        const host = Option.getOrThrow(find(html, '.pt-editor-host'))
        bunExpect(host.key).toBe(hostKey)
        bunExpect(host.children ?? []).toHaveLength(0)
      }),
    )
  })

  test('filters the palette and wires its Enter shortcut to a live action Command', () => {
    scene({ update, view }, given(ready()),
      Mount.resolve(MountEditor, Message.SucceededMountEditor({ session })),
      click(text('Commands')), Mount.resolve(FocusPaletteInput, Message.CompletedFocusPaletteInput()),
      typeInto(selector('.pt-palette-input'), 'tgdn'),
      expectAll(all.selector('.pt-palette-item')).toHaveCount(1),
      expect(selector('.pt-palette-title')).toHaveText('Toggle done'),
      expect(selector('.pt-palette-key')).toHaveText('⌘D'),
      keydown(selector('.pt-palette-input'), 'Enter'),
      Mount.expectEnded(FocusPaletteInput),
      Command.expectExact(RunEditorAction({ session, action: 'toggleDone' })),
      Command.resolve(RunEditorAction, Message.CompletedRunEditorAction()),
      expect(selector('.pt-palette')).toBeAbsent(), Mount.expectNone(),
    )
  })

  test('shows shortcuts and keeps the existing empty and terminal pages', () => {
    const open = update(ready(), Message.PressedEditorCommand({ command: 'showShortcuts' })).model
    scene({ update, view }, given(open),
      Mount.resolve(MountEditor, Message.SucceededMountEditor({ session })),
      Mount.resolve(FocusPaletteInput, Message.CompletedFocusPaletteInput()),
      expect(text('Browser shortcuts kept: reload, hard reload, tab search')).toExist(),
      expect(text('Continue task')).toExist(),
    )
    scene({ update, view }, given(makeInitialModel('')), expect(text('Open a todo')).toExist())
    scene({ update, view }, given(makeInitialModel(path)), expect(selector('.loading-shell')).toExist())
    const deleted = update(ready(), Message.ReceivedWatchEvent({ event: { _tag: 'Deleted' } })).model
    scene({ update, view }, given(deleted), expect(text('This file was deleted or moved')).toExist())
    const unauthorized = update(ready(), Message.FailedWatch({ unauthorized: true })).model
    scene({ update, view }, given(unauthorized), expect(text('Session expired: run do-it open again')).toExist())
  })
})
