/**
 * Builds the npm package in dist/npm: the CLI and the daemon bundled and minified for Bun,
 * the built web app, and the Claude Code skill. Third party packages stay
 * external and become the package's dependencies (loro-crdt loads its wasm
 * from its own directory, so it cannot be bundled).
 *
 *   bun scripts/npm.ts            build
 *   git tag v<APP_VERSION>        publish: the Release workflow does it, see
 *                                 .github/workflows/release.yml
 */
import { $ } from "bun"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { APP_VERSION, MIN_BUN_VERSION } from "../packages/protocol/src"

const root = join(import.meta.dir, "..")
const out = join(root, "dist", "npm")
const runtime = ["cli", "client", "server", "doc", "protocol"]

// `catalog:` versions resolve through the root catalog, so dist/npm gets real versions.
const catalog: Record<string, string> = JSON.parse(await readFile(join(root, "package.json"), "utf8")).catalog ?? {}
const dependencies: Record<string, string> = {}
for (const name of runtime) {
  const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"))
  for (const [dependency, declared] of Object.entries<string>(manifest.dependencies ?? {})) {
    if (declared.startsWith("workspace:")) continue
    const version = declared === "catalog:" ? catalog[dependency] : declared
    if (!version || version.startsWith("catalog:")) throw new Error(`${dependency} in packages/${name} has no version in the root catalog`)
    if (dependencies[dependency] && dependencies[dependency] !== version) throw new Error(`${dependency} has two versions: ${dependencies[dependency]} and ${version}`)
    dependencies[dependency] = version
  }
}
const external = Object.keys(dependencies).flatMap(name => [name, `${name}/*`])

// The CLI and the daemon of one build share this id, so `do-it doctor` can
// tell a daemon from another build of the same version.
const sha = (await $`git rev-parse --short HEAD`.cwd(root).nothrow().quiet().text()).trim() || "nogit"
const dirty = (await $`git status --porcelain --untracked-files=no`.cwd(root).nothrow().quiet().text()).trim() !== ""
const build = `${sha}${dirty ? "+dirty" : ""}.${Date.now().toString(36)}`

await rm(out, { recursive: true, force: true })
await mkdir(join(out, "bin"), { recursive: true })
await $`bun run build:web`.cwd(root).quiet()

const bundles = [
  { entry: "packages/cli/src/bin.ts", name: "do-it.js", define: { DO_IT_DAEMON_ENTRY: JSON.stringify("./daemon.js"), DO_IT_SKILL_ROOT: JSON.stringify("../skill"), DO_IT_BUILD: JSON.stringify(build) } },
  { entry: "packages/server/src/main.ts", name: "daemon.js", define: { DO_IT_WEB_ROOT: JSON.stringify("../web"), DO_IT_BUILD: JSON.stringify(build) } },
]
for (const bundle of bundles) {
  const result = await Bun.build({ entrypoints: [join(root, bundle.entry)], outdir: join(out, "bin"), naming: bundle.name,
    target: "bun", external, minify: true, define: { "process.env.NODE_ENV": JSON.stringify("production"), ...bundle.define } })
  if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1) }
  // Without the define a bundle would report a `source:` build of a path that does not exist.
  if (!(await readFile(join(out, "bin", bundle.name), "utf8")).includes(build)) throw new Error(`${bundle.name} does not contain the build id ${build}`)
}
const cli = join(out, "bin", "do-it.js")
const code = await readFile(cli, "utf8")
if (!code.startsWith("#!")) await writeFile(cli, `#!/usr/bin/env bun\n${code}`)
await $`chmod 755 ${cli}`

await cp(join(root, "packages", "web", "dist"), join(out, "web"), { recursive: true })
await cp(join(root, "skill"), join(out, "skill"), { recursive: true })
for (const file of ["README.md", "LICENSE", "NOTICE"]) await cp(join(root, file), join(out, file))

const manifest = {
  name: "claude-do-it",
  version: APP_VERSION,
  description: "A Markdown todo that you and Claude edit at the same time: a CRDT daemon, a versioned CLI for agents, a browser editor, and a Claude Code skill.",
  keywords: ["claude", "claude-code", "agents", "todo", "markdown", "crdt", "cli"],
  license: "MIT",
  author: "Dominique Rau",
  homepage: "https://github.com/DomiR/claude-do-it#readme",
  repository: { type: "git", url: "git+https://github.com/DomiR/claude-do-it.git" },
  bugs: { url: "https://github.com/DomiR/claude-do-it/issues" },
  type: "module",
  bin: { "do-it": "bin/do-it.js" },
  files: ["bin", "web", "skill", "NOTICE"],
  engines: { bun: `>=${MIN_BUN_VERSION}` },
  os: ["darwin", "linux"],
  dependencies,
}
await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Built claude-do-it ${APP_VERSION} (build ${build}) in ${out}`)
