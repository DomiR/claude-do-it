import { Document } from "@do-it/doc"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { readJson, writeJson } from "./files"
import type { Log } from "./log"

interface VersionEntry { version: number; sha256: string }
export function sha256(text: string): string { return createHash("sha256").update(text).digest("hex") }

export class Versions {
  private readonly entries = new Map<string, VersionEntry>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly path: string
  constructor(home: string, private readonly log: Log) {
    this.path = join(home, "versions.json")
    try {
      const value = readJson(this.path)
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [path, entry] of Object.entries(value)) {
          const item = entry as Partial<VersionEntry> | null
          if (item && Number.isSafeInteger(item.version) && item.version! > 0 && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256)) {
            this.entries.set(path, item as VersionEntry)
            this.trim()
          }
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.write("Could not read versions.json, starting with fresh version records") }
  }
  has(path: string): boolean { return this.entries.has(path) }
  open(path: string, text: string): Document {
    const old = this.entries.get(path)
    let doc: Document
    if (old && old.sha256 !== sha256(text)) {
      // The persisted hash cannot reconstruct an old text. Make the file-origin
      // version through the public API, then forget the synthetic predecessor.
      doc = Document.open(text === "" ? "\n" : "", old.version)
      doc.mergeFile(text)
      doc.compact(0, 0)
    } else doc = Document.open(text, old?.version)
    this.record(path, doc.version, text)
    return doc
  }
  record(path: string, version: number, text: string): void {
    this.entries.delete(path)
    this.entries.set(path, { version, sha256: sha256(text) })
    this.trim()
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, 1000)
  }
  private trim(): void {
    while (this.entries.size > 256) this.entries.delete(this.entries.keys().next().value!)
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    try { writeJson(this.path, Object.fromEntries(this.entries)) }
    catch (error) { this.log.write(`Could not save versions: ${String(error)}`) }
  }
}
