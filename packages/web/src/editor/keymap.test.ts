import { describe, expect, test } from 'bun:test'

import type { EditorCommand } from './types'
import { bindings, commands, detectPlatform, keyLabel, keysFor } from './keymap'

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
  'openLink',
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
      { command: 'gotoProject', mac: ['Cmd-p'], other: ['Ctrl-p'] },
      { command: 'commandPalette', mac: ['Cmd-Shift-p', 'F1'], other: ['Ctrl-Shift-p', 'F1'] },
      { command: 'find', mac: ['Cmd-f'], other: ['Ctrl-f'] },
      { command: 'indent', mac: ['Cmd-]'], other: ['Ctrl-]'] },
      { command: 'outdent', mac: ['Cmd-['], other: ['Ctrl-['] },
      { command: 'continueTask', mac: ['Enter'], other: ['Enter'] },
      { command: 'showShortcuts', mac: [], other: [] },
    ])
    expect(keysFor('mac', 'newTask')).toEqual(['Cmd-Enter', 'Cmd-i'])
    expect(keysFor('other', 'showShortcuts')).toEqual([])
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
      'Tab',
      'Shift-Tab',
    ]
    for (const key of neverAnywhere) {
      expect(macKeys).not.toContain(key)
      expect(otherKeys).not.toContain(key)
    }
    for (const key of ['Ctrl-c', 'Ctrl-Shift-u']) expect(otherKeys).not.toContain(key)
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
      'Go to project',
      'Command palette',
      'Find',
      'Indent',
      'Outdent',
      'Continue task',
      'Keyboard shortcuts',
    ])
    expect(new Set(commands.map((command) => command.command))).toEqual(new Set(allCommands))
    expect(commands.find((command) => command.command === 'commandPalette')?.inPalette).toBe(false)
    expect(commands.find((command) => command.command === 'continueTask')?.inPalette).toBe(false)
    for (const command of commands) expect(command.description).not.toContain(' - ')
  })

  test('formats key labels for both platforms and detects Apple platforms', () => {
    expect(keyLabel('mac', 'Cmd-Shift-a')).toBe('⇧⌘A')
    expect(keyLabel('mac', 'Cmd-Ctrl-ArrowUp')).toBe('⌃⌘↑')
    expect(keyLabel('mac', 'Enter')).toBe('↩')
    expect(keyLabel('other', 'Ctrl-Shift-a')).toBe('Ctrl+Shift+A')
    expect(keyLabel('other', 'Alt-ArrowDown')).toBe('Alt+Down')
    expect(keyLabel('other', 'Enter')).toBe('Enter')
    expect(detectPlatform('MacIntel', 'Mozilla/5.0')).toBe('mac')
    expect(detectPlatform('Win32', 'iPhone')).toBe('mac')
    expect(detectPlatform('Linux x86_64', 'Mozilla/5.0')).toBe('other')
  })
})
