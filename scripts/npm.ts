/**
 * Builds the npm package in dist/npm: the CLI and the daemon bundled for Bun,
 * the built web app, and the Claude Code skill. Third party packages stay
 * external and become the package's dependencies (loro-crdt loads its wasm
 * from its own directory, so it cannot be bundled).
 *
 *   bun scripts/npm.ts            build
 *   cd dist/npm && npm publish    publish
 */
import { $ } from "bun"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { APP_VERSION } from "../packages/protocol/src"

const root = join(import.meta.dir, "..")
const out = join(root, "dist", "npm")
const runtime = ["cli", "client", "server", "doc", "protocol"]

const dependencies: Record<string, string> = {}
for (const name of runtime) {
  const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"))
  for (const [dependency, version] of Object.entries<string>(manifest.dependencies ?? {})) {
    if (version.startsWith("workspace:")) continue
    if (dependencies[dependency] && dependencies[dependency] !== version) throw new Error(`${dependency} has two versions: ${dependencies[dependency]} and ${version}`)
    dependencies[dependency] = version
  }
}
const external = Object.keys(dependencies).flatMap(name => [name, `${name}/*`])

await rm(out, { recursive: true, force: true })
await mkdir(join(out, "bin"), { recursive: true })
await $`bun run build:web`.cwd(root).quiet()

const bundles = [
  { entry: "packages/cli/src/bin.ts", name: "do-it.js", define: { DO_IT_DAEMON_ENTRY: JSON.stringify("./daemon.js"), DO_IT_SKILL_ROOT: JSON.stringify("../skill") } },
  { entry: "packages/server/src/main.ts", name: "daemon.js", define: { DO_IT_WEB_ROOT: JSON.stringify("../web") } },
]
for (const bundle of bundles) {
  const result = await Bun.build({ entrypoints: [join(root, bundle.entry)], outdir: join(out, "bin"), naming: bundle.name,
    target: "bun", external, define: bundle.define })
  if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1) }
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
  engines: { bun: ">=1.3" },
  os: ["darwin", "linux"],
  dependencies,
}
await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Built claude-do-it ${APP_VERSION} in ${out}`)
