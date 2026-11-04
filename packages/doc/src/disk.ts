import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readSync,
  renameSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs"
import { basename, dirname, join } from "node:path"
import { MAX_BYTES } from "./constants"
import { checkText } from "./edit"
import { DocError } from "./errors"

export interface Stamp { mtimeMs: number; size: number; ino: number }
export interface Format { bom: boolean; crlf: boolean }

function of(stat: Stats): Stamp { return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino } }
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}
function ioError(path: string, error: unknown): DocError {
  if (error instanceof DocError) return error
  return new DocError({ code: missing(error) ? "not-found" : "invalid",
    message: `Could not access ${path}: ${error instanceof Error ? error.message : String(error)}` })
}
function checkBytes(size: number): void {
  if (size > MAX_BYTES) throw new DocError({ code: "too-large", message: `The file is ${size} bytes, over the limit of ${MAX_BYTES}` })
}

export function stamp(path: string): Stamp | null {
  try { return of(statSync(path)) }
  catch (error) { if (missing(error)) return null; throw ioError(path, error) }
}

export function readFile(path: string): { text: string; stamp: Stamp; format: Format } {
  let fd: number | undefined
  try {
    // Avoid blocking if a path is replaced by a FIFO between inspection and open.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new DocError({ code: "invalid", message: `${path} is not a regular file` })
    checkBytes(stat.size)
    // The extra byte detects growth during the read without ever reading an
    // unbounded file into memory. Metadata and contents use the same descriptor.
    const bytes = Buffer.allocUnsafe(MAX_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null)
      if (!read) break
      size += read
    }
    checkBytes(size)
    let raw: string
    try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)) }
    catch { throw new DocError({ code: "invalid", message: `${path} is not valid UTF-8 text` }) }
    const bom = raw.startsWith("\ufeff")
    if (bom) raw = raw.slice(1)
    const firstBreak = raw.indexOf("\n")
    const crlf = firstBreak > 0 && raw[firstBreak - 1] === "\r"
    return { text: raw.replace(/\r\n/g, "\n"), stamp: of(stat), format: { bom, crlf } }
  } catch (error) { throw ioError(path, error) }
  finally { if (fd !== undefined) closeSync(fd) }
}

export function writeAtomic(path: string, text: string, format: Format): Stamp {
  checkText(text)
  const encoded = Buffer.from((format.bom ? "\ufeff" : "") + (format.crlf ? text.replace(/\n/g, "\r\n") : text))
  checkBytes(encoded.length)
  const temporary = join(dirname(path), `.${basename(path)}.do-it-${process.pid}-${randomUUID()}.tmp`)
  let fd: number | undefined
  let created = false
  try {
    let mode: number | undefined
    try { mode = statSync(path).mode & 0o7777 }
    catch (error) { if (!missing(error)) throw error }
    fd = openSync(temporary, "wx", mode ?? 0o666)
    created = true
    let written = 0
    while (written < encoded.length) {
      const count = writeSync(fd, encoded, written, encoded.length - written)
      if (!count) throw new Error("The file write made no progress")
      written += count
    }
    if (mode !== undefined) fchmodSync(fd, mode)
    fsyncSync(fd)
    const result = of(fstatSync(fd))
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    created = false
    return result
  } catch (error) { throw ioError(path, error) }
  finally {
    if (fd !== undefined) closeSync(fd)
    if (created) { try { unlinkSync(temporary) } catch { /* Preserve the original I/O error. */ } }
  }
}
