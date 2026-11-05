import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { APP_VERSION } from "@do-it/protocol"

const root = join(import.meta.dir, "..")
const realRoot = realpathSync(root)
const wrapper = join(root, "bin", "do-it")

interface PluginEntry { name: string; source: unknown; description?: string }
interface Marketplace { name: string; description?: string; owner: { name: string }; plugins: ReadonlyArray<PluginEntry> }
type Plugin = { name: string; version: string; description?: string } & Record<string, unknown>

const readJson = <A>(file: string): A => JSON.parse(readFileSync(file, "utf8")) as A
const marketplace = readJson<Marketplace>(join(root, ".claude-plugin", "marketplace.json"))
const plugin = readJson<Plugin>(join(root, ".claude-plugin", "plugin.json"))
const reservedPrefix = /^(claude-|anthropic-|anthropics-|claudeai-|cc-plugin-)/

/** Every component path must start with ./, exist, and stay inside the plugin root (symbolic links included). */
function insideRoot(path: string): string {
  expect(path.startsWith("./") || path === ".").toBe(true)
  expect(path.split("/")).not.toContain("..")
  const resolved = resolve(root, path)
  expect(existsSync(resolved)).toBe(true)
  const real = realpathSync(resolved)
  expect(real === realRoot || real.startsWith(realRoot + sep)).toBe(true)
  return resolved
}

/** The SKILL.md files one `skills` entry names: the folder's own, or one per `<name>/SKILL.md` folder. */
function skillFiles(dir: string): ReadonlyArray<string> {
  if (existsSync(join(dir, "SKILL.md"))) return [realpathSync(join(dir, "SKILL.md"))]
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
    .map(entry => realpathSync(join(dir, entry.name, "SKILL.md")))
}

const scratch: string[] = []
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "do-it-plugin-"))
  scratch.push(dir)
  return dir
}

function fakeBun(): string {
  const dir = tempDir()
  writeFileSync(join(dir, "bun"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 })
  return dir
}

async function runWrapper(args: ReadonlyArray<string>, env: Record<string, string>) {
  const child = Bun.spawn([wrapper, ...args], { env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, stdout, stderr }
}

describe("Claude Code plugin", () => {
  it("has a marketplace whose entries point at plugin manifests with the same name", () => {
    expect(marketplace.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    expect(marketplace.name).not.toMatch(reservedPrefix)
    expect(marketplace.owner.name.length).toBeGreaterThan(0)
    expect(marketplace.plugins.length).toBeGreaterThan(0)
    for (const entry of marketplace.plugins) {
      expect(typeof entry.source).toBe("string")
      const dir = insideRoot(entry.source as string)
      const manifest = readJson<Plugin>(join(dir, ".claude-plugin", "plugin.json"))
      expect(entry.name).toBe(manifest.name)
    }
  })

  it("names the plugin validly and versions it with the CLI", () => {
    expect(plugin.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(plugin.name).not.toMatch(reservedPrefix)
    expect(plugin.version).toBe(APP_VERSION)
  })

  it("keeps every component path inside the plugin root", () => {
    for (const key of ["skills", "commands", "agents", "hooks", "mcpServers", "outputStyles", "lspServers"]) {
      const value = plugin[key]
      const paths = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter(item => typeof item === "string") : []
      for (const path of paths) insideRoot(path)
    }
  })

  it("loads exactly one skill, the source skill/SKILL.md", () => {
    const entries = plugin.skills === undefined ? [] : Array.isArray(plugin.skills) ? plugin.skills as string[] : [plugin.skills as string]
    const dirs = entries.map(insideRoot)
    if (existsSync(join(root, "skills"))) dirs.push(join(root, "skills"))
    const files = [...new Set(dirs.flatMap(skillFiles))]
    expect(files).toEqual([realpathSync(join(root, "skill", "SKILL.md"))])
    expect(lstatSync(join(root, "skill")).isSymbolicLink()).toBe(false)
    const frontmatter = readFileSync(files[0]!, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""
    expect(frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim()).toBe("do-it")
  })

  it("ships an executable do-it that runs the published CLI of the same version", async () => {
    expect(statSync(wrapper).mode & 0o111).not.toBe(0)
    const result = await runWrapper(["read", "TODO.md", "--", "- x"], { PATH: fakeBun() })
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.stdout.trimEnd().split("\n")).toEqual(["x", "--package", `claude-do-it@${APP_VERSION}`, "do-it", "read", "TODO.md", "--", "- x"])
  })

  it("explains when Bun is missing", async () => {
    const result = await runWrapper(["status"], { PATH: tempDir() })
    expect(result.code).toBe(127)
    expect(result.stderr).toContain("https://bun.sh")
  })

  it("writes its descriptions without dashes as separators", () => {
    for (const text of [marketplace.description, plugin.description, ...marketplace.plugins.map(entry => entry.description)]) {
      expect(text ?? "").not.toMatch(/[–—]| - /)
    }
  })
})
