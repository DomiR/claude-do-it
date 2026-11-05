# claude-do-it plan

A Markdown todo that a person edits in a browser (and later a TUI) while a
Claude agent reads it, changes it, and conducts the work it lists. Edits from
both sides merge instead of overwriting each other. Works anywhere Claude Code
runs; inside Herdr (`HERDR_ENV=1`) it uses Herdr worktrees and tabs for its
workers.

Research behind these choices: [research.md](research.md). The exact
contract every package is built against (types, wire protocol, caps, reply
strings): [design.md](design.md).

## Status (v1, 2026-11-04)

Phases 1 to 3 are built: the document model, the protocol, the daemon and
its client, the `do-it` CLI, the Foldkit editor, and the `do-it` skill.
Phase 4 (the TUI) is not started; `packages/tui` holds a README only.

## Pieces

| Package | Responsibility |
| --- | --- |
| `packages/protocol` | Schemas and the Effect `RpcGroup` (`effect/rpc`) every client shares: `status`, `stop`, `open`, `read`, `sections`, `todos`, `edit`, `sync`, `diff`, `watch` (a stream). Tagged errors, and the formatting helpers the CLI and web share. No transport or storage. |
| `packages/doc` | The document model: one `loro-crdt` doc per file, version numbers mapped to Loro frontiers (a ring of 512), strict agent edits, never refused user edits, external file merges, a two level (lines, then characters) diff for merges, a capped unified diff (64 KiB) for stale versions, sections by heading slug, Markdown task lines and task change detection, atomic bounded disk I/O. `@do-it/doc/text` is the loro free subset the browser uses. No transport. |
| `packages/server` | The background daemon: one per user, 127.0.0.1 only, token and cookie auth, serving the RPCs over HTTP with ndjson streaming, watching files on disk, writing changes back atomically, keeping version numbers across restarts, and serving the built web app. |
| `packages/client` | Daemon lifecycle for every Bun side client (ensure: reuse, health check, lock, spawn; stop) and the authenticated RPC client layer. Used by the CLI, the tests, and later the TUI. |
| `packages/cli` | The `do-it` command (`effect/cli`): `open`, `read`, `sections`, `edit`, `append`, `todo add/start/check/uncheck/cancel/uncancel/list`, `diff --since --wait`, `watch [--todos] [--section] [--settle S] [--quiet]`, `status`, `stop`. Starts the daemon when needed and opens the browser. `--json` everywhere, `--as NAME` everywhere. |
| `packages/web` | The Foldkit CodeMirror 6 PlainTasks editor: one source Markdown surface with task actions, command palette, status bar, activity pane, and versioned watch and sync. |
| `packages/tui` | Phase 4: the same editor in the terminal with OpenTUI (Solid) and `@do-it/client`. |
| `skill/` | The Claude Code skill (`/do-it [file]`), see below. |

The binary is `do-it`, not `do`: `do` is a reserved word in bash and zsh, so
`do read x` cannot run.

## Version semantics (as Herdr's doc commands)

- Every reply starts with the document's version; every change by anyone takes the next number.
- An agent's change names the version it was based on. If the document changed since, nothing is applied and the reply is the latest version plus a diff since the caller's version (exit 1). With `--section ID`, a stale version still applies when that section is unchanged, and the reply carries the diff of the other sections.
- The person's edits (browser, later TUI) go through `sync { base, text }`: never refused for being stale, merged at the base version by the CRDT.
- Sections are the GitHub anchor slugs of `#`, `##`, `###` headings (repeats get `-1`, `-2`).
- `watch` prints `Version N by WHO` (or `Versions A-N by WHO, WHO` when several landed together) then the diff, or with `--todos` lines like `checked 3. Ship`, `added 12. Write tests`. `--quiet` omits the initial Watching line. A forgotten or future `--since` prints `Missed changes, now at version N: run do-it read`. `--settle S` prints one `Settled at version N by WHO` after S quiet seconds; changes made only by the `--as` name are skipped. It reconnects with backoff, and prints `Daemon restarted, now version N` when the resumed watch is still kept.
- Version numbers survive daemon restarts (`versions.json` keeps the last version and a hash per file); the diff history does not.
- Authors are named: `the user` (browser or TUI), an agent name passed with `--as NAME` or `DO_IT_AGENT` (default `agent`), or `file` for disk edits.
- Exit codes: 0 done, 1 refused or version mismatch, 2 invalid arguments, 3 daemon not running and could not start, 4 nothing yet (`--wait` timed out), 9 the document was deleted.

## The skill (`skill/SKILL.md`, name `do-it`)

Invoked like Plannotator: `/do-it [path]` (default `TODO.md`; created from a template if missing).

1. Runs `do-it open PATH`: starts or reuses the daemon, opens the browser on the document (inside Herdr, a Sheprd browser tab through `DO_IT_BROWSER`), and returns at once.
2. The session becomes the **conductor**, following the herdrdocwatch doctrine: three Monitors (the todo with `--settle 25`, the inbox, and the test queue), triage of each task (S, M, L, Q), one status line per task written back under it, questions under the task, and delivery through a team:
   - **Outside Herdr:** the conductor calls every agent itself, in the background, because subagents can neither start subagents nor be prompted mid run. Planners are `fable-advisor` (S, M) or the `astra-implementer` agent asked for a plan (L); workers are `general-purpose` subagents with `isolation: "worktree"`, at most 3; one tester subagent drains the test queue (`tests.md`, served by the same daemon) one request at a time; a worker that needs the person ends with `QUESTION:` and is resumed with the answer through `SendMessage`; the conductor runs the final `fable-advisor` review per task.
   - **Inside Herdr (`HERDR_ENV=1`):** the same roles in Herdr worktrees and tabs, as herdrdocwatch does, with `do-it` commands in place of Herdr's `doc` commands.
3. Communicates only through the todo; the person only looks at the browser. Channels live in `~/.do-it/runs/<slug>/` (`inbox.md`, `tests.md`, `plans/`, `logs/`, `state.json`).

Install: `ln -s <repo>/skill ~/.claude/skills/do-it`.

## Phases and checks

1. **Protocol and doc** (done): unit tests for version mismatch, section scoped stale edits, the diff cap, todo operations, external file merges (including a three writer merge), bounded history, Unicode offsets, the disk format. Check: `bun test` green.
2. **Server, client, CLI, web** (done): daemon lifecycle (spawn, reuse, health, stop, restart, idle exit), every CLI command with `--json`, the Foldkit editor showing and editing a todo live while the CLI edits it. Checks: end to end tests where 10 CLI agents and a second RPC client (the simulated browser, syncing from stale bases) edit one file at once and all 20 edits survive; every command's `--json` and exit codes; a watch that survives a daemon restart; `do-it open` serving a working page, checked in a Sheprd browser tab (text and screenshot) and a headless browser (a CLI edit shows up live, a checkbox click reaches `do-it read`).
3. **Skill** (done): `skill/SKILL.md`. Check: a dry run of the conductor loop on a sample TODO.md in a scratch repo, with the literal skill commands: one settle event for a typing burst, triage status lines (a stale edit refused, then retried), inbox and test queue events, the tester's answer waking the worker's `diff --wait`, a question answered from the browser, delivery, and all three watches following a daemon restart with versions kept.
4. **TUI** (later): `packages/tui` with OpenTUI, `@do-it/client`, keyboard first. The pieces it needs exist: `ensureDaemon`, `RpcClientLive`, `watch { text: true }`, `sync`, and `@do-it/doc/text` for task toggles and adds.

## Constraints

- Bun ≥ 1.3, TypeScript, Effect 4.1.2 pinned exactly (`effect/rpc`, `effect/cli`, `effect/http`), `loro-crdt` 1.17.1, Foldkit 0.170.0. Effect v4 idioms (`Context.Service`, layers, typed errors).
- Bounded everything: request (4 MiB) and document (2 MiB) caps, a 512 version history ring, a 64 KiB diff cap, 64 open documents, 32 watch streams per document and 256 in all, one daemon per user, no per subscriber queues.
- Local only: the daemon listens on 127.0.0.1 with a per user token (mode 0600); the browser gets an HttpOnly cookie through a one time code in the `open` link, so the token never appears in a URL; `Host` and `Origin` are checked.
- No dash separators in user facing copy (UI strings, docs): use commas, colons, or parentheses.

## Known limits

- Concurrent whole replacements of one line close to 2 MiB are slow in Loro; normal documents (many short lines) are not affected.
- The daemon runs the code it started with: after pulling a new version with the same `appVersion`, run `do-it stop` once.
