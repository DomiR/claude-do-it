# claude-do-it design (v1)

The contract every package is built against. [plan.md](plan.md) says what and
why; this file says exactly how. Herdr's `herdr-doc` crate
(`/Users/domir/Developer/herdr-gpui/crates/herdr-doc/src`, read only) is the
reference implementation of the document model; where this file is silent,
copy Herdr.

## Names

- Binary: `do-it` (not `do`: `do` is a reserved word in bash and zsh, so
  `do read x` is a parse error). Skill: `do-it`. Packages: `@do-it/<name>`.
- State directory: `$DO_IT_HOME`, default `~/.do-it`. Holds `daemon.json`,
  `daemon.lock/`, `daemon.log`, `versions.json`, `runs/<slug>/`.

## Repository layout

```
package.json            bun workspaces, root scripts, bin do-it -> packages/cli/src/bin.ts
tsconfig.base.json      strict, ESNext, moduleResolution bundler, noUncheckedIndexedAccess
scripts/serial          runs one heavy command at a time (mkdir lock in $TMPDIR)
packages/doc            pure document model (loro-crdt), no Effect services, no transport
packages/protocol       Effect Schemas and the RpcGroup, no transport, no loro
packages/client         Bun side: daemon lifecycle (ensure, spawn, stop) and the RPC client layer
packages/server         the daemon: HTTP, RPC handlers, document registry, file watching, static web
packages/cli            the do-it command (effect/unstable/cli)
packages/web            Foldkit editor, built by Vite to packages/web/dist, served by the daemon
packages/tui            stub (README only) for phase 4
skill/SKILL.md          the do-it Claude Code skill
tests/                  end to end tests that spawn the daemon and the CLI
repos/                  gitignored reference clones (foldkit@0.170.0, docket, behold, effect-solutions)
```

TypeScript packages are consumed as source (`exports: { ".": "./src/index.ts" }`);
only `web` has a build. Pinned exactly: `effect` 4.1.2, `@effect/platform-bun`
4.1.2, `@effect/platform-browser` 4.1.2, `loro-crdt` 1.17.1, `foldkit` 0.170.0,
`@foldkit/vite-plugin` 0.29.0, `diff` 9.0.0. Tests: `bun test`.

## Document model (`packages/doc`)

Indices are JavaScript string indices (UTF-16 code units) everywhere in the
public API. loro-crdt's JS `LoroText` already uses UTF-16 indices; a test with
emoji and CJK proves it rather than a conversion layer.

```ts
type Version = number                       // 1 when opened, +1 per change by anyone
type Origin =
  | { readonly kind: "user" }               // browser or TUI
  | { readonly kind: "agent"; readonly name: string }
  | { readonly kind: "file" }               // another program wrote the file
const describeOrigin: (o: Origin) => string // "the user" | name | "file"

const MAX_BYTES = 2 * 1024 * 1024           // largest document (UTF-8 bytes)
const KEPT = 512                            // versions kept in the history ring
const MAX_DIFF = 64 * 1024                  // largest diff a reply carries
const MAX_ITEM = 4096                       // longest task text

interface Edit { readonly from: number; readonly to: number; readonly insert: string }

class DocError extends Data.TaggedError("DocError")<{
  readonly code: "conflict" | "forgotten" | "not-found" | "ambiguous" | "too-large" | "invalid"
  readonly message: string
  readonly conflict?: Conflict
}> {}

interface Conflict {
  readonly expected: Version
  readonly current: Version
  readonly diff: string | null              // null: version forgotten or diff over MAX_DIFF
  readonly forgotten: boolean
}

interface Applied {
  readonly version: Version                 // the new version (unchanged when nothing changed)
  readonly changed: boolean
  readonly others: { readonly since: Version; readonly diff: string | null } | null
}

interface Changes {
  readonly from: Version
  readonly to: Version
  readonly by: ReadonlyArray<Origin>        // who made the versions in between, each once, in order
  readonly diff: string | null              // of the section alone when one was named
  readonly todos: ReadonlyArray<TodoChange>
}

class Document {
  static open(text: string, version?: Version): Document   // synced with disk, history = [version]
  get text(): string
  get version(): Version
  get synced(): { text: string; version: Version }

  // Agents. Strict: scope.version must be the current version, or scope.section
  // must name a section whose text is identical now and at scope.version (then
  // the edit applies and `others` carries the full diff since scope.version).
  // Otherwise throws DocError("conflict"). `make` computes edits from the
  // CURRENT text. Applied on a fork of the current state, imported.
  agentEdit(origin: Origin, scope: { version: Version; section?: string },
            make: (text: string) => ReadonlyArray<Edit>): Applied

  // The person (browser, TUI). Never refused for being stale. When base is the
  // current version, `LoroText.update(text)` runs on the main doc with its own
  // stable peer, no fork (Herdr Document::edit). When base is older, fork at
  // base's frontiers (fresh peer), `update(text)` there, export, import, free
  // the fork: concurrent agent, file, and other user edits survive.
  // Throws DocError("forgotten") when base is no longer kept.
  userEdit(base: Version, text: string): Applied

  // Another program changed the file (Herdr merge_disk). When the synced
  // frontiers are the current ones, update the main doc directly; otherwise
  // fork at the synced frontiers (fresh peer), `update(diskText)`, import.
  // Returns false when the disk text is the synced text, the current text, or
  // one of the document's own writes in flight (no version taken).
  mergeFile(diskText: string): boolean

  // Disk write protocol (Herdr to_write / wrote / not_written): at most 8
  // writes in flight are remembered so their echo is recognised.
  get dirty(): boolean
  toWrite(): WriteTicket                    // opaque snapshot: text, frontiers, version
  wrote(ticket: WriteTicket): void
  notWritten(ticket: WriteTicket): void

  textAt(version: Version): string | null
  changes(since: Version, section?: string): Changes | null   // null when forgotten
  origin(version: Version): Origin | null   // who made that version

  // Bounded history: rebuild from the current text (as Herdr compact) when the
  // oplog passes 50k ops or 256 peers and nothing waits to be written. Keeps
  // text and version; older diffs are forgotten.
  compact(): boolean
}
```

Rules copied from Herdr:

- Every change by anyone takes exactly the next version and records
  `(version, frontiers, origin)` in a ring of `KEPT`.
- Forks at an old frontier (`userEdit`, `mergeFile`) always use a fresh random
  peer, never a reused one (a reused peer at an old frontier duplicates op ids);
  the first test asserts `forkAt` gives a new peer. Agent edits fork the
  current state and may reuse a stable per agent peer (Herdr does).
- Every temporary fork (`textAt`, `changes`, merges) is `.free()`d after use:
  wasm memory otherwise shrinks only at GC. `changes` runs per watcher per wake,
  so keep it cheap (one `textAt` per call).
- `unified(old, new, from, to)`: line diff, context 2, headers `--- N` and
  `+++ M`, `null` over `MAX_DIFF`. Use the `diff` package.
- Edits that change nothing take no version (`changed: false`).
- Everything over a cap throws `DocError("too-large")`; nothing is truncated.

Text operations, pure functions over a string, each returning `Edit`s or
throwing `DocError`:

```ts
interface Section { id: string; title: string; level: 1 | 2 | 3; line: number; from: number; to: number }
sections(text): Section[]                   // #, ##, ### outside fenced code; GitHub slug; repeats -1, -2
findSection(text, id): Section              // not-found
sectionText(text, id): string | null

type TaskState = "open" | "done" | "cancelled"   // - [ ], - [x]/[X], - [-]
interface Todo { number: number; line: number; state: TaskState; text: string; indent: number; section: string | null }
todos(text): Todo[]                         // numbered 1.. in document order, bullets - * +, any indent
findTodo(text, query: number | string, section?): Todo   // by number, else exact text, else unique substring
setTodoState(text, todo, state): Edit[]     // empty when already in that state
addTodo(text, item, section?): Edit[]       // "- [ ] item" after the last task (of the section), matching its
                                            // indent; else at the end of the section or document
appendBlock(text, block, section?): Edit[]  // block at the end of the document or section, blank line rules as Herdr
replaceUnique(text, old, new, section?): Edit[]  // exactly one occurrence, else not-found / ambiguous

type TodoChangeKind = "added" | "removed" | "checked" | "unchecked" | "cancelled" | "uncancelled" | "edited"
interface TodoChange { kind: TodoChangeKind; number: number; text: string; line: number; oldLine: number }
todoChanges(old, new): TodoChange[]         // Herdr todo/changes.rs, rendered "checked 3. Ship"
formatTodoChange(c): string
```

Disk (`disk.ts`, `node:fs`, synchronous, files are small):

```ts
interface Stamp { mtimeMs: number; size: number; ino: number }
interface Format { bom: boolean; crlf: boolean }
readFile(path): { text: string; stamp: Stamp; format: Format }   // too-large over MAX_BYTES; decodes BOM, CRLF to LF
stamp(path): Stamp | null                   // null when missing
writeAtomic(path, text, format): Stamp      // temp file in the same directory, fsync, rename, keeps mode
```

## Wire protocol (`packages/protocol`)

`effect/rpc` (`Rpc.make`, `RpcGroup.make`) with `Schema` payloads, ndjson over
HTTP at `POST /rpc`. Every path on the wire is absolute; the CLI resolves
relative paths against its own cwd. The server accepts only absolute paths to
`.md` or `.markdown` files whose parent directory exists.

```ts
Author   = TaggedUnion: User {} | Agent { name: string (1..64, [A-Za-z0-9._-]) } | File {}
TaskState, Todo, TodoChange, Section: as in doc, as Schemas
Others   = { since: Version, diff: string | null }

Rpcs (all payloads carry `path` unless noted):
  status   {}                                → { pid, appVersion, port, startedAt, documents: [{ path, version, watchers }] }
  stop     {}                                → {}                     // replies, then shuts down
  open     { path, create: boolean }         → { path, version, url, created: boolean }
  read     { path, section? }                → { version, text }
  sections { path }                          → { version, sections }
  todos    { path, section? }                → { version, todos }
  edit     { path, author, version, section?, op }
           op = Replace { old, new } | Append { text } | TodoAdd { text }
              | TodoSet { target: number | string, state: TaskState }
                                             → { version, changed, section: string | null, others: Others | null }
  sync     { path, base, text }              → { version, text }      // author is always User
  diff     { path, since, wait: 0..600 }     → { from, to, by: Author[], diff, todos }
  watch    { path, since?, section?, text: boolean }   stream: true
           → Watching { version, text? } | Change { from, to, by, diff, todos, text? }
             | Resync { version, text? } | Deleted {}

Errors (Schema.TaggedErrorClass), union on every rpc:
  VersionMismatch { latest, since, diff: string | null, forgotten: boolean }   exit 1
  Refused { code: "not-found" | "ambiguous" | "too-large" | "invalid", message }  exit 1 (invalid: 2)
  Forgotten { latest }                                                       exit 1
  NothingYet {}                                                              exit 4
  DocumentGone { path }                                                      exit 9
  Unauthorized {}                                                            exit 3
```

`watch` is bounded by construction: the server keeps no per-subscriber queue
(no PubSub, no `SubscriptionRef.changes`). Each document holds a `Deferred`
that is completed and swapped for a fresh one on every change. A subscriber
loops: if `doc.version > lastSent`, emit `changes(lastSent, section)` and set
`lastSent`; otherwise await the current `Deferred` (read before checking the
version, so a change between emit and await is never missed). A slow reader
gets one coalesced `Change { from, to }` (printed `Versions A-N`). When
`lastSent` is forgotten it emits `Resync`. `text: true` adds the full current
text (the web uses it).

## Daemon (`packages/server`)

- One per user. Listens on `127.0.0.1`, port `$DO_IT_PORT` or 47100, falling
  back to a free port when taken. `daemon.json` (mode 0600) records
  `{ pid, port, token, appVersion, startedAt }`; the token is 32 random bytes,
  hex.
- Auth: `POST /rpc` needs `Authorization: Bearer <token>` or the `do_it`
  cookie. `GET /auth?token=...&path=...` sets the cookie (HttpOnly,
  SameSite=Strict, Path=/) and redirects to `/?path=...`. Every request must
  have `Host` equal to `127.0.0.1:<port>` or `localhost:<port>`; a present
  `Origin` must match it. `GET /health` is open and returns
  `{ ok, pid, appVersion }` only.
- Static: everything else serves `packages/web/dist` (SPA fallback to
  `index.html`); when dist is missing, a one line page saying to build it.
- Caps: request body 4 MiB, 64 open documents (idle ones without watchers
  closed first), 32 watch streams per document, 256 in total, `daemon.log`
  rotated at 1 MiB, idle exit after 30 minutes with no request and no stream.
- Documents service (`Context.Service`): `path -> { doc, signal, watcher }`.
  Each change bumps the signal and schedules one coalesced atomic write.
- File watching: `fs.watch` on the parent directory filtered by basename
  (editors replace files by rename), debounced 50 ms, plus a 2 s stamp poll as
  a fallback. A changed stamp reads the file and calls `mergeFile`. A missing
  file is rechecked after 500 ms; if still missing, watchers get `Deleted` and
  the document is closed.
- Versions survive restarts: `versions.json` maps path to `{ version, sha256 }`
  (LRU, 256 entries, written atomically, debounced 1 s and on shutdown). On
  open, a matching hash reopens at that version; a different hash opens at
  `version + 1`, made by `file`.
- Graceful shutdown on `stop`, SIGTERM, SIGINT, idle: flush writes and
  `versions.json`, remove `daemon.json` if it is still ours.

## Lifecycle and client (`packages/client`)

```ts
ensureDaemon(opts?: { home?: string; spawn?: boolean }): Effect<DaemonInfo, DaemonUnavailable>
  // read daemon.json, GET /health (500 ms timeout), pid and appVersion match -> reuse.
  // Otherwise take daemon.lock (mkdir; stale when its pid is dead or older than 10 s),
  // spawn `bun <server entry>` detached (stdio to daemon.log, unref), poll /health up to 5 s.
  // A daemon of another appVersion is stopped and replaced.
stopDaemon(): Effect<boolean>               // rpc stop, else SIGTERM the pid; false when none ran
RpcClientLayer(info: DaemonInfo)            // RpcClient.layerProtocolHttp + ndjson + bearer header
```

## CLI (`packages/cli`, binary `do-it`)

Global flags: `--json`, `--as NAME` (default `$DO_IT_AGENT`, else `agent`).
Text after `--` may start with `-`; a TEXT of `-` reads stdin. Every command
ensures the daemon first (exit 3 when it cannot start).

| Command | Text reply |
| --- | --- |
| `open [PATH] [--no-browser]` | `Opened PATH at version N: URL` (creates PATH from the template when missing; opens the browser with `open`/`xdg-open`; returns at once) |
| `read PATH [--section ID]` | `Version: N` then the text |
| `sections PATH` | `Version: N` then `id  (level) title` per line |
| `edit PATH --version N [--section ID] --old T --new T` | see replies |
| `append PATH --version N [--section ID] TEXT` | see replies |
| `todo add PATH --version N [--section ID] TEXT` | see replies |
| `todo check\|uncheck\|cancel\|uncancel PATH --version N [--section ID] NUMBER\|TEXT` | see replies |
| `todo list PATH [--section ID]` | `Version: N` then `3. [x] Ship` per task |
| `diff PATH --since N [--wait S]` | `Version N by WHO` then the diff; exit 4 when nothing came |
| `watch PATH [--since N] [--section ID] [--todos] [--settle S]` | `Watching PATH at version N`, then per change `Version N by WHO` (or `Versions A-N by WHO, WHO`) and the diff, or with `--todos` lines like `checked 3. Ship`. Changes made only by `--as NAME` are skipped. `--settle S` prints only `Settled at version N by WHO` after S quiet seconds. Reconnects (and restarts the daemon) with backoff; prints `Daemon restarted, now version N` once. Exit 9 when the document is deleted |
| `status` | daemon pid, port, uptime, open documents |
| `stop` | `Stopped` or `Not running` |

Replies (exact):

- `Updated. Version: 7`
- `Unchanged. Version: 7` (nothing to change, exit 0)
- `Updated section "goals". Version: 7. Other sections changed since 5:` then the diff
- `Version mismatch, nothing changed. Latest version: 7. Changes since 5:` then the diff (exit 1)
- `Version mismatch, nothing changed. Latest version: 7. Version 5 is no longer kept: run do-it read` (exit 1)

`--json` prints one JSON object per reply (one per line for `watch`); errors
are `{"error":{"code","message",...}}` on stdout with the same exit code.

New documents get this template:

```markdown
# TODO

Add one task per line. Agents pick up new lines, plan them, and write their status underneath.

## Tasks

- [ ] 
```

## Web (`packages/web`)

Foldkit 0.170 app, same origin as the daemon, RPC over `FetchHttpClient`
with the cookie. URL `/?path=/abs/TODO.md`. Cookies are host scoped, so every
URL the CLI prints uses `127.0.0.1`, never `localhost`. `vite dev` proxies
`/rpc` and `/auth` to the daemon for development.

- Connects with `watch { path, text: true }`; reconnects with backoff and
  shows `Reconnecting` (a `Resync` replaces the text).
- Two views of one text: **Tasks** (rendered Markdown, task lines as
  checkboxes, an add task field per section, headings, status sub bullets
  shown muted) and **Markdown** (a textarea of the raw text).
- Every edit by the person goes through `sync { base, text }`: checkbox
  clicks and adds compute the new text locally; the textarea sends its text
  400 ms after typing stops. A `Change` arriving while the draft is dirty sends
  the draft first, then adopts the merged reply; selection is kept by mapping
  offsets through the common prefix and suffix.
- Activity: the last 20 changes, `Version 12 by t3: checked 3. Ship`; lines
  changed by someone else are highlighted for a few seconds.
- No dash separators in copy.

## Conductor (`skill/SKILL.md`)

- Outside Herdr a Claude Code subagent cannot be prompted mid run: a worker
  that needs the person writes `question` to the inbox and exits; the
  conductor writes the question under the task and, once answered, resumes
  that worker (SendMessage to its agent id) with the answer.
- The conductor runs three Monitors: the todo (`--settle 25 --as conductor`),
  the inbox, and `tests.md --todos` (to start the one tester when requests are
  open). Planner and worker agents run in the background so events keep
  arriving.
- Blocking waits use `do-it diff PATH --since N --wait 300` in a loop (the Bash
  tool caps one call at 600 s).
- Each worker brief sets `DO_IT_AGENT=tN`, so its edits are attributed.
