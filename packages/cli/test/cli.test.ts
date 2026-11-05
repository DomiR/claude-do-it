import { describe, expect, it } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { editReply, mismatchReply } from "../src/output"
import { cliPresenter, normalizeArgv, parseArgs } from "../src/parser"

const parse = (args: ReadonlyArray<string>) => Effect.runPromise(parseArgs(args).pipe(Effect.provide(BunServices.layer), Effect.provide(cliPresenter)))

describe("cli argument parsing", () => {
  it("parses global flags, sections, and text after --", async () => {
    const command = await parse(["--json", "--as", "worker", "append", "todo.md", "--version", "4", "--section", "tasks", "--", "- [ ] ship"])
    expect(command).toMatchObject({ kind: "append", options: { json: true, as: "worker" }, section: "tasks", text: "- [ ] ship" })
  })

  it("joins dash-prefixed flag values and preserves terminated text", async () => {
    const old = "- [ ] Add a --verbose flag -h to the README example"
    const next = `${old}\n  - **t1** S, planning`
    expect(normalizeArgv(["--old", old, "--new", next, "--", "- [ ] text"])).toEqual(["--old=" + old, "--new=" + next, "--", "- [ ] text"])
    expect(await parse(["edit", "TODO.md", "--version", "4", "--old", old, "--new", next])).toMatchObject({ kind: "edit", old, next })
    expect(await parse(["todo", "check", "TODO.md", "--version", "4", "--", "- [ ] text"])).toMatchObject({ kind: "todo-set", target: "- [ ] text", state: "done" })
  })

  it("distinguishes numeric todo targets", async () => {
    expect(await parse(["todo", "check", "TODO.md", "--version", "3", "12"])).toMatchObject({ kind: "todo-set", target: "12", state: "done" })
    expect(await parse(["todo", "cancel", "TODO.md", "--version", "3", "Write tests"])).toMatchObject({ kind: "todo-set", target: "Write tests", state: "cancelled" })
    expect(await parse(["todo", "start", "TODO.md", "--version", "3", "12"])).toMatchObject({ kind: "todo-start", target: "12" })
  })

  it("uses TODO.md for open and accepts a zero second wait", async () => {
    expect(await parse(["open", "--no-browser"])).toMatchObject({ kind: "open", displayPath: "TODO.md", noBrowser: true })
    expect(await parse(["diff", "TODO.md", "--since", "1", "--wait", "0"])).toMatchObject({ kind: "diff", wait: 0 })
    expect(await parse(["watch", "TODO.md", "--quiet"])).toMatchObject({ kind: "watch", quiet: true })
  })

  it("defaults --settle-line to two seconds", async () => {
    expect(await parse(["watch", "TODO.md", "--settle", "25"])).toMatchObject({ kind: "watch", settle: 25, settleLine: 2 })
    expect(await parse(["watch", "TODO.md", "--settle", "25", "--settle-line", "0.5"])).toMatchObject({ kind: "watch", settle: 25, settleLine: 0.5 })
  })

  it("rejects missing and out of range arguments", async () => {
    await expect(parse(["read"])).rejects.toThrow()
    await expect(parse(["watch", "TODO.md", "--settle", "601"])).rejects.toThrow()
    await expect(parse(["watch", "TODO.md", "--settle-line", "-1"])).rejects.toThrow()
  })
})

describe("cli output formatting", () => {
  it("formats the documented edit replies", () => {
    expect(editReply({ version: 7, changed: true, section: null, others: null }).text).toBe("Updated. Version: 7")
    expect(editReply({ version: 7, changed: false, section: null, others: null }).text).toBe("Unchanged. Version: 7")
    expect(editReply({ version: 7, changed: true, section: "goals", others: { since: 5, diff: "diff" } }).text).toBe('Updated section "goals". Version: 7. Other sections changed since 5:\ndiff')
  })

  it("formats both version mismatch variants", () => {
    expect(mismatchReply({ _tag: "VersionMismatch", latest: 7, since: 5, diff: "diff", forgotten: false }, 5).text).toBe("Version mismatch, nothing changed. Latest version: 7. Changes since 5:\ndiff")
    expect(mismatchReply({ _tag: "Forgotten", latest: 7 }, 5).text).toBe("Version mismatch, nothing changed. Latest version: 7. Version 5 is no longer kept: run do-it read")
  })
})
