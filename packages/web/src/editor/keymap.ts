import type { EditorCommand } from './types'

export type Platform = 'mac' | 'other'

export interface Binding {
  readonly command: EditorCommand
  readonly mac: ReadonlyArray<string>
  readonly other: ReadonlyArray<string>
}

export const bindings: ReadonlyArray<Binding> = [
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
  { command: 'showShortcuts', mac: ['Cmd-/'], other: ['Ctrl-/'] },
]

export interface CommandInfo {
  readonly command: EditorCommand
  readonly title: string
  readonly description: string
  readonly inPalette: boolean
}

export const commands: ReadonlyArray<CommandInfo> = [
  { command: 'newTask', title: 'New task', description: 'Create a new task', inPalette: true },
  { command: 'toggleDone', title: 'Toggle done', description: 'Mark the task done or open', inPalette: true },
  { command: 'toggleCancelled', title: 'Toggle cancelled', description: 'Cancel or reopen the task', inPalette: true },
  { command: 'archive', title: 'Archive resolved tasks', description: 'Move resolved tasks to Archive', inPalette: true },
  { command: 'moveUp', title: 'Move task up', description: 'Move the task up', inPalette: true },
  { command: 'moveDown', title: 'Move task down', description: 'Move the task down', inPalette: true },
  { command: 'openLink', title: 'Open link', description: 'Open the link under the caret', inPalette: true },
  { command: 'gotoProject', title: 'Go to project', description: 'Jump to a project', inPalette: true },
  { command: 'commandPalette', title: 'Command palette', description: 'Open the command palette', inPalette: false },
  { command: 'find', title: 'Find', description: 'Find text in the document', inPalette: true },
  { command: 'indent', title: 'Indent', description: 'Indent the selected task block', inPalette: true },
  { command: 'outdent', title: 'Outdent', description: 'Outdent the selected task block', inPalette: true },
  { command: 'continueTask', title: 'Continue task', description: 'Continue the current task', inPalette: false },
  { command: 'showShortcuts', title: 'Keyboard shortcuts', description: 'Show keyboard shortcuts', inPalette: true },
]

export const hints: ReadonlyArray<{ readonly command: EditorCommand; readonly label: string }> = [
  { command: 'newTask', label: 'New task' },
  { command: 'toggleDone', label: 'Done' },
  { command: 'toggleCancelled', label: 'Cancel' },
  { command: 'archive', label: 'Archive' },
  { command: 'moveUp', label: 'Move' },
  { command: 'commandPalette', label: 'Commands' },
  { command: 'showShortcuts', label: 'Help' },
]

export const keysFor = (platform: Platform, command: EditorCommand): ReadonlyArray<string> => {
  const binding = bindings.find((entry) => entry.command === command)
  return binding?.[platform] ?? []
}

const macModifierLabels: Record<string, string> = {
  Ctrl: '⌃',
  Control: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Cmd: '⌘',
  Command: '⌘',
}

const otherModifierLabels: Record<string, string> = {
  Ctrl: 'Ctrl',
  Control: 'Ctrl',
  Alt: 'Alt',
  Option: 'Alt',
  Shift: 'Shift',
  Cmd: 'Cmd',
  Command: 'Cmd',
}

const modifierOrder = ['Ctrl', 'Control', 'Alt', 'Option', 'Shift', 'Cmd', 'Command']

const keyName = (platform: Platform, value: string): string => {
  if (platform === 'mac') {
    if (value === 'ArrowUp') return '↑'
    if (value === 'ArrowDown') return '↓'
    if (value === 'ArrowLeft') return '←'
    if (value === 'ArrowRight') return '→'
    if (value === 'Enter') return '↩'
  } else {
    if (value === 'ArrowUp') return 'Up'
    if (value === 'ArrowDown') return 'Down'
    if (value === 'ArrowLeft') return 'Left'
    if (value === 'ArrowRight') return 'Right'
    if (value === 'Enter') return 'Enter'
  }
  return /^[a-z]$/i.test(value) ? value.toUpperCase() : value
}

export const keyLabel = (platform: Platform, key: string): string => {
  const parts = key.split('-')
  const value = parts.pop() ?? ''
  const modifiers = parts
    .filter((part) => platform === 'mac' ? macModifierLabels[part] !== undefined : otherModifierLabels[part] !== undefined)
    .sort((left, right) => modifierOrder.indexOf(left) - modifierOrder.indexOf(right))
  if (platform === 'mac') return `${modifiers.map((part) => macModifierLabels[part]).join('')}${keyName(platform, value)}`
  return [...modifiers.map((part) => otherModifierLabels[part]), keyName(platform, value)].join('+')
}

export const detectPlatform = (navigatorPlatform: string, userAgent: string): Platform => {
  const value = `${navigatorPlatform} ${userAgent}`.toLowerCase()
  return /mac|iphone|ipad/.test(value) ? 'mac' : 'other'
}
