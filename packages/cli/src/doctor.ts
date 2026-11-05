import { alive, checkHealth, clientBuild, paths, readDaemonInfo, type DaemonInfo, type Health } from "@do-it/client"
import { APP_VERSION, MIN_BUN_VERSION } from "@do-it/protocol"
import { Config, Effect, FileSystem, Option, Path } from "effect"
import { defaultSkillDir, inspectSkill, skillSource, type SkillState } from "./skill"

export type CheckStatus = "ok" | "warn" | "problem"
export type CheckName = "bun" | "path" | "daemon" | "skill"

/** One line of the report. `fix` holds the commands that solve a problem, in order. */
export interface Check {
  name: CheckName
  status: CheckStatus
  message: string
  fix: ReadonlyArray<string>
  details: Record<string, unknown>
}

export type InstallKind = "checkout" | "bun-global" | "bunx" | "npm-global" | "package" | "other"

/** A do-it executable: where it is, what kind of install it belongs to, and its version. */
export interface Install {
  kind: InstallKind
  entry: string
  realEntry: string
  root: string | null
  version: string | null
}

export interface DoctorReport {
  ok: boolean
  version: string
  build: string
  cli: Install
  /** The command the fixes use to run this CLI. */
  self: string
  checks: ReadonlyArray<Check>
}

const check = (name: CheckName, status: CheckStatus, message: string, fix: ReadonlyArray<string> = [], details: Record<string, unknown> = {}): Check =>
  ({ name, status, message, fix, details })

/** Quotes a value for a POSIX shell when it needs quoting. */
export function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

/** `export PATH=...` for a directory, quoted so `$PATH` still expands. */
function exportPath(dir: string): string {
  return `export PATH="${dir.replace(/["\\$`]/g, "\\$&")}:$PATH"`
}

/** Tells the kind of install from the real path of a do-it executable. */
export function classifyInstall(realEntry: string): { kind: InstallKind; root: string | null } {
  const checkout = "/packages/cli/src/bin.ts"
  if (realEntry.endsWith(checkout)) return { kind: "checkout", root: realEntry.slice(0, -checkout.length) }
  const bundle = /^(.*)\/bin\/do-it\.js$/.exec(realEntry)
  if (!bundle) return { kind: "other", root: null }
  const root = bundle[1]!
  if (root.includes("/install/global/node_modules/")) return { kind: "bun-global", root }
  if (/\/bunx-[^/]+\//.test(root)) return { kind: "bunx", root }
  if (root.endsWith("/lib/node_modules/claude-do-it")) return { kind: "npm-global", root }
  return { kind: "package", root }
}

export function installLabel(install: Install): string {
  switch (install.kind) {
    case "checkout": return `the repo checkout at ${install.root}`
    case "bun-global": return "the global bun install"
    case "bunx": return "a bunx copy"
    case "npm-global": return "the global npm install"
    case "package": return `the claude-do-it package in ${install.root}`
    case "other": return install.realEntry
  }
}

/** How a fix runs this CLI: `do-it` when PATH finds it, else the way to reach this copy. */
export function selfCommand(self: Install, onPathIsSelf: boolean): string {
  if (onPathIsSelf) return "do-it"
  if (self.kind === "bunx" && self.version !== null) return `bunx claude-do-it@${self.version}`
  return `bun ${shellArg(self.realEntry)}`
}

/** The release part of a version, so a canary of 1.3.0 counts as 1.3.0. */
const core = (version: string) => version.replace(/[-+].*$/, "")
export const atLeast = (version: string, minimum: string) => Bun.semver.order(core(version), core(minimum)) >= 0

export interface BunInput {
  version: string
  execPath: string
  minimum: string
  /** The bun PATH finds. `same` is true when it is the bun running this CLI. */
  onPath: { path: string; same: boolean; version: string | null } | null
}

export function checkBun(i: BunInput): Check {
  const details = { version: i.version, execPath: i.execPath, minimum: i.minimum, onPath: i.onPath }
  if (!atLeast(i.version, i.minimum)) {
    return check("bun", "problem", `Bun ${i.version} is older than ${i.minimum}, which do-it needs.`,
      [i.onPath?.same ? "bun upgrade" : `${shellArg(i.execPath)} upgrade`], details)
  }
  if (i.onPath === null) {
    const dir = i.execPath.slice(0, Math.max(1, i.execPath.lastIndexOf("/")))
    return check("bun", "problem", `bun is not on PATH, so the do-it command and bunx cannot start (this CLI runs on ${i.execPath}).`, [exportPath(dir)], details)
  }
  if (!i.onPath.same) {
    if (i.onPath.version === null) return check("bun", "warn", `bun on PATH (${i.onPath.path}) did not report its version.`, [], details)
    if (!atLeast(i.onPath.version, i.minimum)) {
      return check("bun", "problem", `bun on PATH (${i.onPath.path}) is ${i.onPath.version}, older than ${i.minimum}.`, [`${shellArg(i.onPath.path)} upgrade`], details)
    }
    return check("bun", "ok", `Bun ${i.version} at ${i.execPath}, and bun on PATH (${i.onPath.path}) is ${i.onPath.version} (do-it needs ${i.minimum} or newer)`, [], details)
  }
  return check("bun", "ok", `Bun ${i.version} at ${i.onPath.path} (do-it needs ${i.minimum} or newer)`, [], details)
}

export interface PathInput {
  self: Install
  onPath: (Install & { path: string }) | null
  pathDirs: ReadonlyArray<string>
  home: string
  bunInstall: string
  appVersion: string
}

export function checkPath(i: PathInput): Check {
  const details = { self: i.self, onPath: i.onPath }
  const onPath = i.onPath
  if (onPath !== null && onPath.realEntry === i.self.realEntry) return check("path", "ok", `do-it on PATH is this CLI (${onPath.path})`, [], details)
  if (onPath === null) {
    if (i.self.kind === "checkout") {
      const bin = `${i.home}/.local/bin`
      return check("path", "problem", "do-it is not on PATH.", [`mkdir -p ${shellArg(bin)}`, `ln -sf ${shellArg(i.self.realEntry)} ${shellArg(`${bin}/do-it`)}`,
        ...(i.pathDirs.includes(bin) ? [] : [exportPath(bin)])], details)
    }
    const bin = `${i.bunInstall}/bin`
    return check("path", "problem", "do-it is not on PATH.", ["bun add -g claude-do-it", ...(i.pathDirs.includes(bin) ? [] : [exportPath(bin)])], details)
  }
  const other = `do-it on PATH (${onPath.path}) is ${installLabel(onPath)}`
  if (onPath.version === null) return check("path", "warn", `${other}, not this CLI (${installLabel(i.self)}), and its version is unknown.`, [], details)
  if (onPath.version === i.appVersion) {
    return check("path", "warn", `${other}, not this CLI (${installLabel(i.self)}). Run do-it doctor to check that one too.`, [], details)
  }
  const fix = onPath.kind === "bun-global" ? `bun add -g claude-do-it@${i.appVersion}`
    : onPath.kind === "npm-global" ? `npm install -g claude-do-it@${i.appVersion}`
    : i.self.kind !== "bunx" ? `ln -sf ${shellArg(i.self.realEntry)} ${shellArg(onPath.path)}`
    : `bun add -g claude-do-it@${i.appVersion}`
  return check("path", "problem", `${other} at version ${onPath.version}, but this CLI is ${i.appVersion}.`, [fix], details)
}

export interface DaemonInput {
  home: string
  info: DaemonInfo | null
  alive: boolean
  health: Health | "slow" | null
  appVersion: string
  build: string
  self: string
}

export function checkDaemon(i: DaemonInput): Check {
  const info = i.info
  if (info === null) return check("daemon", "ok", `No daemon runs for ${i.home}.`, [], { running: false })
  if (!i.alive) return check("daemon", "ok", `No daemon runs for ${i.home} (daemon.json names pid ${info.pid}, which has exited).`, [], { running: false, pid: info.pid })
  const where = `The daemon (pid ${info.pid}, 127.0.0.1:${info.port})`
  const stop = [`${i.self} stop`]
  const restart = `Stop it and the next do-it command starts this CLI's build; open editor tabs need a reload after that.`
  if (i.health === "slow") return check("daemon", "warn", `${where} did not answer /health within 500 ms.`, [], { running: true, pid: info.pid, port: info.port })
  if (i.health === null) return check("daemon", "problem", `${where} does not answer /health.`, stop, { running: true, pid: info.pid, port: info.port })
  const details = { running: true, pid: info.pid, port: info.port, appVersion: i.health.appVersion, build: i.health.build ?? null }
  if (i.health.appVersion !== i.appVersion) {
    return check("daemon", "problem", `${where} runs do-it ${i.health.appVersion}, but this CLI is ${i.appVersion}. ${restart}`, stop, details)
  }
  if (i.health.build === undefined) return check("daemon", "problem", `${where} runs an older build of do-it ${i.appVersion} that reports no build id. ${restart}`, stop, details)
  if (i.health.build !== i.build) {
    return check("daemon", "problem", `${where} runs build ${i.health.build}, but this CLI starts build ${i.build}. ${restart}`, stop, details)
  }
  return check("daemon", "ok", `${where} runs this CLI's version and build.`, [], details)
}

export interface SkillInput {
  /** The resolved skill directory. */
  target: string
  source: string
  state: SkillState
  self: string
  /** Set when the person named the directory, so the fix installs there too. */
  dir: boolean
  selfKind: InstallKind
}

export function checkSkill(i: SkillInput): Check {
  const dir = i.dir ? ` --dir ${shellArg(i.target)}` : ""
  const install = `${i.self} skill install${dir}`
  const force = `${i.self} skill install --force${dir}`
  const details = { path: i.target, source: i.source, state: i.state }
  const where = `The skill in ${i.target}`
  switch (i.state.kind) {
    case "missing": return check("skill", "problem", `The do-it skill is not installed in ${i.target}.`, [install], details)
    case "linked": return check("skill", "ok", `${where} links to this CLI's skill.`, [], details)
    case "same": return check("skill", "ok", i.state.link === null ? `${where} matches this CLI's skill.` : `${where} links to ${i.state.link}, which matches this CLI's skill.`, [], details)
    case "differs":
      if (i.state.link !== null) {
        return check("skill", "problem", `${where} links to ${i.state.link}, which differs from this CLI's skill.`,
          [i.selfKind === "checkout" ? `ln -sfn ${shellArg(i.source)} ${shellArg(i.target)}` : force], details)
      }
      if (i.state.directory && i.state.marker !== null) {
        return check("skill", "problem", `${where} is a copy do-it ${i.state.marker} installed, and it differs from this CLI's skill.`, [install], details)
      }
      return check("skill", "problem", `${where} differs from this CLI's skill and was not installed by do-it; --force replaces it.`, [force], details)
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

export function doctorText(report: DoctorReport): string {
  const lines = [`do-it ${report.version}, build ${report.build}, ${installLabel(report.cli)}`]
  for (const item of report.checks) {
    lines.push(`${item.status.padEnd(8)}${item.message}`)
    for (const fix of item.fix) lines.push(`        fix: ${fix}`)
  }
  const problems = report.checks.filter(item => item.status === "problem").length
  const warnings = report.checks.filter(item => item.status === "warn").length
  if (problems > 0) lines.push(`${plural(problems, "problem")} found. Run the ${problems === 1 ? "fix" : "fixes"}, then run ${report.self} doctor again.`)
  else if (warnings > 0) lines.push(`No problems found, ${plural(warnings, "warning")}.`)
  else lines.push("All checks passed.")
  return lines.join("\n")
}

/** Set by the npm build. The bundle's entry is bin/do-it.js; a checkout's is bin.ts. */
declare const DO_IT_BUILD: string | undefined
const selfEntry = new URL(typeof DO_IT_BUILD === "string" ? "./do-it.js" : "./bin.ts", import.meta.url)

/** Reads a do-it executable's install: its kind and the version its files declare. */
export const inspectInstall = Effect.fn("inspectInstall")(function* (entry: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const realEntry = yield* fs.realPath(entry).pipe(Effect.orElseSucceed(() => path.resolve(entry)))
  const { kind, root } = classifyInstall(realEntry)
  let version: string | null = null
  if (root !== null && kind === "checkout") {
    const source = yield* fs.readFileString(path.join(root, "packages", "protocol", "src", "index.ts")).pipe(Effect.orElseSucceed(() => ""))
    version = /APP_VERSION = ['"]([^'"]+)['"]/.exec(source)?.[1] ?? null
  } else if (root !== null) {
    const manifest = yield* fs.readFileString(path.join(root, "package.json")).pipe(
      Effect.flatMap(text => Effect.try(() => JSON.parse(text) as { name?: unknown; version?: unknown })), Effect.orElseSucceed(() => null))
    version = manifest?.name === "claude-do-it" && typeof manifest.version === "string" ? manifest.version : null
  }
  return { kind, entry, realEntry, root, version } satisfies Install
})

const env = (name: string) => Config.option(Config.String(name)).pipe(Effect.map(Option.getOrUndefined), Effect.orDie)

/** The version a bun executable reports, or null when it does not answer within 2 seconds. */
function bunVersion(bun: string): string | null {
  try {
    const result = Bun.spawnSync([bun, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 2000 })
    const text = result.stdout.toString().trim()
    return result.exitCode === 0 && /^\d+\.\d+\.\d+/.test(text) ? text : null
  } catch { return null }
}

/** Gathers what the checks need and runs them. It never starts a daemon. */
export const runDoctor = Effect.fn("runDoctor")(function* (options: { skillDir?: string }) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const searchPath = (yield* env("PATH")) ?? ""
  const pathDirs = searchPath.split(":").filter(Boolean)
  const home = (yield* env("HOME")) ?? ""
  const bunInstall = (yield* env("BUN_INSTALL")) ?? path.join(home, ".bun")
  const real = (file: string) => fs.realPath(file).pipe(Effect.orElseSucceed(() => file))

  const self = yield* inspectInstall(yield* path.fromFileUrl(selfEntry).pipe(Effect.orDie))
  const doItPath = Bun.which("do-it", { PATH: searchPath })
  const onPath = doItPath === null ? null : { ...(yield* inspectInstall(doItPath)), path: doItPath }
  const onPathIsSelf = onPath !== null && onPath.realEntry === self.realEntry
  const command = selfCommand(self, onPathIsSelf)

  const bunPath = Bun.which("bun", { PATH: searchPath })
  const sameBun = bunPath !== null && (yield* real(bunPath)) === (yield* real(process.execPath))
  const bunCheck = checkBun({ version: Bun.version, execPath: process.execPath, minimum: MIN_BUN_VERSION,
    onPath: bunPath === null ? null : { path: bunPath, same: sameBun, version: sameBun ? Bun.version : bunVersion(bunPath) } })

  const build = yield* clientBuild
  const daemonHome = (yield* paths()).home
  const info = yield* readDaemonInfo()
  const running = info !== null && alive(info.pid)
  const health = running ? yield* checkHealth(info) : null
  const daemonCheck = checkDaemon({ home: daemonHome, info, alive: running, health, appVersion: APP_VERSION, build, self: command })

  const source = yield* skillSource
  const target = path.resolve(options.skillDir ?? (yield* defaultSkillDir))
  const skillCheck = checkSkill({ target, source, state: yield* inspectSkill(target, source), self: command, dir: options.skillDir !== undefined, selfKind: self.kind })

  const checks = [bunCheck, checkPath({ self, onPath, pathDirs, home, bunInstall, appVersion: APP_VERSION }), daemonCheck, skillCheck]
  return { ok: checks.every(item => item.status !== "problem"), version: APP_VERSION, build, cli: self, self: command, checks } satisfies DoctorReport
})
