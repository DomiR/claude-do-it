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
  { command: 'editLink', mac: ['Cmd-k'], other: ['Ctrl-k'] },
  { command: 'bold', mac: ['Cmd-b'], other: ['Ctrl-b'] },
  // Cmd-I is New task, and Ctrl-Shift-I opens the developer tools on Windows and Linux.
  { command: 'italic', mac: ['Cmd-Shift-i'], other: ['Alt-Shift-i'] },
  { command: 'strike', mac: ['Cmd-Shift-x'], other: ['Ctrl-Shift-x'] },
  // Cmd-Shift-C opens the element inspector, so code takes E as in most editors.
  { command: 'code', mac: ['Cmd-e'], other: ['Ctrl-e'] },
  // Cmd-Shift-3, 4 and 5 are macOS screenshots, and Ctrl-Alt chords type characters on Windows.
  { command: 'toggleTask', mac: ['Cmd-Alt-4'], other: ['Ctrl-Shift-4'] },
  { command: 'toggleBullet', mac: ['Cmd-Alt-5'], other: ['Ctrl-Shift-5'] },
  { command: 'toggleHeading', mac: ['Cmd-Alt-2'], other: ['Ctrl-Shift-2'] },
  { command: 'toggleFold', mac: ['Cmd-Alt-f', 'F2'], other: ['Ctrl-Shift-f', 'F2'] },
  { command: 'gotoProject', mac: ['Cmd-p'], other: ['Ctrl-p'] },
  { command: 'commandPalette', mac: ['Cmd-Shift-p', 'F1'], other: ['Ctrl-Shift-p', 'F1'] },
  { command: 'find', mac: ['Cmd-f'], other: ['Ctrl-f'] },
  { command: 'indent', mac: ['Cmd-]'], other: ['Ctrl-]'] },
  { command: 'outdent', mac: ['Cmd-[', 'Shift-Tab'], other: ['Ctrl-[', 'Shift-Tab'] },
  { command: 'tab', mac: ['Tab'], other: ['Tab'] },
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
  { command: 'archive', title: 'Archive resolved tasks', description: 'Archive completed and cancelled tasks', inPalette: true },
  { command: 'moveUp', title: 'Move task up', description: 'Move the task up', inPalette: true },
  { command: 'moveDown', title: 'Move task down', description: 'Move the task down', inPalette: true },
  { command: 'openLink', title: 'Open link', description: 'Open the link under the caret', inPalette: true },
  { command: 'editLink', title: 'Edit link', description: 'Edit the link under the caret, or link the selected text', inPalette: true },
  { command: 'bold', title: 'Bold', description: 'Bold the selection or the word at the caret', inPalette: true },
  { command: 'italic', title: 'Italic', description: 'Italicize the selection or the word at the caret', inPalette: true },
  { command: 'strike', title: 'Strikethrough', description: 'Strike through the selection or the word at the caret', inPalette: true },
  { command: 'code', title: 'Inline code', description: 'Format the selection or the word at the caret as code', inPalette: true },
  { command: 'toggleTask', title: 'Task line', description: 'Turn the line into a task, or back into text', inPalette: true },
  { command: 'toggleBullet', title: 'Bulleted line', description: 'Turn the line into a bullet, or back into text', inPalette: true },
  { command: 'toggleHeading', title: 'Project heading', description: 'Turn the line into a project heading, or back into text', inPalette: true },
  { command: 'toggleFold', title: 'Toggle fold', description: 'Fold or unfold the project, task, or section at the caret', inPalette: true },
  { command: 'foldAll', title: 'Fold all', description: 'Fold every project, task, and section', inPalette: true },
  { command: 'unfoldAll', title: 'Unfold all', description: 'Unfold every project, task, and section', inPalette: true },
  { command: 'gotoProject', title: 'Go to project', description: 'Jump to a project', inPalette: true },
  { command: 'commandPalette', title: 'Command palette', description: 'Open the command palette', inPalette: false },
  { command: 'find', title: 'Find', description: 'Find text in the document', inPalette: true },
  { command: 'indent', title: 'Indent', description: 'Indent the selected task block', inPalette: true },
  { command: 'outdent', title: 'Outdent', description: 'Outdent the selected task block', inPalette: true },
  { command: 'tab', title: 'Tag or indent', description: 'Add a tag or indent the current task', inPalette: false },
  { command: 'continueTask', title: 'Continue task', description: 'Continue the current task', inPalette: false },
  { command: 'showShortcuts', title: 'Keyboard shortcuts', description: 'Show keyboard shortcuts', inPalette: true },
]

/** The formatting bar, left to right. Groups are separated by a divider. */
export const toolbar: ReadonlyArray<ReadonlyArray<{ readonly command: EditorCommand; readonly label: string }>> = [
  [
    { command: 'bold', label: 'Bold' },
    { command: 'italic', label: 'Italic' },
    { command: 'strike', label: 'Strikethrough' },
    { command: 'code', label: 'Inline code' },
    { command: 'editLink', label: 'Link' },
  ],
  [
    { command: 'toggleTask', label: 'Task' },
    { command: 'toggleBullet', label: 'Bulleted line' },
    { command: 'toggleHeading', label: 'Project heading' },
  ],
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

/** Apple's modifier order: Control, Option, Shift, Command. PC keyboards read the same way. */
const modifierOrder = ['Ctrl', 'Control', 'Alt', 'Option', 'Shift', 'Cmd', 'Command']

/** Keys drawn as icons rather than letters, so they render evenly in every font. */
export type KeyIcon = 'command' | 'shift' | 'option' | 'control' | 'enter' | 'backspace' | 'tab' | 'up' | 'down' | 'left' | 'right'

/** One keycap: an icon or a word, and the name a screen reader says for it. */
export interface KeyCap {
  readonly icon?: KeyIcon
  readonly text?: string
  readonly spoken: string
}

const macCaps: Record<string, KeyCap> = {
  Ctrl: { icon: 'control', spoken: 'Control' },
  Control: { icon: 'control', spoken: 'Control' },
  Alt: { icon: 'option', spoken: 'Option' },
  Option: { icon: 'option', spoken: 'Option' },
  Shift: { icon: 'shift', spoken: 'Shift' },
  Cmd: { icon: 'command', spoken: 'Command' },
  Command: { icon: 'command', spoken: 'Command' },
  Enter: { icon: 'enter', spoken: 'Return' },
  Backspace: { icon: 'backspace', spoken: 'Delete' },
  Tab: { icon: 'tab', spoken: 'Tab' },
  Escape: { text: 'esc', spoken: 'Escape' },
}

const otherCaps: Record<string, KeyCap> = {
  Ctrl: { text: 'Ctrl', spoken: 'Control' },
  Control: { text: 'Ctrl', spoken: 'Control' },
  Alt: { text: 'Alt', spoken: 'Alt' },
  Option: { text: 'Alt', spoken: 'Alt' },
  Shift: { text: 'Shift', spoken: 'Shift' },
  Cmd: { text: 'Cmd', spoken: 'Command' },
  Command: { text: 'Cmd', spoken: 'Command' },
  Enter: { text: 'Enter', spoken: 'Enter' },
  Backspace: { text: 'Backspace', spoken: 'Backspace' },
  Tab: { text: 'Tab', spoken: 'Tab' },
  Escape: { text: 'Esc', spoken: 'Escape' },
}

const sharedCaps: Record<string, KeyCap> = {
  ArrowUp: { icon: 'up', spoken: 'Up Arrow' },
  ArrowDown: { icon: 'down', spoken: 'Down Arrow' },
  ArrowLeft: { icon: 'left', spoken: 'Left Arrow' },
  ArrowRight: { icon: 'right', spoken: 'Right Arrow' },
  '/': { text: '/', spoken: 'Slash' },
  '?': { text: '?', spoken: 'Question Mark' },
  '[': { text: '[', spoken: 'Left Bracket' },
  ']': { text: ']', spoken: 'Right Bracket' },
}

/**
 * The keycaps for a CodeMirror key name such as `Cmd-Shift-p`, modifiers
 * first in the platform's order. Mac modifiers and special keys are icons;
 * elsewhere they are the words printed on PC keyboards.
 */
export const keyCaps = (platform: Platform, key: string): ReadonlyArray<KeyCap> => {
  const named = platform === 'mac' ? macCaps : otherCaps
  const parts = key.length > 1 && key.endsWith('-') ? [...key.slice(0, -2).split('-'), '-'] : key.split('-')
  const value = parts.pop() ?? ''
  const modifiers = parts
    .filter(part => modifierOrder.includes(part))
    .sort((left, right) => modifierOrder.indexOf(left) - modifierOrder.indexOf(right))
  const last = named[value] ?? sharedCaps[value] ?? { text: /^[a-z]$/i.test(value) ? value.toUpperCase() : value, spoken: value.toUpperCase() }
  return [...modifiers.map(part => named[part]!), last]
}

export const spokenKeys = (platform: Platform, key: string): string => keyCaps(platform, key).map(cap => cap.spoken).join(' ')

export const detectPlatform = (navigatorPlatform: string, userAgent: string): Platform => {
  const value = `${navigatorPlatform} ${userAgent}`.toLowerCase()
  return /mac|iphone|ipad/.test(value) ? 'mac' : 'other'
}
