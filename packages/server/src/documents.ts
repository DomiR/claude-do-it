import { Document, DocError, readFile, stamp, writeAtomic, type Format, type Stamp } from "@do-it/doc"
import { DocumentGone, Forgotten, Refused, VersionMismatch, type RpcFailure } from "@do-it/protocol"
import { Context, Deferred, Effect, Layer } from "effect"
import { statSync } from "node:fs"
import { dirname, extname, isAbsolute, resolve } from "node:path"
import { TEMPLATE } from "./config"
import type { Log } from "./log"
import { Versions } from "./versions"
import { FileWatcher } from "./watcher"

export interface OpenDocument {
  path: string
  doc: Document
  signal: Deferred.Deferred<void>
  watcher: FileWatcher | undefined
  format: Format
  stamp: Stamp
  watchers: number
  waiters: number
  lastUsed: number
  deleted: boolean
  writing: ReturnType<typeof setTimeout> | undefined
  missing: ReturnType<typeof setTimeout> | undefined
}

export function rpcError(error: unknown, latest = 1): RpcFailure {
  if (error instanceof DocError) {
    if (error.code === "conflict" && error.conflict) {
      const c = error.conflict
      return new VersionMismatch({ latest: c.current, since: c.expected, diff: c.diff, forgotten: c.forgotten })
    }
    if (error.code === "forgotten") return new Forgotten({ latest })
    return new Refused({ code: error.code === "conflict" ? "invalid" : error.code, message: error.message })
  }
  if (error instanceof Refused || error instanceof DocumentGone || error instanceof Forgotten || error instanceof VersionMismatch) return error
  return new Refused({ code: "invalid", message: error instanceof Error ? error.message : String(error) })
}

export function rpcTry<A>(f: () => A, latest?: () => number): Effect.Effect<A, RpcFailure> {
  return Effect.try({ try: f, catch: error => rpcError(error, latest?.()) })
}

function same(a: Stamp, b: Stamp): boolean { return a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.size === b.size }

export class DocumentRegistry {
  private readonly entries = new Map<string, OpenDocument>()
  totalWatchers = 0
  private closing = false
  constructor(readonly versions: Versions, private readonly log: Log) {}

  validate(path: string): string {
    if (!isAbsolute(path) || ![".md", ".markdown"].includes(extname(path).toLowerCase())) {
      throw new Refused({ code: "invalid", message: "The path must be absolute and end in .md or .markdown" })
    }
    path = resolve(path)
    try { if (!statSync(dirname(path)).isDirectory()) throw new Error("not a directory") }
    catch {
      if (this.entries.has(path) || this.versions.has(path)) throw new DocumentGone({ path })
      throw new Refused({ code: "invalid", message: "The document's parent directory must exist" })
    }
    return path
  }

  open(input: string, create = false): { entry: OpenDocument; created: boolean } {
    const path = this.validate(input)
    const existing = this.entries.get(path)
    if (existing) {
      existing.lastUsed = Date.now()
      if (existing.deleted || stamp(path) === null) throw new DocumentGone({ path })
      return { entry: existing, created: false }
    }
    const missing = stamp(path) === null
    if (missing && !create) {
      if (this.versions.has(path)) throw new DocumentGone({ path })
      throw new Refused({ code: "invalid", message: "The document does not exist, open it with create enabled" })
    }
    this.makeRoom()
    if (missing) writeAtomic(path, TEMPLATE, { bom: false, crlf: false })
    const file = readFile(path)
    const doc = this.versions.open(path, file.text)
    const entry: OpenDocument = { path, doc, signal: Deferred.makeUnsafe<void>(), watcher: undefined,
      format: file.format, stamp: file.stamp, watchers: 0, waiters: 0, lastUsed: Date.now(), deleted: false,
      writing: undefined, missing: undefined }
    this.entries.set(path, entry)
    entry.watcher = new FileWatcher(path, () => this.poll(entry))
    return { entry, created: missing }
  }

  get(path: string): OpenDocument { return this.open(path).entry }
  status() { return [...this.entries.values()].map(entry => ({ path: entry.path, version: entry.doc.version, watchers: entry.watchers })) }

  private makeRoom(): void {
    if (this.entries.size < 64) return
    const idle = [...this.entries.values()].filter(entry => entry.watchers === 0 && entry.waiters === 0).sort((a, b) => a.lastUsed - b.lastUsed)
    for (const entry of idle) {
      this.flush(entry)
      if (entry.deleted || !entry.doc.dirty) { this.closeEntry(entry); return }
    }
    throw new Refused({ code: "too-large", message: "At most 64 documents may be open, all available documents are busy" })
  }

  notify(entry: OpenDocument): void {
    const signal = entry.signal
    entry.signal = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(signal, Effect.void)
  }

  changed(entry: OpenDocument, previous: number): void {
    if (entry.doc.version === previous) return
    entry.lastUsed = Date.now()
    this.notify(entry)
    this.versions.record(entry.path, entry.doc.version, entry.doc.text)
    this.scheduleWrite(entry)
  }

  subscribe(entry: OpenDocument): () => void {
    if (entry.deleted) throw new DocumentGone({ path: entry.path })
    if (entry.watchers >= 32 || this.totalWatchers >= 256) {
      throw new Refused({ code: "too-large", message: "The document or daemon watch stream limit has been reached" })
    }
    entry.watchers++
    this.totalWatchers++
    return () => { entry.watchers--; this.totalWatchers--; entry.lastUsed = Date.now() }
  }

  private scheduleWrite(entry: OpenDocument): void {
    if (!entry.writing && !this.closing && !entry.deleted && entry.doc.dirty) {
      entry.writing = setTimeout(() => { entry.writing = undefined; this.flush(entry) }, 25)
    }
  }

  poll(entry: OpenDocument): void {
    if (entry.deleted || this.closing) return
    try {
      const current = stamp(entry.path)
      if (!current) {
        if (!entry.missing) entry.missing = setTimeout(() => {
          entry.missing = undefined
          try { if (stamp(entry.path) === null) this.deleted(entry); else this.poll(entry) }
          catch (error) { this.log.write(`Could not check ${entry.path}: ${String(error)}`) }
        }, 500)
        return
      }
      if (entry.missing) { clearTimeout(entry.missing); entry.missing = undefined }
      if (!same(entry.stamp, current)) {
        const file = readFile(entry.path)
        const previous = entry.doc.version
        entry.doc.mergeFile(file.text)
        entry.format = file.format
        entry.stamp = file.stamp
        this.changed(entry, previous)
        this.versions.record(entry.path, entry.doc.version, entry.doc.text)
        const compacted = entry.doc.compact()
        if (compacted) this.log.write(`Compacted ${entry.path} at version ${entry.doc.version} (${compacted.reason}: ${compacted.ops} ops, ${compacted.peers} peers), kept versions ${compacted.oldest}-${entry.doc.version}`)
      }
      this.scheduleWrite(entry)
    } catch (error) { this.log.write(`Could not merge ${entry.path}: ${String(error)}`) }
  }

  flush(entry: OpenDocument): void {
    if (entry.writing) clearTimeout(entry.writing)
    entry.writing = undefined
    if (entry.deleted) return
    let ticket: ReturnType<Document["toWrite"]> | undefined
    try {
      // Read before writing so an external edit arriving during the debounce
      // becomes a merge, rather than being silently overwritten.
      const current = stamp(entry.path)
      if (!current) { if (!this.closing) this.poll(entry); return }
      if (!same(entry.stamp, current)) {
        const file = readFile(entry.path)
        const previous = entry.doc.version
        entry.doc.mergeFile(file.text)
        entry.format = file.format
        entry.stamp = file.stamp
        if (entry.doc.version !== previous) this.notify(entry)
      }
      if (entry.doc.dirty) {
        ticket = entry.doc.toWrite()
        entry.stamp = writeAtomic(entry.path, ticket.text, entry.format)
        entry.doc.wrote(ticket)
        ticket = undefined
      }
      this.versions.record(entry.path, entry.doc.version, entry.doc.text)
      const compacted = entry.doc.compact()
      if (compacted) this.log.write(`Compacted ${entry.path} at version ${entry.doc.version} (${compacted.reason}: ${compacted.ops} ops, ${compacted.peers} peers), kept versions ${compacted.oldest}-${entry.doc.version}`)
    } catch (error) {
      if (ticket) entry.doc.notWritten(ticket)
      this.log.write(`Could not write ${entry.path}: ${String(error)}`)
    }
  }

  private deleted(entry: OpenDocument): void {
    entry.deleted = true
    this.notify(entry)
    this.closeEntry(entry)
  }
  private closeEntry(entry: OpenDocument): void {
    entry.watcher?.close()
    if (entry.writing) clearTimeout(entry.writing)
    if (entry.missing) clearTimeout(entry.missing)
    if (this.entries.get(entry.path) === entry) { this.entries.delete(entry.path); entry.doc.free() }
  }
  close(): void {
    this.closing = true
    for (const entry of this.entries.values()) {
      this.flush(entry)
      entry.deleted = true
      this.notify(entry)
      this.closeEntry(entry)
    }
    this.versions.flush()
  }
}

export class Documents extends Context.Service<Documents, DocumentRegistry>()("@do-it/server/Documents") {}
export function DocumentsLive(versions: Versions, log: Log) {
  return Layer.effect(Documents, Effect.acquireRelease(Effect.sync(() => new DocumentRegistry(versions, log)), registry => Effect.sync(() => registry.close())))
}
