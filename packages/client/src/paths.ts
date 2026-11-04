import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function paths(home = process.env.DO_IT_HOME ?? join(homedir(), ".do-it")) {
  home = resolve(home)
  const lock = join(home, "daemon.lock")
  return { home, daemon: join(home, "daemon.json"), token: join(home, "token"), lock,
    lockPid: join(lock, "pid"), log: join(home, "daemon.log"), versions: join(home, "versions.json") }
}
