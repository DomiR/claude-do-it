import { describe, expect, test } from 'bun:test'

import type { EditorCommand } from './types'
import { bindings, commands, detectPlatform, hints, keyCaps, keysFor, spokenKeys, toolbar } from './keymap'

const allCommands: ReadonlyArray<EditorCommand> = [
  'newTask',
  'toggleDone',
  'toggleCancelled',
  'archive',
  'moveUp',
  'moveDown',
  'continueTask',
  'indent',
  'outdent',
  'tab',
  'bold',
  'italic',
  'strike',
  'code',
  'toggleTask',
  'toggleBullet',
  'toggleHeading',
  'openLink',
  'editLink',
  'gotoProject',
  'commandPalette',
  'find',
  'showShortcuts',
]

describe('editor keymap', () => {
  test('matches the frozen binding table', () => {
    expect(bindings).toEqual([
      { command: 'newTask', mac: ['Cmd-Enter', 'Cmd-i'], other: ['Ctrl-Enter', 'Ctrl-i'] },
      { command: 'toggleDone', mac: ['Cmd-d', 'Cmd-Shift-Enter'], other: ['Ctrl-d', 'Ctrl-Shift-Enter'] },
      { command: 'toggleCancelled', mac: ['Ctrl-c', 'Cmd-Alt-Enter'], other: ['Alt-c', 'Ctrl-Alt-Enter'] },
      { command: 'archive', mac: ['Cmd-Shift-a', 'Cmd-Alt-a'], other: ['Ctrl-Shift-a', 'Ctrl-Alt-a'] },
      { command: 'moveUp', mac: ['Cmd-Ctrl-ArrowUp', 'Alt-ArrowUp'], other: ['Ctrl-Shift-ArrowUp', 'Alt-ArrowUp'] },
      { command: 'moveDown', mac: ['Cmd-Ctrl-ArrowDown', 'Alt-ArrowDown'], other: ['Ctrl-Shift-ArrowDown', 'Alt-ArrowDown'] },
      { command: 'openLink', mac: ['Cmd-Shift-u', 'Alt-Enter'], other: ['Alt-Enter'] },
      { command: 'editLink', mac: ['Cmd-k'], other: ['Ctrl-k'] },
      { command: 'bold', mac: ['Cmd-b'], other: ['Ctrl-b'] },
      { command: 'italic', mac: ['Cmd-Shift-i'], other: ['Alt-Shift-i'] },
      { command: 'strike', mac: ['Cmd-Shift-x'], other: ['Ctrl-Shift-x'] },
      { command: 'code', mac: ['Cmd-e'], other: ['Ctrl-e'] },
      { command: 'toggleTask', mac: ['Cmd-Alt-4'], other: ['Ctrl-Shift-4'] },
      { command: 'toggleBullet', mac: ['Cmd-Alt-5'], other: ['Ctrl-Shift-5'] },
      { command: 'toggleHeading', mac: ['Cmd-Alt-2'], other: ['Ctrl-Shift-2'] },
      { command: 'gotoProject', mac: ['Cmd-p'], other: ['Ctrl-p'] },
      { command: 'commandPalette', mac: ['Cmd-Shift-p', 'F1'], other: ['Ctrl-Shift-p', 'F1'] },
      { command: 'find', mac: ['Cmd-f'], other: ['Ctrl-f'] },
      { command: 'indent', mac: ['Cmd-]'], other: ['Ctrl-]'] },
      { command: 'outdent', mac: ['Cmd-[', 'Shift-Tab'], other: ['Ctrl-[', 'Shift-Tab'] },
      { command: 'tab', mac: ['Tab'], other: ['Tab'] },
      { command: 'continueTask', mac: ['Enter'], other: ['Enter'] },
      { command: 'showShortcuts', mac: ['Cmd-/'], other: ['Ctrl-/'] },
    ])
    expect(keysFor('mac', 'newTask')).toEqual(['Cmd-Enter', 'Cmd-i'])
    expect(keysFor('other', 'showShortcuts')).toEqual(['Ctrl-/'])
  })

  test('has unique chords and no forbidden bindings', () => {
    const macKeys = bindings.flatMap((binding) => binding.mac)
    const otherKeys = bindings.flatMap((binding) => binding.other)
    for (const platform of ['mac', 'other'] as const) {
      const keys = bindings.flatMap((binding) => binding[platform])
      expect(new Set(keys).size).toBe(keys.length)
    }
    const neverAnywhere = [
      'Mod-r',
      'Mod-Shift-r',
      'Mod-Shift-o',
      'Cmd-r',
      'Ctrl-r',
      'Cmd-Shift-r',
      'Ctrl-Shift-r',
      'Cmd-Shift-o',
      'Ctrl-Shift-o',
    ]
    for (const key of neverAnywhere) {
      expect(macKeys).not.toContain(key)
      expect(otherKeys).not.toContain(key)
    }
    for (const key of ['Ctrl-c', 'Ctrl-Shift-u']) expect(otherKeys).not.toContain(key)
    // Developer tools, the element inspector and macOS screenshots take these before the page can.
    for (const key of ['Cmd-Alt-i', 'Cmd-Shift-c', 'Cmd-Shift-3', 'Cmd-Shift-4', 'Cmd-Shift-5']) expect(macKeys).not.toContain(key)
    for (const key of ['Ctrl-Shift-i', 'Ctrl-Shift-c', 'Ctrl-Shift-j']) expect(otherKeys).not.toContain(key)
    for (const group of toolbar) {
      for (const { command } of group) {
        expect(keysFor('mac', command).length).toBeGreaterThan(0)
        expect(keysFor('other', command).length).toBeGreaterThan(0)
      }
    }
  })

  test('provides palette metadata for every editor command', () => {
    expect(commands.map((command) => command.title)).toEqual([
      'New task',
      'Toggle done',
      'Toggle cancelled',
      'Archive resolved tasks',
      'Move task up',
      'Move task down',
      'Open link',
      'Edit link',
      'Bold',
      'Italic',
      'Strikethrough',
      'Inline code',
      'Task line',
      'Bulleted line',
      'Project heading',
      'Go to project',
      'Command palette',
      'Find',
      'Indent',
      'Outdent',
      'Tag or indent',
      'Continue task',
      'Keyboard shortcuts',
    ])
    expect(new Set(commands.map((command) => command.command))).toEqual(new Set(allCommands))
    expect(commands.find((command) => command.command === 'commandPalette')?.inPalette).toBe(false)
    expect(commands.find((command) => command.command === 'continueTask')?.inPalette).toBe(false)
    expect(commands.find((command) => command.command === 'tab')?.inPalette).toBe(false)
    for (const command of commands) expect(command.description).not.toContain(' - ')
  })

  test('provides the discoverable status hints in their display order', () => {
    expect(hints).toEqual([
      { command: 'newTask', label: 'New task' },
      { command: 'toggleDone', label: 'Done' },
      { command: 'toggleCancelled', label: 'Cancel' },
      { command: 'archive', label: 'Archive' },
      { command: 'moveUp', label: 'Move' },
      { command: 'commandPalette', label: 'Commands' },
      { command: 'showShortcuts', label: 'Help' },
    ])
    expect(hints.every(hint => keysFor('mac', hint.command).length > 0)).toBe(true)
  })

  test('turns key names into one cap per key, icons on Macs and words elsewhere, in platform order', () => {
    expect(keyCaps('mac', 'Cmd-Shift-p')).toEqual([
      { icon: 'shift', spoken: 'Shift' }, { icon: 'command', spoken: 'Command' }, { text: 'P', spoken: 'P' },
    ])
    expect(keyCaps('mac', 'Cmd-Ctrl-ArrowUp').map(cap => cap.icon)).toEqual(['control', 'command', 'up'])
    expect(keyCaps('mac', 'Cmd-Alt-Enter').map(cap => cap.icon)).toEqual(['option', 'command', 'enter'])
    expect(keyCaps('mac', 'Shift-Tab').map(cap => cap.icon)).toEqual(['shift', 'tab'])
    expect(keyCaps('mac', 'Escape')).toEqual([{ text: 'esc', spoken: 'Escape' }])
    expect(keyCaps('other', 'Ctrl-Shift-p').map(cap => cap.text)).toEqual(['Ctrl', 'Shift', 'P'])
    expect(keyCaps('other', 'Alt-ArrowDown')).toEqual([{ text: 'Alt', spoken: 'Alt' }, { icon: 'down', spoken: 'Down Arrow' }])
    expect(keyCaps('other', 'Enter')).toEqual([{ text: 'Enter', spoken: 'Enter' }])
    expect(spokenKeys('mac', 'Cmd-Shift-p')).toBe('Shift Command P')
    expect(spokenKeys('mac', 'Cmd-/')).toBe('Command Slash')
    expect(spokenKeys('other', 'Ctrl-[')).toBe('Control Left Bracket')
    for (const platform of ['mac', 'other'] as const) {
      for (const binding of bindings) {
        for (const key of binding[platform]) {
          for (const cap of keyCaps(platform, key)) expect(Boolean(cap.icon || cap.text) && cap.spoken.length > 0).toBe(true)
        }
      }
    }
  })

  test('detects Apple platforms', () => {
    expect(detectPlatform('MacIntel', 'Mozilla/5.0')).toBe('mac')
    expect(detectPlatform('Win32', 'iPhone')).toBe('mac')
    expect(detectPlatform('Linux x86_64', 'Mozilla/5.0')).toBe('other')
  })
})
