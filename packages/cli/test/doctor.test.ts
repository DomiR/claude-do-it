import { afterAll, describe, expect, it } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { DaemonInfo } from "@do-it/client"
import { Effect } from "effect"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkBun, checkDaemon, checkPath, checkSkill, classifyInstall, doctorText, inspectInstall, selfCommand, shellArg, type Check, type Install } from "../src/doctor"
import { inspectSkill, SKILL_MARKER, type SkillState } from "../src/skill"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) => Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "do-it-doctor-")); dirs.push(dir); return dir }
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const dash = /[\u2013\u2014]| - /
/** Every message and fix a test sees must keep the copy rule: no dashes as separators. */
const seen = (item: Check) => { for (const text of [item.message, ...item.fix]) expect(text).not.toMatch(dash); return item }

const install = (kind: Install["kind"], realEntry: string, root: string | null, version: string | null = "0.1.1"): Install =>
  ({ kind, entry: realEntry, realEntry, root, version })
const checkout = install("checkout", "/r/packages/cli/src/bin.ts", "/r")
const bunx = install("bunx", "/t/bunx-501-claude-do-it@latest/node_modules/claude-do-it/bin/do-it.js", "/t/bunx-501-claude-do-it@latest/node_modules/claude-do-it")

describe("classifyInstall", () => {
  it("tells each kind of install apart", () => {
    expect(classifyInstall("/r/packages/cli/src/bin.ts")).toEqual({ kind: "checkout", root: "/r" })
    expect(classifyInstall("/h/.bun/install/global/node_modules/claude-do-it/bin/do-it.js")).toEqual({ kind: "bun-global", root: "/h/.bun/install/global/node_modules/claude-do-it" })
    expect(classifyInstall("/var/folders/x/T/bunx-501-claude-do-it@latest/node_modules/claude-do-it/bin/do-it.js").kind).toBe("bunx")
    expect(classifyInstall("/usr/local/lib/node_modules/claude-do-it/bin/do-it.js")).toEqual({ kind: "npm-global", root: "/usr/local/lib/node_modules/claude-do-it" })
    expect(classifyInstall("/p/node_modules/claude-do-it/bin/do-it.js")).toEqual({ kind: "package", root: "/p/node_modules/claude-do-it" })
    expect(classifyInstall("/usr/bin/do-it")).toEqual({ kind: "other", root: null })
  })
})

describe("shellArg and selfCommand", () => {
  it("quotes only what needs quoting", () => {
    expect(shellArg("/a/b-c.ts")).toBe("/a/b-c.ts")
    expect(shellArg("/a b")).toBe("'/a b'")
    expect(shellArg("it's")).toBe("'it'\\''s'")
  })

  it("names the way to run this CLI", () => {
    expect(selfCommand(checkout, true)).toBe("do-it")
    expect(selfCommand(checkout, false)).toBe("bun /r/packages/cli/src/bin.ts")
    expect(selfCommand(bunx, false)).toBe("bunx claude-do-it@0.1.1")
  })
})

describe("checkBun", () => {
  const base = { version: "1.3.3", execPath: "/h/.bun/bin/bun", minimum: "1.3.0", onPath: { path: "/h/.bun/bin/bun", same: true, version: "1.3.3" } }
  it("accepts a recent bun, including a canary", () => {
    expect(seen(checkBun(base)).status).toBe("ok")
    expect(checkBun({ ...base, version: "1.3.0-canary.1" }).status).toBe("ok")
  })
  it("asks for an upgrade of an old bun", () => {
    expect(seen(checkBun({ ...base, version: "1.2.21" }))).toMatchObject({ status: "problem", fix: ["bun upgrade"] })
    expect(checkBun({ ...base, version: "1.2.21", onPath: null })).toMatchObject({ status: "problem", fix: ["/h/.bun/bin/bun upgrade"] })
  })
  it("puts bun on PATH when it is missing", () => {
    expect(seen(checkBun({ ...base, onPath: null }))).toMatchObject({ status: "problem", fix: ['export PATH="/h/.bun/bin:$PATH"'] })
  })
  it("checks another bun on PATH", () => {
    expect(seen(checkBun({ ...base, onPath: { path: "/usr/bin/bun", same: false, version: "1.1.0" } }))).toMatchObject({ status: "problem", fix: ["/usr/bin/bun upgrade"] })
    expect(seen(checkBun({ ...base, onPath: { path: "/usr/bin/bun", same: false, version: null } })).status).toBe("warn")
    expect(seen(checkBun({ ...base, onPath: { path: "/usr/bin/bun", same: false, version: "1.4.0" } })).status).toBe("ok")
  })
})

describe("checkPath", () => {
  const base = { self: checkout, pathDirs: ["/usr/bin"], home: "/h", bunInstall: "/h/.bun", appVersion: "0.1.1" }
  it("accepts this CLI on PATH", () => {
    expect(seen(checkPath({ ...base, onPath: { ...checkout, entry: "/h/.local/bin/do-it", path: "/h/.local/bin/do-it" } })).status).toBe("ok")
  })
  it("links a checkout when do-it is missing", () => {
    expect(seen(checkPath({ ...base, onPath: null })).fix).toEqual(["mkdir -p /h/.local/bin", "ln -sf /r/packages/cli/src/bin.ts /h/.local/bin/do-it", 'export PATH="/h/.local/bin:$PATH"'])
    expect(checkPath({ ...base, pathDirs: ["/h/.local/bin"], onPath: null }).fix).toEqual(["mkdir -p /h/.local/bin", "ln -sf /r/packages/cli/src/bin.ts /h/.local/bin/do-it"])
  })
  it("installs globally from bunx when do-it is missing", () => {
    expect(seen(checkPath({ ...base, self: bunx, onPath: null })).fix).toEqual(["bun add -g claude-do-it", 'export PATH="/h/.bun/bin:$PATH"'])
  })
  it("warns about another install of the same or an unknown version", () => {
    const other = { ...install("bun-global", "/h/.bun/install/global/node_modules/claude-do-it/bin/do-it.js", "/h/.bun/install/global/node_modules/claude-do-it"), path: "/h/.bun/bin/do-it" }
    expect(seen(checkPath({ ...base, onPath: other })).status).toBe("warn")
    expect(seen(checkPath({ ...base, onPath: { ...other, version: null } })).status).toBe("warn")
  })
  it("updates another install of an older version", () => {
    const old = { ...install("bun-global", "/h/.bun/install/global/node_modules/claude-do-it/bin/do-it.js", "/h/.bun/install/global/node_modules/claude-do-it", "0.1.0"), path: "/h/.bun/bin/do-it" }
    expect(seen(checkPath({ ...base, self: bunx, onPath: old }))).toMatchObject({ status: "problem", fix: ["bun add -g claude-do-it@0.1.1"] })
    // A checkout's version may be unpublished, so the global install takes the latest release.
    expect(seen(checkPath({ ...base, onPath: old }))).toMatchObject({ status: "problem", fix: ["bun add -g claude-do-it@latest"] })
    expect(checkPath({ ...base, onPath: { ...old, kind: "npm-global" } }).fix).toEqual(["npm install -g claude-do-it@latest"])
    expect(checkPath({ ...base, onPath: { ...old, kind: "checkout", path: "/h/.local/bin/do-it" } }).fix).toEqual(["ln -sf /r/packages/cli/src/bin.ts /h/.local/bin/do-it"])
  })
  it("only warns when it cannot safely replace the other copy, or when that copy is newer", () => {
    const old = { ...install("checkout", "/o/packages/cli/src/bin.ts", "/o", "0.1.0"), path: "/h/.local/bin/do-it" }
    expect(seen(checkPath({ ...base, self: bunx, onPath: old }))).toMatchObject({ status: "warn", fix: [] })
    expect(seen(checkPath({ ...base, onPath: { ...old, kind: "package", realEntry: "/p/node_modules/claude-do-it/bin/do-it.js", root: "/p/node_modules/claude-do-it" } }))).toMatchObject({ status: "warn", fix: [] })
    const newer = { ...install("bun-global", "/h/.bun/install/global/node_modules/claude-do-it/bin/do-it.js", "/h/.bun/install/global/node_modules/claude-do-it", "0.2.0"), path: "/h/.bun/bin/do-it" }
    expect(seen(checkPath({ ...base, onPath: newer }))).toMatchObject({ status: "warn", fix: [] })
  })
})

describe("checkDaemon", () => {
  const info: DaemonInfo = { home: "/h/.do-it", pid: 4242, port: 47100, token: "t", appVersion: "0.1.1", build: "b1", startedAt: 1, baseUrl: "http://127.0.0.1:47100" }
  const base = { home: "/h/.do-it", info, alive: true, appVersion: "0.1.1", build: "b1", self: "do-it" }
  const health = { ok: true as const, pid: 4242, appVersion: "0.1.1", build: "b1" }
  it("accepts no daemon or an exited one", () => {
    expect(seen(checkDaemon({ ...base, info: null, health: null })).status).toBe("ok")
    expect(seen(checkDaemon({ ...base, alive: false, health: null })).status).toBe("ok")
  })
  it("accepts a daemon of this version and build", () => {
    expect(seen(checkDaemon({ ...base, health })).status).toBe("ok")
  })
  it("only warns about a slow daemon", () => {
    expect(seen(checkDaemon({ ...base, health: "slow" })).status).toBe("warn")
  })
  it("stops a daemon that is silent, or of another version or build", () => {
    for (const answer of [null, { ...health, appVersion: "0.1.0" }, { ok: true as const, pid: 4242, appVersion: "0.1.1" }, { ...health, build: "b2" }]) {
      expect(seen(checkDaemon({ ...base, health: answer, self: "bun /r/packages/cli/src/bin.ts" }))).toMatchObject({ status: "problem", fix: ["bun /r/packages/cli/src/bin.ts stop"] })
    }
    expect(checkDaemon({ ...base, health: { ok: true, pid: 4242, appVersion: "0.1.1" } }).message).toContain("reports no build id")
  })
})

describe("checkSkill", () => {
  const base = { target: "/h/.claude/skills/do-it", source: "/r/skill", self: "do-it", dir: false, selfKind: "checkout" as const }
  const state = (value: SkillState) => seen(checkSkill({ ...base, state: value }))
  it("accepts a link or a matching copy", () => {
    expect(state({ kind: "linked" }).status).toBe("ok")
    expect(state({ kind: "same", link: null, marker: "0.1.1" }).status).toBe("ok")
    expect(state({ kind: "same", link: "/x/skill", marker: null }).status).toBe("ok")
  })
  it("installs a missing skill, in the named directory too", () => {
    expect(state({ kind: "missing" }).fix).toEqual(["do-it skill install"])
    expect(seen(checkSkill({ ...base, dir: true, target: "/o/my skills", state: { kind: "missing" } })).fix).toEqual(["do-it skill install --dir '/o/my skills'"])
  })
  it("replaces a differing copy, forcing one do-it did not install", () => {
    expect(state({ kind: "differs", link: null, marker: "0.1.0", directory: true })).toMatchObject({ status: "problem", fix: ["do-it skill install"] })
    expect(state({ kind: "differs", link: null, marker: null, directory: true }).fix).toEqual(["do-it skill install --force"])
    expect(state({ kind: "differs", link: null, marker: null, directory: false }).fix).toEqual(["do-it skill install --force"])
  })
  it("relinks a differing link from a checkout, else forces an install", () => {
    expect(state({ kind: "differs", link: "/x/skill", marker: null, directory: true }).fix).toEqual(["ln -sfn /r/skill /h/.claude/skills/do-it"])
    expect(seen(checkSkill({ ...base, selfKind: "bunx", state: { kind: "differs", link: "/x/skill", marker: null, directory: true } })).fix).toEqual(["do-it skill install --force"])
  })
})

describe("inspectSkill", () => {
  it("reads missing, linked, copied, edited, foreign, and elsewhere linked skills", async () => {
    const root = temp()
    const source = join(root, "source")
    mkdirSync(source)
    writeFileSync(join(source, "SKILL.md"), "# do-it\n")
    const target = join(root, "target")
    expect(await run(inspectSkill(target, source))).toEqual({ kind: "missing" })
    symlinkSync(source, target)
    expect(await run(inspectSkill(target, source))).toEqual({ kind: "linked" })
    rmSync(target)
    mkdirSync(target)
    writeFileSync(join(target, "SKILL.md"), "# do-it\n")
    writeFileSync(join(target, SKILL_MARKER), "0.1.1\n")
    expect(await run(inspectSkill(target, source))).toEqual({ kind: "same", link: null, marker: "0.1.1" })
    appendFileSync(join(target, "SKILL.md"), "edited\n")
    expect(await run(inspectSkill(target, source))).toEqual({ kind: "differs", link: null, marker: "0.1.1", directory: true })
    rmSync(join(target, SKILL_MARKER))
    expect(await run(inspectSkill(target, source))).toEqual({ kind: "differs", link: null, marker: null, directory: true })
    const elsewhere = join(root, "elsewhere")
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, "SKILL.md"), "# do-it\n")
    const linked = join(root, "linked")
    symlinkSync(elsewhere, linked)
    const state = await run(inspectSkill(linked, source))
    expect(state.kind).toBe("same")
    if (state.kind === "same") expect(state.link).toEndWith("/elsewhere")
  })
})

describe("inspectInstall", () => {
  it("reads the version of a checkout through a link, and of a package", async () => {
    const root = temp()
    mkdirSync(join(root, "repo", "packages", "cli", "src"), { recursive: true })
    mkdirSync(join(root, "repo", "packages", "protocol", "src"), { recursive: true })
    writeFileSync(join(root, "repo", "packages", "cli", "src", "bin.ts"), "")
    writeFileSync(join(root, "repo", "packages", "protocol", "src", "index.ts"), "export const APP_VERSION = '9.9.9'\n")
    symlinkSync(join(root, "repo", "packages", "cli", "src", "bin.ts"), join(root, "do-it"))
    const linked = await run(inspectInstall(join(root, "do-it")))
    expect(linked).toMatchObject({ kind: "checkout", version: "9.9.9", entry: join(root, "do-it") })
    const pkg = join(root, "bun", "install", "global", "node_modules", "claude-do-it")
    mkdirSync(join(pkg, "bin"), { recursive: true })
    writeFileSync(join(pkg, "bin", "do-it.js"), "")
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "claude-do-it", version: "0.0.9" }))
    expect(await run(inspectInstall(join(pkg, "bin", "do-it.js")))).toMatchObject({ kind: "bun-global", version: "0.0.9" })
  })
})

describe("doctorText", () => {
  const report = (checks: Check[]) => ({ ok: !checks.some(item => item.status === "problem"), version: "0.1.1", build: "source:/r", cli: checkout, self: "do-it", checks })
  const item = (status: Check["status"], fix: string[] = []): Check => ({ name: "bun", status, message: `a ${status}`, fix, details: {} })
  it("prints a line per check, its fixes, and a summary", () => {
    expect(doctorText(report([item("ok")]))).toBe("do-it 0.1.1, build source:/r, the repo checkout at /r\nok      a ok\nAll checks passed.")
    expect(doctorText(report([item("ok"), item("warn")]))).toEndWith("\nNo problems found, 1 warning.")
    const text = doctorText(report([item("problem", ["do-it stop"]), item("problem", ["a", "b"])]))
    expect(text).toContain("\nproblem a problem\n        fix: do-it stop\n")
    expect(text).toEndWith("2 problems found. Run the fixes, then run do-it doctor again.")
    expect(doctorText(report([item("problem", ["x"])]))).toEndWith("1 problem found. Run the fix, then run do-it doctor again.")
  })
})
