import { expect, test } from "bun:test"
import { Effect } from "effect"
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDaemonInfo, withClient, type DaemonInfo } from "../../client/src"
import { isolateDaemonEnvironment } from "../../client/test/environment"

isolateDaemonEnvironment()

async function ready(home: string, child: ReturnType<typeof Bun.spawn>): Promise<DaemonInfo> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const info = readDaemonInfo(home)
    if (info) return info
    if (child.exitCode !== null) throw new Error(`Daemon exited during startup: ${child.exitCode}`)
    await Bun.sleep(10)
  }
  throw new Error("Daemon did not start")
}

for (const shutdown of ["stop", "SIGTERM", "SIGINT", "idle"] as const) {
  test(`${shutdown} exits zero and leaves a clean daemon log`, async () => {
    const home = mkdtempSync(join(tmpdir(), "do-it-shutdown-"))
    const logPath = join(home, "daemon.log")
    writeFileSync(join(home, "index.html"), "<!doctype html><p>Shutdown test</p>")
    const fd = openSync(logPath, "a", 0o600)
    const child = Bun.spawn([process.execPath, "packages/server/src/main.ts"], {
      env: { ...process.env, DO_IT_HOME: home, DO_IT_PORT: "0", DO_IT_WEB_DIST: home, DO_IT_IDLE_MS: shutdown === "idle" ? "200" : "60000" },
      stdout: fd, stderr: fd,
    })
    closeSync(fd)
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000)
    try {
      const info = await ready(home, child)
      const path = join(home, "TODO.md")
      writeFileSync(path, "- [ ] Ship\n")
      // Keep real HTTP response streams open while shutdown closes the scope.
      for (let i = 0; i < 3; i++) {
        const response = await fetch(`${info.baseUrl}/rpc`, {
          method: "POST", headers: { Authorization: `Bearer ${info.token}` },
          body: JSON.stringify({ _tag: "Request", id: String(i), tag: "watch", payload: { path, text: true }, headers: [] }) + "\n",
        })
        const reader = response.body!.getReader()
        readers.push(reader)
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('"Watching"')
      }
      await Effect.runPromise(withClient(info, client => client.edit({
        path, version: 1, author: { _tag: "Agent", name: "shutdown-test" }, op: { _tag: "TodoSet", target: 1, state: "done" },
      })))
      if (shutdown === "idle") {
        for (const reader of readers) await reader.cancel()
        readers.length = 0
        // HEAD must release its request scope, despite having a streamed file body.
        const head = await fetch(`${info.baseUrl}/index.html`, { method: "HEAD" })
        expect(head.status).toBe(200)
        expect(await head.text()).toBe("")
      }
      if (shutdown === "stop") expect(await Effect.runPromise(withClient(info, client => client.stop({})))).toEqual({})
      else if (shutdown !== "idle") child.kill(shutdown)
      expect(await child.exited).toBe(0)
      expect(existsSync(join(home, "daemon.json"))).toBe(false)
      expect(readFileSync(path, "utf8")).toMatch(/^- \[x\] Ship @done \(\d{2}-\d{2}-\d{2} \d{2}:\d{2}\)\n$/)
      const log = readFileSync(logPath, "utf8")
      expect(log).not.toContain("error:")
      expect(log).not.toContain("All fibers interrupted")
      expect(log.trim().split("\n")).toHaveLength(2)
      expect(log.trim().split("\n").at(-1)).toMatch(/^\S+ Daemon stopped$/)
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited }
      for (const reader of readers) { try { await reader.cancel() } catch {} }
      rmSync(home, { recursive: true, force: true })
    }
  }, 10000)
}
