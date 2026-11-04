import { LoroDoc, type Frontiers, type LoroText, type PeerID } from "loro-crdt"
import { edits, unified } from "./diff"
import { applyEdits, checkedEdits, checkText, type Edit } from "./edit"
import { DocError } from "./errors"
import { lines } from "./markdown"
import { findSection, sections, sectionText } from "./section"
import { todoChanges, type TodoChange } from "./todo-changes"
import { checkVersion, History, originKey, type Origin, type Version } from "./version"

const TEXT = "markdown"
const MAX_WRITING = 8
const ticketBrand: unique symbol = Symbol("WriteTicket")

export interface WriteTicket {
  readonly text: string
  readonly version: Version
  readonly [ticketBrand]: true
}

interface Snapshot {
  text: string
  version: Version
  frontiers: Frontiers
}

export interface Applied {
  readonly version: Version
  readonly changed: boolean
  readonly others: { readonly since: Version; readonly diff: string | null } | null
}

export interface Changes {
  readonly from: Version
  readonly to: Version
  readonly by: ReadonlyArray<Origin>
  readonly diff: string | null
  readonly todos: ReadonlyArray<TodoChange>
}

function sameFrontiers(a: Frontiers, b: Frontiers): boolean {
  return a.length === b.length && a.every(id => b.some(other => other.peer === id.peer && other.counter === id.counter))
}

/** Descending splices keep every range in the original text's coordinates. */
function splice(body: LoroText, changes: ReadonlyArray<Edit>): void {
  for (let i = changes.length - 1; i >= 0; i--) {
    const edit = changes[i]!
    if (edit.to !== edit.from) body.delete(edit.from, edit.to - edit.from)
    if (edit.insert) body.insert(edit.from, edit.insert)
  }
}

export class Document {
  private doc: LoroDoc
  private body: LoroText
  private current: string
  private currentVersion: Version
  private history = new History()
  private disk: Snapshot
  private readonly agents = new Map<string, PeerID>()
  private readonly writing: WriteTicket[] = []
  private readonly tickets = new WeakMap<WriteTicket, { snapshot: Snapshot; generation: number }>()
  private generation = 0

  private constructor(text: string, version: Version) {
    this.doc = new LoroDoc()
    this.body = this.doc.getText(TEXT)
    this.body.insert(0, text)
    this.doc.commit()
    this.current = text
    this.currentVersion = version
    this.disk = this.snapshot()
    this.history.record(version, this.doc.frontiers(), null)
  }

  static open(text: string, version: Version = 1): Document {
    checkText(text)
    checkVersion(version)
    return new Document(text, version)
  }

  get text(): string { return this.current }
  get version(): Version { return this.currentVersion }
  get synced(): { text: string; version: Version } {
    return { text: this.disk.text, version: this.disk.version }
  }
  get dirty(): boolean { return this.current !== this.disk.text }

  agentEdit(origin: Origin, scope: { version: Version; section?: string },
    make: (text: string) => ReadonlyArray<Edit>): Applied {
    if (scope.section !== undefined) findSection(this.current, scope.section)
    let others: Applied["others"] = null
    if (scope.version !== this.version) {
      const old = this.textAt(scope.version)
      const diff = old === null ? null : unified(old, this.current, scope.version, this.version)
      const then = old === null || scope.section === undefined ? null : sectionText(old, scope.section)
      if (then === null || then !== sectionText(this.current, scope.section!)) {
        throw new DocError({ code: "conflict", message: `The document is at version ${this.version}, not ${scope.version}`,
          conflict: { expected: scope.version, current: this.version, diff, forgotten: old === null } })
      }
      others = { since: scope.version, diff }
    }
    const edits = checkedEdits(this.current, make(this.current))
    const next = applyEdits(this.current, edits)
    if (next === this.current) return this.applied(false, others)
    this.checkNextVersion()
    const fork = this.doc.fork()
    const body = fork.getText(TEXT)
    const from = this.doc.oplogVersion()
    try {
      const key = originKey(origin)
      const peer = this.agents.get(key)
      if (peer !== undefined) fork.setPeerId(peer)
      splice(body, edits)
      fork.commit()
      this.doc.import(fork.export({ mode: "update", from }))
      this.agents.set(key, fork.peerIdStr)
      return this.applied(this.refresh(origin), others)
    } finally {
      from.free()
      body.free()
      fork.free()
    }
  }

  userEdit(base: Version, text: string): Applied {
    checkText(text)
    const entry = this.history.find(base)
    if (!entry) throw new DocError({ code: "forgotten", message: `Version ${base} is no longer kept` })
    if (text === this.current) return this.applied(false)
    if (base === this.version) {
      this.checkNextVersion()
      splice(this.body, edits(this.current, text))
      this.doc.commit()
      return this.applied(this.refresh({ kind: "user" }))
    }
    const fork = this.doc.forkAt(entry.frontiers)
    const body = fork.getText(TEXT)
    try {
      const baseText = body.toString()
      if (baseText === text) return this.applied(false)
      splice(body, edits(baseText, text))
      this.importFork(fork)
      return this.applied(this.refresh({ kind: "user" }))
    } finally {
      body.free()
      fork.free()
    }
  }

  mergeFile(diskText: string): boolean {
    checkText(diskText)
    if (diskText === this.disk.text) return false
    const echo = this.writing.find(ticket => ticket.text === diskText)
    if (echo) { this.wrote(echo); return false }
    if (diskText === this.current) { this.disk = this.snapshot(); return false }
    if (sameFrontiers(this.disk.frontiers, this.doc.frontiers())) {
      this.checkNextVersion()
      splice(this.body, edits(this.disk.text, diskText))
      this.doc.commit()
      // synced.version is the last version known written, as in Herdr.
      this.disk = { text: diskText, version: this.disk.version, frontiers: this.doc.frontiers() }
      return this.refresh({ kind: "file" })
    }
    const fork = this.doc.forkAt(this.disk.frontiers)
    const body = fork.getText(TEXT)
    try {
      splice(body, edits(this.disk.text, diskText))
      fork.commit()
      const frontiers = fork.frontiers()
      this.importFork(fork)
      this.disk = { text: diskText, version: this.disk.version, frontiers }
      return this.refresh({ kind: "file" })
    } finally {
      body.free()
      fork.free()
    }
  }

  /** Check the actual merged result on the temporary fork before changing main. */
  private importFork(fork: LoroDoc): void {
    fork.commit()
    const from = this.doc.oplogVersion()
    const forkVersion = fork.oplogVersion()
    const body = fork.getText(TEXT)
    try {
      const updates = fork.export({ mode: "update", from })
      fork.import(this.doc.export({ mode: "update", from: forkVersion }))
      const merged = body.toString()
      checkText(merged)
      if (merged !== this.current) this.checkNextVersion()
      this.doc.import(updates)
    } finally {
      body.free()
      forkVersion.free()
      from.free()
    }
  }

  toWrite(): WriteTicket {
    const snapshot = this.snapshot()
    const ticket: WriteTicket = Object.freeze({ text: snapshot.text, version: snapshot.version, [ticketBrand]: true as const })
    this.tickets.set(ticket, { snapshot, generation: this.generation })
    if (this.writing.length === MAX_WRITING) this.writing.shift()
    this.writing.push(ticket)
    return ticket
  }

  wrote(ticket: WriteTicket): void {
    const snapshot = this.ticketSnapshot(ticket)
    const at = this.writing.indexOf(ticket)
    if (at !== -1) this.writing.splice(0, at + 1)
    this.disk = snapshot
  }

  notWritten(ticket: WriteTicket): void {
    this.ticketSnapshot(ticket)
    const at = this.writing.indexOf(ticket)
    if (at !== -1) this.writing.splice(at, 1)
  }

  private ticketSnapshot(ticket: WriteTicket): Snapshot {
    const data = this.tickets.get(ticket)
    if (!data || data.generation !== this.generation) {
      throw new DocError({ code: "invalid", message: "The write ticket does not belong to this document's current history" })
    }
    return data.snapshot
  }

  textAt(version: Version): string | null {
    if (version === this.version) return this.current
    const entry = this.history.find(version)
    if (!entry) return null
    const fork = this.doc.forkAt(entry.frontiers)
    const body = fork.getText(TEXT)
    try { return body.toString() }
    finally { body.free(); fork.free() }
  }

  changes(since: Version, section?: string): Changes | null {
    const by = this.history.originsSince(since)
    if (by === null) return null
    const old = this.textAt(since)!
    const next = this.current
    const oldPart = section === undefined ? old : sectionText(old, section) ?? ""
    const newPart = section === undefined ? next : sectionText(next, section) ?? ""
    let changes = todoChanges(old, next)
    if (section !== undefined) {
      const id = section.trim().replace(/^#+/, "")
      const before = sections(old).find(found => found.id === id)
      const after = sections(next).find(found => found.id === id)
      const oldLines = lines(old)
      const newLines = lines(next)
      changes = changes.filter(change => {
        const removed = change.kind === "removed"
        const scope = removed ? before : after
        const line = removed ? oldLines[change.oldLine] : newLines[change.line]
        return scope !== undefined && line !== undefined && line.from >= scope.from && line.from < scope.to
      })
    }
    return { from: since, to: this.version, by, diff: unified(oldPart, newPart, since, this.version), todos: changes }
  }

  origin(version: Version): Origin | null {
    const origin = this.history.find(version)?.origin
    return origin ? { ...origin } : null
  }

  compact(maxOps = 50_000, maxPeers = 256): boolean {
    if (this.dirty || this.writing.length) return false
    const vv = this.doc.oplogVersion()
    try {
      if (this.doc.opCount() <= maxOps && vv.length() <= maxPeers) return false
    } finally { vv.free() }
    const doc = new LoroDoc()
    const body = doc.getText(TEXT)
    body.insert(0, this.current)
    doc.commit()
    const origin = this.origin(this.version)
    this.body.free()
    this.doc.free()
    this.doc = doc
    this.body = body
    this.disk = { ...this.disk, frontiers: doc.frontiers() }
    this.history = new History()
    this.history.record(this.version, doc.frontiers(), origin)
    this.generation++
    return true
  }

  private snapshot(): Snapshot {
    return { text: this.current, version: this.version, frontiers: this.doc.frontiers() }
  }

  private checkNextVersion(): void { checkVersion(this.version + 1) }

  private refresh(origin: Origin): boolean {
    const text = this.body.toString()
    const changed = text !== this.current
    if (changed) { this.current = text; this.currentVersion++ }
    // Concurrent deletions can advance frontiers without changing visible text.
    this.history.record(this.version, this.doc.frontiers(), changed ? origin : this.origin(this.version))
    return changed
  }

  private applied(changed: boolean, others: Applied["others"] = null): Applied {
    return { version: this.version, changed, others }
  }

  /** Release the owning document when its registry entry is closed. */
  free(): void { this.body.free(); this.doc.free() }
}
