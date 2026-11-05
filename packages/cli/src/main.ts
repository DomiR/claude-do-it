import { BunRuntime, BunServices } from "@effect/platform-bun"
import { ensureDaemon, stopDaemon, withClient, type DaemonInfo, type DoItClient } from "@do-it/client"
import { APP_VERSION, formatVersionHeader, type Author, type EditOp, type WatchEvent } from "@do-it/protocol"
import { Cause, Effect, Exit, Stream } from "effect"
import { CliConfig, CliOutput, Command } from "effect/cli"
import { openBrowser } from "./browser"
import { changeJson, changeReply, diffText, editReply, errorFields, errorMessage, errorTag, mismatchReply, rpcErrorCode, rpcExitCode, todosText, writeJson, writeLine } from "./output"
import { cliConfigFor, cliFormatter, cliPresenter, makeCli, normalizeArgv } from "./parser"
import { resolveText } from "./stdin"
import type { GlobalOptions, ParsedCommand } from "./types"

type Result = number

function outputText(options: GlobalOptions, text: string, json: unknown): void { options.json ? writeJson(json) : writeLine(text) }
function sameAgent(by: ReadonlyArray<Author>, name: string): boolean { return by.length > 0 && by.every(author => author._tag === "Agent" && author.name === name) }
function authorText(by: ReadonlyArray<Author>): string { return by.map(author => author._tag === "User" ? "the user" : author._tag === "File" ? "file" : author.name).join(", ") }
function rpc<A, E, R>(info: DaemonInfo, f: (client: DoItClient) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> { return withClient(info, f) }

function openCommand(command: Extract<ParsedCommand, { kind: "open" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const result = yield* rpc(info, client => client.open({ path: command.path, create: true }))
    if (!command.noBrowser) yield* Effect.sync(() => openBrowser(result.url))
    const path = command.options.json ? result.path : command.displayPath
    outputText(command.options, `Opened ${path} at version ${result.version}: ${result.url}`, { path, version: result.version, url: result.url, created: result.created })
    return 0
  })
}

function readCommand(command: Extract<ParsedCommand, { kind: "read" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const result = yield* rpc(info, client => client.read({ path: command.path, ...(command.section === undefined ? {} : { section: command.section }) }))
    if (command.options.json) writeJson({ version: result.version, text: result.text })
    else writeLine(`Version: ${result.version}\n${result.text}`.replace(/\n$/, ""))
    return 0
  })
}

function sectionsCommand(command: Extract<ParsedCommand, { kind: "sections" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const result = yield* rpc(info, client => client.sections({ path: command.path }))
    const text = [`Version: ${result.version}`, ...result.sections.map(section => `${section.id}  (${section.level}) ${section.title}`)].join("\n")
    outputText(command.options, text, { version: result.version, sections: result.sections })
    return 0
  })
}

function operation(command: Extract<ParsedCommand, { kind: "edit" | "append" | "todo-add" | "todo-set" | "todo-start" }>, text?: string): EditOp {
  if (command.kind === "edit") return { _tag: "Replace", old: command.old, new: command.next }
  if (command.kind === "append") return { _tag: "Append", text: text ?? command.text }
  if (command.kind === "todo-add") return { _tag: "TodoAdd", text: text ?? command.text }
  if (command.kind === "todo-start") {
    const target = /^[+]?\d+$/.test(command.target.trim()) ? Number(command.target.trim()) : command.target
    return { _tag: "TodoStart", target }
  }
  const target = /^[+]?\d+$/.test(command.target.trim()) ? Number(command.target.trim()) : command.target
  return { _tag: "TodoSet", target, state: command.state }
}

function editCommand(command: Extract<ParsedCommand, { kind: "edit" | "append" | "todo-add" | "todo-set" | "todo-start" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const text = command.kind === "append" || command.kind === "todo-add" ? yield* Effect.promise(() => resolveText(command.text)) : undefined
    const result = yield* rpc(info, client => client.edit({ path: command.path, author: { _tag: "Agent", name: command.options.as }, version: command.version,
      ...(command.section === undefined ? {} : { section: command.section }), op: operation(command, text) }))
    const reply = editReply(result)
    outputText(command.options, reply.text, reply.json)
    return 0
  })
}

function todoListCommand(command: Extract<ParsedCommand, { kind: "todo-list" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const result = yield* rpc(info, client => client.todos({ path: command.path, ...(command.section === undefined ? {} : { section: command.section }) }))
    const lines = result.todos.map(todo => `${todo.number}. [${todo.state === "done" ? "x" : todo.state === "cancelled" ? "-" : " "}] ${todo.text}`)
    outputText(command.options, [`Version: ${result.version}`, ...lines].join("\n"), { version: result.version, todos: result.todos })
    return 0
  })
}

function diffCommand(command: Extract<ParsedCommand, { kind: "diff" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const result = yield* rpc(info, client => client.diff({ path: command.path, since: command.since, wait: command.wait }))
    const text = diffText(formatVersionHeader(result.from, result.to, result.by), result.diff)
    outputText(command.options, text, { from: result.from, to: result.to, by: result.by, diff: result.diff, todos: result.todos })
    return 0
  })
}

function statusCommand(command: Extract<ParsedCommand, { kind: "status" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon({ spawn: false })
    const result = yield* rpc(info, client => client.status({}))
    const upSeconds = Math.floor(Math.max(0, Date.now() - result.startedAt) / 1000)
    const minutes = Math.floor(upSeconds / 60)
    if (command.options.json) writeJson({ pid: result.pid, port: result.port, startedAt: result.startedAt, appVersion: result.appVersion, documents: result.documents, upSeconds })
    else writeLine(`Daemon pid ${result.pid} on 127.0.0.1:${result.port}, up ${minutes}m\n${result.documents.map(document => `  ${document.path}  version ${document.version}  ${document.watchers} watchers`).join("\n")}`)
    return 0
  })
}

function stopCommand(command: Extract<ParsedCommand, { kind: "stop" }>) {
  return Effect.gen(function* () {
    const stopped = yield* stopDaemon()
    outputText(command.options, stopped ? "Stopped" : "Not running", { stopped })
    return 0
  })
}

function initialWatchOutput(command: Extract<ParsedCommand, { kind: "watch" }>, version: number): void {
  if (command.quiet) return
  if (command.options.json) writeJson({ event: "watching", version })
  else writeLine(`Watching ${command.displayPath} at version ${version}`)
}
function restartOutput(command: Extract<ParsedCommand, { kind: "watch" }>, version: number): void {
  if (command.options.json) writeJson({ event: "restarted", version })
  else writeLine(`Daemon restarted, now version ${version}`)
}
function resyncOutput(command: Extract<ParsedCommand, { kind: "watch" }>, version: number): void {
  if (command.options.json) writeJson({ event: "resync", version })
  else writeLine(`Missed changes, now at version ${version}: run do-it read`)
}
function deletedOutput(command: Extract<ParsedCommand, { kind: "watch" }>): void {
  if (command.options.json) writeJson({ event: "deleted" })
  else writeLine(`Deleted ${command.displayPath}`)
}

function watchCommand(command: Extract<ParsedCommand, { kind: "watch" }>) {
  return Effect.gen(function* () {
    let since = command.since
    let pid: number | undefined
    let first = true
    let announce = false
    let backoff = 250
    let deleted = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let settleVersion = 0
    let settleBy: string[] = []
    let lastFailure: string | undefined
    const cancelTimer = () => { if (timer) { clearTimeout(timer); timer = undefined } }
    const schedule = (version: number, by: ReadonlyArray<Author>) => {
      if (command.settle === undefined) return
      const authors = authorText(by).split(", ").filter(Boolean)
      const hadTimer = timer !== undefined
      cancelTimer(); settleVersion = version; settleBy = [...new Set(hadTimer ? [...settleBy, ...authors] : authors)]
      timer = setTimeout(() => { timer = undefined; const byText = settleBy.join(", "); if (command.options.json) writeJson({ event: "settled", version: settleVersion, by: settleBy }); else writeLine(`Settled at version ${settleVersion}${byText ? ` by ${byText}` : ""}`); settleBy = [] }, command.settle * 1000)
    }
    try {
      while (!deleted) {
        const daemon = yield* Effect.exit(ensureDaemon())
        if (Exit.isFailure(daemon)) {
          if (Cause.hasInterruptsOnly(daemon.cause)) break
          const failure = Cause.squash(daemon.cause)
          const tag = errorTag(failure)
          if (tag !== "DaemonUnavailable") {
            const message = errorMessage(failure)
            if (message !== lastFailure) outputText(command.options, `Watch failed: ${message}, retrying`, { event: "error", message })
            lastFailure = message
          } else lastFailure = undefined
          yield* Effect.sleep(`${backoff} millis`); backoff = Math.min(5000, backoff * 2); continue
        }
        const info = daemon.value
        if (pid !== undefined && pid !== info.pid) announce = true
        pid = info.pid
        const payload = { path: command.path, ...(since === undefined ? {} : { since }), ...(command.section === undefined ? {} : { section: command.section }), text: false }
        const exit = yield* Effect.exit(rpc(info, client => client.watch(payload).pipe(Stream.runForEach((event: WatchEvent) => Effect.sync(() => {
          lastFailure = undefined
          if (event._tag === "Watching") {
            backoff = 250
            if (first) { initialWatchOutput(command, event.version); first = false }
            else if (announce) { restartOutput(command, event.version); announce = false }
            since = event.version; return
          }
          if (event._tag === "Resync") { resyncOutput(command, event.version); if (command.settle !== undefined) schedule(event.version, []); since = event.version; announce = false; return }
          if (event._tag === "Deleted") { deletedOutput(command); deleted = true; return }
          since = event.to
          if (sameAgent(event.by, command.options.as)) return
          if (command.settle !== undefined) { schedule(event.to, event.by); return }
          if (command.todos) { if (!event.todos.length) return; if (command.options.json) writeJson(changeJson(event)); else writeLine(todosText(event.todos)) }
          else if (command.options.json) writeJson(changeJson(event))
          else writeLine(changeReply(event, false))
        })))))
        if (deleted) break
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterruptsOnly(exit.cause)) break
          const failure = Cause.squash(exit.cause)
          const tag = errorTag(failure)
          if (tag === "DocumentGone" || tag === "Refused") return errorResult(command, failure)
          if (tag !== "DaemonUnavailable" && tag !== "RpcClientError") {
            const message = errorMessage(failure)
            if (message !== lastFailure) outputText(command.options, `Watch failed: ${message}, retrying`, { event: "error", message })
            lastFailure = message
          } else lastFailure = undefined
        } else lastFailure = undefined
        yield* Effect.sleep(`${backoff} millis`)
        backoff = Math.min(5000, backoff * 2)
      }
      cancelTimer()
      return deleted ? 9 : 0
    } finally { cancelTimer() }
  })
}

function commandEffect(command: ParsedCommand) {
  switch (command.kind) {
    case "open": return openCommand(command)
    case "read": return readCommand(command)
    case "sections": return sectionsCommand(command)
    case "edit": case "append": case "todo-add": case "todo-set": case "todo-start": return editCommand(command)
    case "todo-list": return todoListCommand(command)
    case "diff": return diffCommand(command)
    case "watch": return watchCommand(command)
    case "status": return statusCommand(command)
    case "stop": return stopCommand(command)
  }
}

function errorResult(command: ParsedCommand, error: unknown): Result {
  const requested = ("version" in command ? command.version : "since" in command ? command.since : 0) ?? 0
  const tag = errorTag(error)
  if (command.kind === "status" && tag === "DaemonUnavailable") {
    if (command.options.json) writeJson({ error: { code: "DaemonUnavailable", message: "Not running" } })
    else writeLine("Not running")
    return 3
  }
  if (tag === "VersionMismatch" || tag === "Forgotten") {
    const reply = mismatchReply(error, requested); if (command.options.json) { const { kind: _kind, ...fields } = reply.json; writeJson({ error: { code: tag, message: reply.text, ...fields } }) } else writeLine(reply.text); return 1
  }
  const code = rpcExitCode(error)
  const message = tag === "NothingYet" && command.kind === "diff"
    ? `No change since version ${command.since} in ${command.wait} ${command.wait === 1 ? "second" : "seconds"}`
    : errorMessage(error)
  const fields = errorFields(error)
  if (command.options.json) writeJson({ error: { code: rpcErrorCode(error), message, ...fields } }); else writeLine(message)
  return code
}

function program() {
  let commandExit = 0
  const cli = makeCli(command => Effect.gen(function* () {
    const result = yield* Effect.exit(commandEffect(command))
    commandExit = Exit.isSuccess(result) ? result.value : errorResult(command, Cause.squash(result.cause))
  }))
  return Effect.gen(function* () {
    const input = normalizeArgv(process.argv.slice(2))
    const result = yield* Effect.exit(Command.runWith(cli, { version: APP_VERSION, renderErrors: true })(input).pipe(
      Effect.provide(BunServices.layer),
      Effect.provide(CliConfig.layer(cliConfigFor(input))),
      Effect.provide(CliOutput.layer(cliFormatter)),
      Effect.provide(cliPresenter),
    ))
    if (Exit.isFailure(result)) {
      const message = errorMessage(Cause.squash(result.cause))
      if (process.argv.includes("--json")) writeJson({ error: { code: "invalid", message } })
      else writeLine(message)
      return 2
    }
    return commandExit
  })
}

BunRuntime.runMain(program() as Effect.Effect<Result, never, never>, { disableErrorReporting: true, teardown: (exit, done) => done(Exit.isSuccess(exit) ? Number(exit.value) : 1) })
