import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { ensureDaemon, withClient } from "@do-it/client"
import { diskText, jsonLine, makeFixture, readLines, runCli, startCli, wait, writeDocument } from "./helpers"

async function openFixture(fixture: ReturnType<typeof makeFixture>): Promise<void> {
  const result = await runCli(["open", fixture.file, "--no-browser"], fixture.env)
  expect(result.code).toBe(0)
}

async function stopFixture(fixture: ReturnType<typeof makeFixture>): Promise<void> {
  await runCli(["stop"], fixture.env)
}

describe("do-it CLI end to end", () => {
  it("merges concurrent CLI agents and stale browser syncs", async () => {
    const fixture = makeFixture()
    await openFixture(fixture)
    const info = await Effect.runPromise(ensureDaemon({ home: fixture.home }))
    const browserReads = await Promise.all(Array.from({ length: 10 }, () => Effect.runPromise(withClient(info, client => client.read({ path: fixture.file })))))
    const browserWrites = browserReads.map((read, index) => Effect.runPromise(withClient(info, client => client.sync({ path: fixture.file, base: read.version, text: `${read.text.trimEnd()}\n- [ ] browser-${index}\n` }))))
    const agentWrites = Array.from({ length: 10 }, async (_, index) => {
      for (;;) {
        const read = await runCli(["read", fixture.file, "--json"], fixture.env)
        const version = jsonLine<{ version: number }>(read).version
        const added = await runCli(["todo", "add", fixture.file, "--version", String(version), "--as", `agent-${index}`, "--json", `agent-${index}`], fixture.env)
        if (added.code === 0) return
        expect(added.code).toBe(1)
      }
    })
    await Promise.all([...browserWrites, ...agentWrites])
    const final = await runCli(["read", fixture.file, "--json"], fixture.env)
    expect(final.code).toBe(0)
    const text = jsonLine<{ text: string }>(final).text
    for (const marker of [...Array.from({ length: 10 }, (_, i) => `browser-${i}`), ...Array.from({ length: 10 }, (_, i) => `agent-${i}`)]) {
      expect(text.split(marker).length - 1).toBe(1)
      expect(diskText(fixture.file).split(marker).length - 1).toBe(1)
    }
    await stopFixture(fixture)
  }, 120_000)

  it("keeps JSON replies and errors to one object per line", async () => {
    const fixture = makeFixture()
    await openFixture(fixture)
    const success = [
      ["read", fixture.file], ["sections", fixture.file], ["todo", "list", fixture.file],
      ["append", fixture.file, "--version", "1", "hello"],
    ]
    for (const args of success) {
      const result = await runCli([...args, "--json"], fixture.env)
      expect(result.code).toBe(0)
      expect(result.stdout.trim().split("\n").map(line => JSON.parse(line))).toHaveLength(1)
    }
    const mismatch = await runCli(["append", fixture.file, "--version", "1", "--json", "--", "stale"], fixture.env)
    expect(mismatch.code).toBe(1); expect(jsonLine<{ error: { code: string } }>(mismatch).error.code).toBe("VersionMismatch")
    const unknown = await runCli(["todo", "check", fixture.file, "--version", "2", "--json", "not there"], fixture.env)
    expect(unknown.code).toBe(1); expect(jsonLine<{ error: { code: string } }>(unknown).error.code).toBe("Refused")
    const invalid = await runCli(["read", "--json"], fixture.env)
    expect(invalid.code).toBe(2); expect(invalid.stdout).toContain("Missing required argument: path")
    const nothing = await runCli(["diff", fixture.file, "--since", "2", "--wait", "1", "--json"], fixture.env)
    expect(nothing.code).toBe(4); expect(jsonLine<{ error: { code: string } }>(nothing).error.code).toBe("NothingYet")
    const watcher = await startCli(["watch", fixture.file, "--since", "2", "--json"], fixture.env)
    const deleteWatcher = await readLines(watcher)
    expect(JSON.parse((await deleteWatcher.next()).value as string).event).toBe("watching")
    unlinkSync(fixture.file)
    const gone = await Promise.race([deleteWatcher.next(), wait(4000).then(() => ({ done: true, value: "" }))])
    expect(JSON.parse(String(gone.value)).event).toBe("deleted")
    expect(await watcher.exited).toBe(9)
    await stopFixture(fixture)
  }, 30_000)

  it("applies a section scoped stale edit and refuses a plain stale edit", async () => {
    const fixture = makeFixture(); writeDocument(fixture.file, "# Goals\n\n- [ ] one\n\n# Notes\n\nold\n")
    await openFixture(fixture)
    const notes = await runCli(["edit", fixture.file, "--version", "1", "--old", "old", "--new", "new"], fixture.env)
    expect(notes.code).toBe(0)
    const scoped = await runCli(["edit", fixture.file, "--version", "1", "--section", "goals", "--old", "one", "--new", "two"], fixture.env)
    expect(scoped.code).toBe(0); expect(scoped.stdout).toContain('Updated section "goals"')
    const refused = await runCli(["edit", fixture.file, "--version", "1", "--old", "new", "--new", "latest"], fixture.env)
    expect(refused.code).toBe(1); expect(refused.stdout).toContain("Version mismatch, nothing changed")
    await stopFixture(fixture)
  })

  it("accepts dash-prefixed edit values and terminated todo targets", async () => {
    const fixture = makeFixture()
    const old = "- [ ] Add a --verbose flag -h to the README example"
    const next = `${old}\n  - **t1** S, planning`
    writeDocument(fixture.file, `# Tasks\n${old}\n- [ ] - [ ] text\n`)
    await openFixture(fixture)
    const edit = await runCli(["edit", fixture.file, "--version", "1", "--section", "tasks", "--old", old, "--new", next], fixture.env)
    expect(edit.code).toBe(0)
    const checked = await runCli(["todo", "check", fixture.file, "--version", "2", "--", "- [ ] text"], fixture.env)
    expect(checked.code).toBe(0)
    await wait(100)
    expect(diskText(fixture.file)).toContain("- [x] - [ ] text")
    await stopFixture(fixture)
  })

  it("stamps todo check, uncheck, cancel, uncancel, and start", async () => {
    const fixture = makeFixture(); writeDocument(fixture.file, "# TODO\n- [ ] Ship\n")
    await openFixture(fixture)
    const stamp = /\(\d{2}-\d{2}-\d{2} \d{2}:\d{2}\)/
    const runTodo = async (name: string, version: number) => {
      const result = await runCli(["todo", name, fixture.file, "--version", String(version), "1"], fixture.env)
      expect(result.code).toBe(0)
      return jsonLine<{ text: string }>(await runCli(["read", fixture.file, "--json"], fixture.env)).text
    }
    expect(await runTodo("check", 1)).toMatch(/- \[x\] Ship @done \(\d{2}-\d{2}-\d{2} \d{2}:\d{2}\)\n/)
    expect(await runTodo("uncheck", 2)).toMatch(/- \[ \] Ship\n/)
    expect(await runTodo("cancel", 3)).toMatch(new RegExp(`- \\[-\\] Ship @cancelled ${stamp.source}\\n`))
    expect(await runTodo("uncancel", 4)).toMatch(/- \[ \] Ship\n/)
    expect(await runTodo("start", 5)).toMatch(new RegExp(`- \\[ \\] Ship @started${stamp.source}\\n`))
    const final = jsonLine<{ text: string }>(await runCli(["read", fixture.file, "--json"], fixture.env)).text
    expect(final).not.toContain("@done")
    expect(final).not.toContain("@cancelled")
    await stopFixture(fixture)
  }, 30_000)

  it("watches todo changes, skips its own changes, and settles a burst", async () => {
    const fixture = makeFixture(); writeDocument(fixture.file, "# TODO\n\n- [ ] first\n")
    await openFixture(fixture)
    const watcher = await startCli(["watch", fixture.file, "--todos", "--since", "1", "--as", "watcher"], fixture.env)
    const lines = await readLines(watcher)
    expect((await lines.next()).value).toContain("Watching")
    const added = await runCli(["todo", "add", fixture.file, "--version", "1", "Write tests"], fixture.env)
    expect(added.code).toBe(0); expect((await lines.next()).value).toContain("added")
    const own = await runCli(["todo", "add", fixture.file, "--version", "2", "--as", "watcher", "Own edit"], fixture.env)
    expect(own.code).toBe(0)
    const settledWatcher = await startCli(["watch", fixture.file, "--settle", "1", "--as", "watcher"], fixture.env)
    const settledLines = await readLines(settledWatcher); expect((await settledLines.next()).value).toContain("Watching")
    const current = jsonLine<{ version: number }>(await runCli(["read", fixture.file, "--json"], fixture.env)).version
    await runCli(["todo", "add", fixture.file, "--version", String(current), "burst one"], fixture.env)
    const next = jsonLine<{ version: number }>(await runCli(["read", fixture.file, "--json"], fixture.env)).version
    await runCli(["todo", "add", fixture.file, "--version", String(next), "burst two"], fixture.env)
    const settled = await settledLines.next(); expect(settled.value).toContain("Settled at version")
    watcher.kill(); settledWatcher.kill(); await stopFixture(fixture)
  }, 30_000)

  it("reconnects after the daemon is restarted", async () => {
    const fixture = makeFixture(); writeDocument(fixture.file, "# TODO\n\n- [ ] first\n")
    await openFixture(fixture)
    const watcher = await startCli(["watch", fixture.file, "--as", "watcher"], fixture.env)
    const lines = await readLines(watcher); expect((await lines.next()).value).toContain("Watching")
    await stopFixture(fixture)
    const edit = await runCli(["todo", "add", fixture.file, "--version", "1", "after restart"], fixture.env)
    expect(edit.code).toBe(0)
    const restart = await lines.next()
    expect(restart.value).toContain("Daemon restarted")
    const version = jsonLine<{ version: number }>(await runCli(["read", fixture.file, "--json"], fixture.env)).version
    await wait(250)
    const laterEdit = await runCli(["todo", "add", fixture.file, "--version", String(version), "later"], fixture.env)
    expect(laterEdit.code).toBe(0)
    let later = ""
    for (let index = 0; index < 30 && !later; index++) { const line = await lines.next(); if (typeof line.value === "string" && line.value.includes("later")) later = line.value }
    expect(later).toContain("later")
    watcher.kill(); await stopFixture(fixture)
  }, 30_000)

  it("opens a missing document and serves the web route when built", async () => {
    const fixture = makeFixture()
    const opened = await runCli(["open", fixture.file, "--no-browser"], fixture.env)
    expect(opened.code).toBe(0); expect(existsSync(fixture.file)).toBe(true)
    const url = opened.stdout.trim().split(": ").at(-1)!
    const auth = await fetch(url, { redirect: "manual" })
    expect(auth.status).toBe(303)
    const location = new URL(auth.headers.get("location")!, url)
    const cookie = auth.headers.get("set-cookie")!.split(";", 1)[0]!
    const page = await fetch(location, { headers: { cookie } })
    expect(page.ok).toBe(true)
    if (existsSync(join(import.meta.dir, "../packages/web/dist/index.html"))) expect(await page.text()).toContain("root")
    const status = await runCli(["status", "--json"], fixture.env)
    const statusBody = jsonLine<{ documents: Array<{ path: string }> }>(status)
    expect(statusBody.documents.some(document => document.path === fixture.file)).toBe(true)
    await stopFixture(fixture)
  })
})
