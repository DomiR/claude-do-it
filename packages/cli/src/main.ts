import { BunRuntime, BunServices } from "@effect/platform-bun"
import { ensureDaemon, stopDaemon, withClient, type DaemonInfo, type DoItClient } from "@do-it/client"
import { APP_VERSION, formatVersionHeader, type Author, type EditOp, type WatchEvent } from "@do-it/protocol"
import { Cause, Duration, Effect, Exit, FiberHandle, Stdio, Stream } from "effect"
import { CliConfig, CliOutput, Command } from "effect/cli"
import { openBrowser } from "./browser"
import { changeJson, changeReply, diffText, editReply, errorFields, errorMessage, errorTag, mismatchReply, rpcErrorCode, rpcExitCode, todosText, writeJson, writeLine } from "./output"
import { cliConfigFor, cliFormatter, cliPresenter, makeCli, normalizeArgv } from "./parser"
import { installSkill, readSkill, skillSource } from "./skill"
import { endsLine } from "./settle"
import { resolveText } from "./stdin"
import type { GlobalOptions, ParsedCommand } from "./types"

type Result = number

function outputText(options: GlobalOptions, text: string, json: unknown): Effect.Effect<void> { return options.json ? writeJson(json) : writeLine(text) }
function sameAgent(by: ReadonlyArray<Author>, name: string): boolean { return by.length > 0 && by.every(author => author._tag === "Agent" && author.name === name) }
function authorText(by: ReadonlyArray<Author>): string { return by.map(author => author._tag === "User" ? "the user" : author._tag === "File" ? "file" : author.name).join(", ") }
function rpc<A, E, R>(info: DaemonInfo, f: (client: DoItClient) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> { return withClient(info, f) }

function openCommand(command: Extract<ParsedCommand, { kind: "open" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const result = yield* rpc(info, client => client.open({ path: command.path, create: true }))
    if (!command.noBrowser) yield* openBrowser(result.url)
    const path = command.options.json ? result.path : command.displayPath
    yield* outputText(command.options, `Opened ${path} at version ${result.version}: ${result.url}`, { path, version: result.version, url: result.url, created: result.created })
    return 0
  })
}

function readCommand(command: Extract<ParsedCommand, { kind: "read" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const result = yield* rpc(info, client => client.read({ path: command.path, ...(command.section === undefined ? {} : { section: command.section }) }))
    if (command.options.json) yield* writeJson({ version: result.version, text: result.text })
    else yield* writeLine(`Version: ${result.version}\n${result.text}`.replace(/\n$/, ""))
    return 0
  })
}

function sectionsCommand(command: Extract<ParsedCommand, { kind: "sections" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const result = yield* rpc(info, client => client.sections({ path: command.path }))
    const text = [`Version: ${result.version}`, ...result.sections.map(section => `${section.id}  (${section.level}) ${section.title}`)].join("\n")
    yield* outputText(command.options, text, { version: result.version, sections: result.sections })
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
    const text = command.kind === "append" || command.kind === "todo-add" ? yield* resolveText(command.text) : undefined
    const result = yield* rpc(info, client => client.edit({ path: command.path, author: { _tag: "Agent", name: command.options.as }, version: command.version,
      ...(command.section === undefined ? {} : { section: command.section }), op: operation(command, text) }))
    const reply = editReply(result)
    yield* outputText(command.options, reply.text, reply.json)
    return 0
  })
}

function todoListCommand(command: Extract<ParsedCommand, { kind: "todo-list" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const result = yield* rpc(info, client => client.todos({ path: command.path, ...(command.section === undefined ? {} : { section: command.section }) }))
    const lines = result.todos.map(todo => `${todo.number}. [${todo.state === "done" ? "x" : todo.state === "cancelled" ? "-" : " "}] ${todo.text}`)
    yield* outputText(command.options, [`Version: ${result.version}`, ...lines].join("\n"), { version: result.version, todos: result.todos })
    return 0
  })
}

function diffCommand(command: Extract<ParsedCommand, { kind: "diff" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon()
    const result = yield* rpc(info, client => client.diff({ path: command.path, since: command.since, wait: command.wait }))
    const text = diffText(formatVersionHeader(result.from, result.to, result.by), result.diff)
    yield* outputText(command.options, text, { from: result.from, to: result.to, by: result.by, diff: result.diff, todos: result.todos })
    return 0
  })
}

function statusCommand(command: Extract<ParsedCommand, { kind: "status" }>) {
  return Effect.gen(function* () {
    const info = yield* ensureDaemon({ spawn: false })
    const result = yield* rpc(info, client => client.status({}))
    const upSeconds = Math.floor(Math.max(0, Date.now() - result.startedAt) / 1000)
    const minutes = Math.floor(upSeconds / 60)
    if (command.options.json) yield* writeJson({ pid: result.pid, port: result.port, startedAt: result.startedAt, appVersion: result.appVersion, documents: result.documents, upSeconds })
    else yield* writeLine(`Daemon pid ${result.pid} on 127.0.0.1:${result.port}, up ${minutes}m\n${result.documents.map(document => `  ${document.path}  version ${document.version}  ${document.watchers} watchers`).join("\n")}`)
    return 0
  })
}

function stopCommand(command: Extract<ParsedCommand, { kind: "stop" }>) {
  return Effect.gen(function* () {
    const stopped = yield* stopDaemon()
    yield* outputText(command.options, stopped ? "Stopped" : "Not running", { stopped })
    return 0
  })
}

function skillInstallCommand(command: Extract<ParsedCommand, { kind: "skill-install" }>) {
  return Effect.gen(function* () {
    const result = yield* installSkill(command.dir, command.force)
    if (result.kind === "occupied") {
      yield* outputText(command.options, `${result.path} already exists and was not installed by do-it. Pass --force to replace it.`,
        { error: { code: "Refused", message: "The skill directory already exists", path: result.path } })
      return 1
    }
    const text = result.kind === "linked"
      ? `${result.path} already links to this skill.`
      : `${result.replaced ? "Updated" : "Installed"} the do-it skill in ${result.path}. In Claude Code, run /do-it to start.`
    yield* outputText(command.options, text, { kind: result.kind, path: result.path })
    return 0
  })
}

function skillPathCommand(command: Extract<ParsedCommand, { kind: "skill-path" }>) {
  return Effect.gen(function* () {
    const path = yield* skillSource
    yield* outputText(command.options, path, { path })
    return 0
  })
}

function skillShowCommand(command: Extract<ParsedCommand, { kind: "skill-show" }>) {
  return Effect.gen(function* () {
    const skill = yield* readSkill
    yield* outputText(command.options, skill.content, skill)
    return 0
  })
}

function initialWatchOutput(command: Extract<ParsedCommand, { kind: "watch" }>, version: number): Effect.Effect<void> {
  if (command.quiet) return Effect.void
  return outputText(command.options, `Watching ${command.displayPath} at version ${version}`, { event: "watching", version })
}
function restartOutput(command: Extract<ParsedCommand, { kind: "watch" }>, version: number): Effect.Effect<void> {
  return outputText(command.options, `Daemon restarted, now version ${version}`, { event: "restarted", version })
}
function resyncOutput(command: Extract<ParsedCommand, { kind: "watch" }>, version: number): Effect.Effect<void> {
  return outputText(command.options, `Missed changes, now at version ${version}: run do-it read`, { event: "resync", version })
}
function deletedOutput(command: Extract<ParsedCommand, { kind: "watch" }>): Effect.Effect<void> {
  return outputText(command.options, `Deleted ${command.displayPath}`, { event: "deleted" })
}

function watchCommand(command: Extract<ParsedCommand, { kind: "watch" }>) {
  return Effect.scoped(Effect.gen(function* () {
    let since = command.since
    let pid: number | undefined
    let first = true
    let announce = false
    let backoff = 250
    let deleted = false
    let lastFailure: string | undefined
    // The settle timer: a quiet period after the last change, then one "settled" line.
    // When the person's latest change ends a line, the quiet period is --settle-line.
    const timer = yield* FiberHandle.make<void, never>()
    let pending = false
    let settleVersion = 0
    let settleBy: string[] = []
    let lineEnded = false
    let lastText: string | undefined
    const settled = (delay: Duration.Duration, reason: "line" | "quiet") => Effect.sleep(delay).pipe(Effect.andThen(Effect.uninterruptible(Effect.suspend(() => {
      // Taking and resetting the state is one synchronous step, so a change
      // that arrives while the line is written starts a fresh settle period.
      const version = settleVersion
      const by = settleBy
      pending = false
      settleBy = []
      lineEnded = false
      const byText = by.join(", ")
      return outputText(command.options, `Settled at version ${version}${byText ? ` by ${byText}` : ""}`, { event: "settled", version, by, reason })
    }))))
    const schedule = (version: number, by: ReadonlyArray<Author>) => Effect.suspend(() => {
      if (command.settle === undefined) return Effect.void
      const authors = authorText(by).split(", ").filter(Boolean)
      settleVersion = version
      settleBy = [...new Set(pending ? [...settleBy, ...authors] : authors)]
      pending = true
      const short = lineEnded && command.settleLine < command.settle
      return FiberHandle.run(timer, settled(Duration.millis((short ? command.settleLine : command.settle) * 1000), short ? "line" : "quiet")).pipe(Effect.asVoid)
    })
    while (!deleted) {
      const daemon = yield* Effect.exit(ensureDaemon())
      if (Exit.isFailure(daemon)) {
        if (Cause.hasInterruptsOnly(daemon.cause)) break
        const failure = Cause.squash(daemon.cause)
        const tag = errorTag(failure)
        if (tag !== "DaemonUnavailable") {
          const message = errorMessage(failure)
          if (message !== lastFailure) yield* outputText(command.options, `Watch failed: ${message}, retrying`, { event: "error", message })
          lastFailure = message
        } else lastFailure = undefined
        yield* Effect.sleep(`${backoff} millis`); backoff = Math.min(5000, backoff * 2); continue
      }
      const info = daemon.value
      if (pid !== undefined && pid !== info.pid) announce = true
      pid = info.pid
      const payload = { path: command.path, ...(since === undefined ? {} : { since }), ...(command.section === undefined ? {} : { section: command.section }), text: command.settle !== undefined }
      const exit = yield* Effect.exit(rpc(info, client => client.watch(payload).pipe(Stream.runForEach((event: WatchEvent) => Effect.gen(function* () {
        lastFailure = undefined
        if (event._tag === "Watching") {
          backoff = 250
          if (first) { yield* initialWatchOutput(command, event.version); first = false }
          else if (announce) { yield* restartOutput(command, event.version); announce = false }
          // A resumed watch's Watching can be ahead of the Change that follows it.
          if (lastText === undefined) lastText = event.text
          since = event.version; return
        }
        if (event._tag === "Resync") { lastText = event.text; lineEnded = false; yield* resyncOutput(command, event.version); if (command.settle !== undefined) yield* schedule(event.version, []); since = event.version; announce = false; return }
        if (event._tag === "Deleted") { yield* deletedOutput(command); deleted = true; return }
        since = event.to
        const before = lastText
        lastText = event.text
        if (sameAgent(event.by, command.options.as)) return
        // Agent changes keep the mode of the person's pending change.
        if (event.by.some(author => author._tag !== "Agent")) lineEnded = before !== undefined && event.text !== undefined && endsLine(before, event.text)
        if (command.settle !== undefined) { yield* schedule(event.to, event.by); return }
        if (command.todos) { if (!event.todos.length) return; if (command.options.json) yield* writeJson(changeJson(event)); else yield* writeLine(todosText(event.todos)) }
        else if (command.options.json) yield* writeJson(changeJson(event))
        else yield* writeLine(changeReply(event, false))
      })))))
      if (deleted) break
      if (Exit.isFailure(exit)) {
        if (Cause.hasInterruptsOnly(exit.cause)) break
        const failure = Cause.squash(exit.cause)
        const tag = errorTag(failure)
        if (tag === "DocumentGone" || tag === "Refused") return yield* errorResult(command, failure)
        if (tag !== "DaemonUnavailable" && tag !== "RpcClientError") {
          const message = errorMessage(failure)
          if (message !== lastFailure) yield* outputText(command.options, `Watch failed: ${message}, retrying`, { event: "error", message })
          lastFailure = message
        } else lastFailure = undefined
      } else lastFailure = undefined
      yield* Effect.sleep(`${backoff} millis`)
      backoff = Math.min(5000, backoff * 2)
    }
    // Closing the scope also interrupts a pending settle timer.
    return deleted ? 9 : 0
  }))
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
    case "skill-install": return skillInstallCommand(command)
    case "skill-path": return skillPathCommand(command)
    case "skill-show": return skillShowCommand(command)
  }
}

function errorResult(command: ParsedCommand, error: unknown): Effect.Effect<Result> {
  return Effect.gen(function* () {
    const requested = ("version" in command ? command.version : "since" in command ? command.since : 0) ?? 0
    const tag = errorTag(error)
    if (command.kind === "status" && tag === "DaemonUnavailable") {
      yield* outputText(command.options, "Not running", { error: { code: "DaemonUnavailable", message: "Not running" } })
      return 3
    }
    if (tag === "VersionMismatch" || tag === "Forgotten") {
      const reply = mismatchReply(error, requested)
      const { kind: _kind, ...fields } = reply.json
      yield* outputText(command.options, reply.text, { error: { code: tag, message: reply.text, ...fields } })
      return 1
    }
    const code = rpcExitCode(error)
    const message = tag === "NothingYet" && command.kind === "diff"
      ? `No change since version ${command.since} in ${command.wait} ${command.wait === 1 ? "second" : "seconds"}`
      : errorMessage(error)
    const fields = errorFields(error)
    yield* outputText(command.options, message, { error: { code: rpcErrorCode(error), message, ...fields } })
    return code
  })
}

function program() {
  let commandExit = 0
  const cli = makeCli(command => Effect.gen(function* () {
    const result = yield* Effect.exit(commandEffect(command))
    commandExit = Exit.isSuccess(result) ? result.value : yield* errorResult(command, Cause.squash(result.cause))
  }))
  return Effect.gen(function* () {
    const args = yield* (yield* Stdio.Stdio).args
    const input = normalizeArgv(args)
    const result = yield* Effect.exit(Command.runWith(cli, { version: APP_VERSION, renderErrors: true })(input).pipe(
      Effect.provide(CliConfig.layer(cliConfigFor(input))),
      Effect.provide(CliOutput.layer(cliFormatter)),
      Effect.provide(cliPresenter),
    ))
    if (Exit.isFailure(result)) {
      const message = errorMessage(Cause.squash(result.cause))
      if (args.includes("--json")) yield* writeJson({ error: { code: "invalid", message } })
      else yield* writeLine(message)
      return 2
    }
    return commandExit
  }).pipe(Effect.provide(BunServices.layer))
}

const main: Effect.Effect<Result, never, never> = program()
BunRuntime.runMain(main, { disableErrorReporting: true, teardown: (exit, done) => done(Exit.isSuccess(exit) ? Number(exit.value) : 1) })
