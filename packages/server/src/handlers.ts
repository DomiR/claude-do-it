import { addTodo, appendBlock, findSection, findTodo, replaceUnique, sections, setTodoStateStamped, stampTodo, todos, type Origin } from "@do-it/doc"
import { DoItRpcs, DocumentGone, Forgotten, NothingYet, type Author, type DiffSuccess, type WatchEvent, type WatchPayload } from "@do-it/protocol"
import { Cause, Deferred, Effect, Stream } from "effect"
import { Auth } from "./auth"
import { APP_VERSION } from "./config"
import { Documents, DocumentRegistry, rpcTry, type OpenDocument } from "./documents"

export interface RuntimeInfo { port: number; startedAt: number; stop: Effect.Effect<void> }
export function author(origin: Origin): Author {
  return origin.kind === "agent" ? { _tag: "Agent", name: origin.name }
    : origin.kind === "user" ? { _tag: "User" } : { _tag: "File" }
}
function origin(by: Author): Origin {
  return by._tag === "Agent" ? { kind: "agent", name: by.name } : { kind: by._tag === "User" ? "user" : "file" }
}
function changes(entry: OpenDocument, since: number, section?: string): DiffSuccess | null {
  const result = entry.doc.changes(since, section)
  return result ? { ...result, by: result.by.map(author) } : null
}

/** One pull reads the newest document version. There is no subscriber queue. */
export function watchDocument(registry: DocumentRegistry, request: WatchPayload) {
  return Stream.fromPull(Effect.gen(function* () {
    // The subscription keeps the entry open once the stream exists.
    const { entry, release } = yield* registry.withEntry(request.path, entry => Effect.gen(function* () {
      if (request.section !== undefined) yield* rpcTry(() => findSection(entry.doc.text, request.section!))
      return { entry, release: yield* rpcTry(() => registry.subscribe(entry)) }
    }))
    yield* Effect.addFinalizer(() => Effect.sync(release))
    let first = true
    let ended = false
    let since = request.since ?? entry.doc.version
    const pull: Effect.Effect<readonly [WatchEvent], Cause.Done> = Effect.gen(function* () {
      if (ended) return yield* Cause.done()
      while (true) {
        const signal = entry.signal
        if (first) {
          first = false
          const resync = request.since !== undefined && (since > entry.doc.version || since < entry.doc.version && entry.doc.textAt(since) === null)
          if (request.since === undefined || resync) since = entry.doc.version
          return [{ _tag: resync ? "Resync" : "Watching", version: entry.doc.version,
            ...(request.text ? { text: entry.doc.text } : {}) } satisfies WatchEvent] as const
        }
        if (entry.deleted) { ended = true; return [{ _tag: "Deleted" } satisfies WatchEvent] as const }
        if (entry.doc.version > since) {
          const result = changes(entry, since, request.section)
          since = entry.doc.version
          const event: WatchEvent = result
            ? { _tag: "Change", ...result, ...(request.text ? { text: entry.doc.text } : {}) }
            : { _tag: "Resync", version: since, ...(request.text ? { text: entry.doc.text } : {}) }
          return [event] as const
        }
        yield* Deferred.await(signal)
      }
    })
    return pull
  }))
}

export function HandlersLive(auth: Auth, runtime: RuntimeInfo) {
  return DoItRpcs.toLayer(Effect.gen(function* () {
    const registry = yield* Documents
    return {
      status: Effect.fn("rpc.status")(function* () {
        return { pid: process.pid, appVersion: APP_VERSION, port: runtime.port, startedAt: runtime.startedAt, documents: registry.status() }
      }),
      stop: Effect.fn("rpc.stop")(function* () { yield* runtime.stop; return {} }),
      open: request => registry.withOpened(request.path, ({ entry, created }) => Effect.gen(function* () {
        const version = entry.doc.version
        const code = yield* auth.mint(entry.path)
        return { path: entry.path, version, created,
          url: `http://127.0.0.1:${runtime.port}/auth?code=${code}&path=${encodeURIComponent(entry.path)}` }
      }), request.create).pipe(Effect.withSpan("rpc.open")),
      read: request => registry.withEntry(request.path, entry => rpcTry(() => {
        const scope = request.section === undefined ? null : findSection(entry.doc.text, request.section)
        return { version: entry.doc.version, text: scope ? entry.doc.text.slice(scope.from, scope.to) : entry.doc.text }
      })).pipe(Effect.withSpan("rpc.read")),
      sections: request => registry.withEntry(request.path, entry => Effect.sync(() => ({ version: entry.doc.version,
        sections: sections(entry.doc.text).map(({ id, title, level, line }) => ({ id, title, level, line })) }))).pipe(Effect.withSpan("rpc.sections")),
      todos: request => registry.withEntry(request.path, entry => rpcTry(() => {
        const all = todos(entry.doc.text)
        if (request.section === undefined) return { version: entry.doc.version, todos: all }
        const scope = findSection(entry.doc.text, request.section)
        const following = sections(entry.doc.text).find(section => section.from === scope.to)?.line ?? Infinity
        return { version: entry.doc.version, todos: all.filter(todo => todo.line >= scope.line && todo.line < following) }
      })).pipe(Effect.withSpan("rpc.todos")),
      edit: request => registry.withEntry(request.path, entry => Effect.gen(function* () {
        const previous = entry.doc.version
        const result = yield* rpcTry(() => entry.doc.agentEdit(origin(request.author), { version: request.version, section: request.section }, text => {
          const op = request.op
          switch (op._tag) {
            case "Replace": return replaceUnique(text, op.old, op.new, request.section)
            case "Append": return appendBlock(text, op.text, request.section)
            case "TodoAdd": return addTodo(text, op.text, request.section)
            case "TodoSet": return setTodoStateStamped(text, findTodo(text, op.target, request.section), op.state, new Date())
            case "TodoStart": return stampTodo(text, findTodo(text, op.target, request.section), "started", new Date())
          }
        }), () => entry.doc.version)
        yield* registry.changed(entry, previous)
        return { ...result, section: request.section ?? null }
      })).pipe(Effect.withSpan("rpc.edit")),
      sync: request => registry.withEntry(request.path, entry => Effect.gen(function* () {
        const previous = entry.doc.version
        yield* rpcTry(() => entry.doc.userEdit(request.base, request.text), () => entry.doc.version)
        // Read the reply before yielding: a deleted file frees the document.
        const reply = { version: entry.doc.version, text: entry.doc.text }
        yield* registry.changed(entry, previous)
        return reply
      })).pipe(Effect.withSpan("rpc.sync")),
      diff: request => registry.withEntry(request.path, entry => Effect.gen(function* () {
        const deadline = Date.now() + request.wait * 1000
        while (true) {
          const signal = entry.signal
          if (entry.deleted) return yield* Effect.fail(new DocumentGone({ path: entry.path }))
          const result = changes(entry, request.since)
          if (!result) return yield* Effect.fail(new Forgotten({ latest: entry.doc.version }))
          if (entry.doc.version !== request.since) return result
          const remaining = deadline - Date.now()
          if (remaining <= 0) return yield* Effect.fail(new NothingYet({}))
          yield* Deferred.await(signal).pipe(Effect.timeoutOption(remaining))
        }
      })).pipe(Effect.withSpan("rpc.diff")),
      watch: request => watchDocument(registry, request),
    }
  }))
}
