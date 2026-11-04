import { appendFileSync, copyFileSync, existsSync, statSync, truncateSync } from "node:fs"
import { join } from "node:path"

export class Log {
  private readonly path: string
  constructor(home: string) { this.path = join(home, "daemon.log") }
  rotate(): void {
    if (existsSync(this.path) && statSync(this.path).size >= 1024 * 1024) {
      // Keep the inode: detached stdout and stderr hold append descriptors to
      // this file and would otherwise continue filling the renamed old log.
      copyFileSync(this.path, `${this.path}.old`)
      truncateSync(this.path, 0)
    }
  }
  write(message: string): void {
    try {
      this.rotate()
      const line = `${new Date().toISOString()} ${message}\n`
      if (Buffer.byteLength(line) <= 16 * 1024) appendFileSync(this.path, line, { mode: 0o600 })
    } catch { /* Logging must not prevent shutdown or overwrite the original failure. */ }
  }
}
