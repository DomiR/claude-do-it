# claude-do-it design (v1)

The contract every package is built against. [plan.md](plan.md) says what and
why; this file says exactly how.

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
const COMPACT_KEEP = 128                    // versions replayed during compaction
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
  // stable peer, no fork. When base is older, fork at
  // base's frontiers (fresh peer), `update(text)` there, export, import, free
  // the fork: concurrent agent, file, and other user edits survive.
  // Throws DocError("forgotten") when base is no longer kept.
  userEdit(base: Version, text: string): Applied

  // Another program changed the file. When the synced
  // frontiers are the current ones, update the main doc directly; otherwise
  // fork at the synced frontiers (fresh peer), `update(diskText)`, import.
  // Returns false when the disk text is the synced text, the current text, or
  // one of the document's own writes in flight (no version taken).
  mergeFile(diskText: string): boolean

  // Disk write protocol (toWrite, wrote, notWritten): at most 8
  // writes in flight are remembered so their echo is recognised.
  get dirty(): boolean
  toWrite(): WriteTicket                    // opaque snapshot: text, frontiers, version
  wrote(ticket: WriteTicket): void
  notWritten(ticket: WriteTicket): void

  textAt(version: Version): string | null
  changes(since: Version, section?: string): Changes | null   // null when forgotten
  origin(version: Version): Origin | null   // who made that version

  // Bounded history: replay the last COMPACT_KEEP versions when the oplog
  // passes 50k ops or 256 peers and nothing waits to be written. Older diffs
  // are forgotten, while the kept versions remain readable and mergeable.
  compact(): { reason: "ops" | "peers"; ops: number; peers: number; kept: number; oldest: Version } | null
}
```

Rules:

- Every change by anyone takes exactly the next version and records
  `(version, frontiers, origin)` in a ring of `KEPT`.
- Forks at an old frontier (`userEdit`, `mergeFile`) always use a fresh random
  peer, never a reused one (a reused peer at an old frontier duplicates op ids);
  the first test asserts `forkAt` gives a new peer. Agent edits fork the
  current state and may reuse a stable per agent peer.
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
appendBlock(text, block, section?): Edit[]  // block at the end of the document or section, after one blank line (none between list items)
replaceUnique(text, old, new, section?): Edit[]  // exactly one occurrence, else not-found / ambiguous

type TodoChangeKind = "added" | "removed" | "checked" | "unchecked" | "cancelled" | "uncancelled" | "edited"
interface TodoChange { kind: TodoChangeKind; number: number; text: string; line: number; oldLine: number }
todoChanges(old, new): TodoChange[]         // rendered "checked 3. Ship"
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
              | TodoStart { target: number | string }
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
`lastSent` is forgotten it emits `Resync` as the first event for a resumed
watch. The CLI prints `Missed changes, now at version N: run do-it read` for
that event. `text: true` adds the full current text (the web uses it).

## Daemon (`packages/server`)

- One per user. Listens on `127.0.0.1`, port `$DO_IT_PORT` or 47100, falling
  back to a free port when taken. `daemon.json` (mode 0600) records
  `{ pid, port, appVersion, startedAt }`. The token lives in `token` (mode
  0600, 32 random bytes hex), created once and reused across restarts.
- Auth: `POST /rpc` needs `Authorization: Bearer <token>` or the `do_it`
  cookie, whose value is `HMAC-SHA256(token, "web cookie")`, so open tabs stay
  authorized across daemon restarts. The `open` rpc mints a one time code
  (single use, 5 minutes, at most 64 outstanding); `GET /auth?code=...&path=...`
  sets the cookie (HttpOnly, SameSite=Strict, Path=/) and redirects to
  `/?path=...`, so the token itself never appears in a URL. Every request must
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
| `todo start PATH --version N [--section ID] NUMBER\|TEXT` | see replies, appends `@started` with the local time |
| `todo check\|uncheck\|cancel\|uncancel PATH --version N [--section ID] NUMBER\|TEXT` | see replies, updating PlainTasks time stamps |
| `todo list PATH [--section ID]` | `Version: N` then `3. [x] Ship` per task |
| `diff PATH --since N [--wait S]` | `Version N by WHO` then the diff; exit 4 when nothing came |
| `watch PATH [--since N] [--section ID] [--todos] [--settle S] [--quiet]` | `Watching PATH at version N`, then per change `Version N by WHO` (or `Versions A-N by WHO, WHO`) and the diff, or with `--todos` lines like `checked 3. Ship`. `--quiet` omits the initial Watching line. A forgotten or future `--since` prints `Missed changes, now at version N: run do-it read`. Changes made only by `--as NAME` are skipped. `--settle S` prints `Settled at version N by WHO` after S quiet seconds. Reconnects with backoff; a daemon restart prints `Daemon restarted, now version N` when the resumed watch is still kept. Exit 9 when the document is deleted |
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

- The editor is one CodeMirror 6 source editor in a Foldkit `Mount`. It has
  pinned versions of `@codemirror/state` 6.7.6, `@codemirror/view` 6.43.15,
  `@codemirror/commands` 6.11.1, and `@codemirror/search` 6.7.2. It presents
  the plain Markdown file as a Sublime Text style PlainTasks notepad: yellow
  paper, 17px monospace text, a centred column, hanging indents, headings as
  projects, and agent status lines in muted ink. The file remains plain
  Markdown. CodeMirror uses `\n` as its line separator, so `\r` remains a
  source character and the text stays byte exact.
- Line decorations come from `editor/lines.ts`. On decorated lines, task and
  status bullets, heading and quote markers, Markdown delimiters, and link
  syntax are hidden while the label remains editable. No line ever shows its
  source markup, wherever the caret or selection is: Markdown typed into a
  line renders as soon as the construct is complete. Plain prose bullets
  become a visible `•`, and a task's whole `- [ ] ` prefix is one marker
  widget that the caret crosses, and Backspace or Delete removes, as a single
  character (the line becomes plain text). Copy, selection, undo, and source
  offsets still use Markdown. Clicking a marker toggles done; Alt-click
  toggles cancelled. A formatting bar above the editor applies bold, italic,
  strikethrough, code, links, and task, bullet, and project lines. Empty
  tasks keep their marker but do not count in statistics or archive actions.
- The editor uses PlainTasks markers `☐`, `✔`, and `✘` for open, done, and
  cancelled tasks. Tags use PlainTasks colours: generic tags are bold red,
  `@today` is bold black on yellow, `@high` is bold black on orange, `@low` is
  bold white on dark grey, `@critical` is bold black on red, and state or
  project tags use muted ink. Tag arguments remain part of the tag decoration.

| Action | Mac | Other | Semantics |
| --- | --- | --- | --- |
| New task | `Cmd-Enter`, `Cmd-i` | `Ctrl-Enter`, `Ctrl-i` | Create a task on the current line, or continue the targeted task block. |
| Toggle done | `Cmd-d`, `Cmd-Shift-Enter` | `Ctrl-d`, `Ctrl-Shift-Enter` | Toggle the targeted tasks between open and done. |
| Toggle cancelled | `Ctrl-c`, `Cmd-Alt-Enter` | `Alt-c`, `Ctrl-Alt-Enter` | Toggle cancellation, preserving the task as editable Markdown. |
| Archive | `Cmd-Shift-a`, `Cmd-Alt-a` | `Ctrl-Shift-a`, `Ctrl-Alt-a` | Move resolved task blocks under `## Archive`, newest first, adding ` @project(Section)` to each archived task when needed. Open, empty, or blocked resolved tasks do not move. |
| Move up or down | `Cmd-Ctrl-ArrowUp`, `Alt-ArrowUp`; `Cmd-Ctrl-ArrowDown`, `Alt-ArrowDown` | `Ctrl-Shift-ArrowUp`, `Alt-ArrowUp`; `Ctrl-Shift-ArrowDown`, `Alt-ArrowDown` | Swap any line with its neighbour using Sublime semantics. A task, or a line owned by a task, moves with its whole block and can cross headings and sections. |
| Continue task | `Enter` | `Enter` | Split the current task and insert an open sibling with the same prefix. |
| Tab, tag completion, or indent | `Tab` | `Tab` | Expand a PlainTasks snippet when the caret follows a completion token, otherwise indent the current line or selected task blocks. `s`, `t`, `c`, `h`, `l`, `cr`, `d`, and `@s` expand to the supported tags; a bare `@started` or `@created` gets a local date. |
| Outdent | `Shift-Tab`, `Cmd-[` | `Shift-Tab`, `Ctrl-[` | Outdent the current line or selected task blocks. |
| Open link | `Cmd-Shift-u`, `Alt-Enter` | `Alt-Enter` | Open the link under the caret, or reveal a project anchor. |
| Edit link | `Cmd-k` | `Ctrl-k` | Edit the text and URL of the link under the caret in a popover, or link the selected text. Clicking a link opens it too. |
| Bold | `Cmd-b` | `Ctrl-b` | Wrap the selection, or the word at the caret, in `**`; inside bold text, remove it. One undoable change; the formatting bar runs the same command. |
| Italic | `Cmd-Shift-i` | `Alt-Shift-i` | The same with `*`. `Cmd-i` stays New task, and `Ctrl-Shift-i` is left to the browser's developer tools. |
| Strikethrough | `Cmd-Shift-x` | `Ctrl-Shift-x` | The same with `~~`. |
| Inline code | `Cmd-e` | `Ctrl-e` | The same with a backtick. `Cmd-Shift-c` is left to the element inspector. |
| Task line | `Cmd-Alt-4` | `Ctrl-Shift-4` | Turn the selected lines into tasks, or back into text when they all are. Indentation and labels stay. |
| Bulleted line | `Cmd-Alt-5` | `Ctrl-Shift-5` | Turn the selected lines into `- ` bullets, or back into text when they all are. A task becomes a plain bullet. |
| Project heading | `Cmd-Alt-2` | `Ctrl-Shift-2` | Turn the selected lines into `## ` project headings, or back into text when they all are. |
| Go to project | `Cmd-p` | `Ctrl-p` | Open the project palette and move to the selected heading. |
| Command palette | `Cmd-Shift-p`, `F1` | `Ctrl-Shift-p`, `F1` | Search and run editor commands. |
| Find | `Cmd-f` | `Ctrl-f` | Open CodeMirror Find. |
| Keyboard shortcuts | `Cmd-/` | `Ctrl-/` | Open the shortcuts palette. `?` opens it when focus is outside the editor or an input. Escape closes it. |

The editor deliberately leaves `Mod-r`, `Mod-Shift-r`, `Mod-Shift-o`, `Ctrl-c`
on other platforms, and `Ctrl-Shift-u` on other platforms unbound. Browser
reload, tab search, focus navigation, cancellation conflicts, and Unicode input
keep their browser or platform meanings. Escape then Tab leaves the editor so
browser focus navigation remains available.

- The status bar shows PlainTasks statistics as `done/total done`. Counts
  exclude empty tasks and the first top level `## Archive` subtree, and include
  nested tasks. Its centre shows key caps for New task, Done, Cancel, Archive,
  Commands, and Help, hidden below 900px. It also shows line and grapheme
  column, the base version, and `Saved`, `Saving`, or `Reconnecting`.
- Toggle actions write PlainTasks local time stamps in `%y-%m-%d %H:%M` form:
  ` @done (26-11-04 21:32)` and ` @cancelled (26-11-04 21:32)`. Reopening a
  task removes the matching resolved stamp and keeps `@started`. The same
  format is used by `do-it todo check`, `todo cancel`, and `todo start`.
- Archive follows PlainTasks: the first top level `## Archive` section is the
  destination, or one is created at the end. Resolved task blocks go directly
  below its heading, newest first. Each archived task gets its nearest heading
  as ` @project(Section)` unless that tag is already present.
- Activity is a collapsible pane, initially closed, with the latest 20 remote
  changes and their version, authors, and todo details. Remote insertions are
  highlighted for three seconds. The pane does not take editor focus.
- Typing waits 400 ms after the latest input before syncing. An action syncs
  immediately. At most one sync is in flight. `ApplyRemoteText` computes
  `D = edits(from, to)` and maps `D` over the local edits since `from`, then
  applies the result to the live editor without adding to undo history. Clean
  watch changes use `from = draft`; sync replies use `from` equal to the sent
  text; every `Resync` uses `from = base.text`, whether the draft is clean or
  dirty.
- Snapshots older than or equal to the current base version are ignored,
  except that a Resync is handled as the authoritative recovery snapshot.
  While a remote apply or sync is busy, only the newest snapshot is retained.
  A sync reply adopts its text when it matches the sent text. When it differs,
  the reply is rebased into the live editor before the next sync decision.
  `Forgotten` stops retrying the request, reconnects from the current base
  version, and waits for Resync. Other non-auth, non-deletion sync failures
  retry a dirty draft after two seconds, up to five attempts. A failed remote
  apply retries after 500 ms.
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
- Blocking waits use `do-it diff PATH --since N --wait 100` in a loop (the Bash
  tool stops a call at 120 s by default).
- Each worker brief sets `DO_IT_AGENT=tN`, so its edits are attributed.
