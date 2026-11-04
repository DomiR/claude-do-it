export interface GlobalOptions { json: boolean; as: string }

export type ParsedCommand =
  | { kind: "open"; options: GlobalOptions; path: string; noBrowser: boolean; displayPath: string }
  | { kind: "read"; options: GlobalOptions; path: string; section?: string }
  | { kind: "sections"; options: GlobalOptions; path: string }
  | { kind: "edit"; options: GlobalOptions; path: string; version: number; section?: string; old: string; next: string }
  | { kind: "append"; options: GlobalOptions; path: string; version: number; section?: string; text: string }
  | { kind: "todo-add"; options: GlobalOptions; path: string; version: number; section?: string; text: string }
  | { kind: "todo-set"; options: GlobalOptions; path: string; version: number; section?: string; target: string; state: "done" | "open" | "cancelled" }
  | { kind: "todo-list"; options: GlobalOptions; path: string; section?: string }
  | { kind: "diff"; options: GlobalOptions; path: string; since: number; wait: number }
  | { kind: "watch"; options: GlobalOptions; path: string; displayPath: string; since?: number; section?: string; todos: boolean; settle?: number }
  | { kind: "status"; options: GlobalOptions }
  | { kind: "stop"; options: GlobalOptions }
