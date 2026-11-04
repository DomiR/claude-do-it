import { watch, type FSWatcher } from "node:fs"
import { basename, dirname } from "node:path"

export class FileWatcher {
  private watcher: FSWatcher | undefined
  private debounce: ReturnType<typeof setTimeout> | undefined
  private readonly poll: ReturnType<typeof setInterval>
  constructor(path: string, changed: () => void) {
    const schedule = () => {
      if (this.debounce) clearTimeout(this.debounce)
      this.debounce = setTimeout(() => { this.debounce = undefined; changed() }, 50)
    }
    try {
      this.watcher = watch(dirname(path), (_, file) => { if (file === null || String(file) === basename(path)) schedule() })
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined })
    } catch { /* The stamp poll also works on filesystems without fs.watch. */ }
    this.poll = setInterval(changed, 2000)
  }
  close(): void {
    this.watcher?.close()
    if (this.debounce) clearTimeout(this.debounce)
    clearInterval(this.poll)
  }
}
