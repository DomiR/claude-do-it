import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs"

export function readJson(path: string, maxBytes = 2 * 1024 * 1024): unknown {
  const fd = openSync(path, "r")
  try {
    const data = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size <= maxBytes) {
      const count = readSync(fd, data, size, data.length - size, null)
      if (count === 0) return JSON.parse(data.subarray(0, size).toString("utf8"))
      size += count
    }
    throw new Error(`State file exceeds ${maxBytes} bytes`)
  } finally { closeSync(fd) }
}

export function writeJson(path: string, data: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, "wx", 0o600)
    writeFileSync(fd, JSON.stringify(data) + "\n")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* Renamed, or never created. */ }
  }
}
