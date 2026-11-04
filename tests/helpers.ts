import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface CliResult { code: number; stdout: string; stderr: string }

const repo = join(import.meta.dir, "..")

export function makeFixture(): { root: string; home: string; file: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "do-it-e2e-"))
  const home = join(root, "home")
  return { root, home, file: join(root, "TODO.md"), env: { DO_IT_HOME: home, DO_IT_PORT: "0", DO_IT_BROWSER: "true" } }
}

export async function runCli(args: ReadonlyArray<string>, env: Record<string, string>, input?: string): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, "packages/cli/src/bin.ts", ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdin: input === undefined ? undefined : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, stdout, stderr }
}

export async function startCli(args: ReadonlyArray<string>, env: Record<string, string>): Promise<ReturnType<typeof Bun.spawn>> {
  return Bun.spawn([process.execPath, "packages/cli/src/bin.ts", ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
}

export async function readLines(child: ReturnType<typeof Bun.spawn>): Promise<AsyncGenerator<string>> {
  const stream = child.stdout
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  return (async function* () {
    let pending = ""
    while (true) {
      const part = await reader.read()
      if (part.done) { if (pending) yield pending; return }
      pending += decoder.decode(part.value, { stream: true })
      const lines = pending.split("\n")
      pending = lines.pop()!
      for (const line of lines) if (line) yield line
    }
  })()
}

export function writeDocument(path: string, text: string): void { writeFileSync(path, text) }
export function diskText(path: string): string { return readFileSync(path, "utf8") }
export function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
export function jsonLine<T>(result: CliResult): T { return JSON.parse(result.stdout.trim()) as T }
