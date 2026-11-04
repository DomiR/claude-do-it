# claude-do-it plan

A Markdown todo that a person edits in a browser (and later a TUI) while a
Claude agent reads it, changes it, and conducts the work it lists. Edits from
both sides merge instead of overwriting each other. Works anywhere Claude Code
runs; inside Herdr (`HERDR_ENV=1`) it uses Herdr worktrees and tabs for its
workers.

Research behind these choices: [research.md](research.md).

## Pieces

| Package | Responsibility |
| --- | --- |
| `packages/protocol` | Schemas and the Effect `RpcGroup` every client shares: `read`, `edit`, `todo` operations, `watch` (a stream), `open`, `status`. No transport or storage. |
| `packages/doc` | The document model: one `loro-crdt` doc per file, version numbers mapped to Loro frontiers (bounded history ring), edits applied at the version the caller named and merged, a capped unified diff for stale versions, sections by heading slug, Markdown task lines, atomic bounded disk I/O, merging external file edits. No transport. |
| `packages/server` | A background daemon (spawned or reused by the CLI, health checked, one per user) serving the RPCs over HTTP with ndjson streaming, watching files on disk, and serving the built web app. |
| `packages/cli` | The `do` command (`effect/unstable/cli`): `open`, `read`, `sections`, `edit`, `append`, `todo add/check/uncheck/list`, `diff --since --wait`, `watch [--todos] [--section]`, `status`, `stop`. Starts the daemon when needed and opens the browser. `--json` everywhere. |
| `packages/web` | The Foldkit todo editor: renders the Markdown, live updates from `watch`, edits sent with versions, shows who changed what. |
| `packages/tui` | Phase 3: the same editor in the terminal with OpenTUI (Solid) and the same RPC client. |
| `skill/` | The Claude Code skill (`/do-it [file]`), see below. |

## Version semantics (copy them exactly from Herdr's doc commands)

- Every reply starts with the document's version; every change by anyone takes the next number.
- A change names the version it was based on. If the document changed since, nothing is applied and the reply is the latest version plus a diff since the caller's version (exit 1). With `--section ID`, a stale version still applies when that section is unchanged, and the reply carries the diff of the other sections.
- Sections are the GitHub anchor slugs of `#`, `##`, `###` headings.
- `watch` prints `Version N by WHO` then the diff (or, with `--todos`, lines like `checked 3. Ship`, `added 12. Write tests`), and survives daemon restarts.
- Authors are named: `the user` (browser or TUI), an agent name passed with `--as NAME` or `DO_IT_AGENT`, or `file` for disk edits.
- Exit codes: 0 done, 1 refused or version mismatch, 2 invalid arguments, 3 daemon not running and could not start, 4 nothing yet (`--wait` timed out), 9 the document was deleted.

## The skill (`skill/SKILL.md`, name `do-it`)

Invoked like Plannotator: `/do-it [path]` (default `TODO.md`; created if missing).

1. Runs `do open PATH` in the background: starts or reuses the daemon, opens the browser on the document, and returns at once.
2. The session becomes the **conductor**, following the herdrdocwatch doctrine (`~/.claude/skills/herdrdocwatch/SKILL.md`, read it): it watches the todo (debounced, settle for about 25 s of quiet before acting), triages each task (S, M, L, Q), writes one status line per task back under it, asks questions under the task, and delivers through a team:
   - **Outside Herdr:** workers are Claude Code subagents (`Agent` tool, `isolation: "worktree"` for writers), planners are `fable-advisor` (S, M) or the `astra-implementer` agent (L). One tester subagent at a time runs all builds and tests; workers queue test requests in a test document the daemon also serves.
   - **Inside Herdr (`HERDR_ENV=1`):** the same roles in Herdr worktrees and tabs, as herdrdocwatch does.
3. Communicates only through the todo; the person only looks at the browser.

## Phases and checks

1. **Protocol and doc**: `packages/protocol`, `packages/doc` with unit tests for version mismatch, section scoped edits, stale diff cap, todo operations, external file merge, bounded history. Check: `bun test` green.
2. **Server, CLI, web**: daemon lifecycle (spawn, reuse, health, stop), every CLI command with `--json`, the Foldkit editor showing and editing a todo live while the CLI edits it. Check: an end to end test that runs the daemon, edits from the CLI and from a simulated browser client at once, and sees both merge; `do open` opens a working page.
3. **Skill**: `skill/SKILL.md` and an install note (symlink into `~/.claude/skills/do-it`). Check: a dry run of the conductor loop on a sample todo.
4. **TUI** (later): `packages/tui` with OpenTUI, same RPC client, keyboard first.

## Constraints

- Bun ≥ 1.3, TypeScript, Effect 4.1.x pinned exactly, `loro-crdt` 1.17.x, Foldkit 0.170.x. Follow kitlangton/effect-solutions idioms (`Context.Service`, layers, `effect/unstable/*` for HTTP, RPC, CLI).
- Bounded everything: request and document size caps, history ring, diff cap, one daemon per user, no unbounded queues.
- Local only: the daemon listens on 127.0.0.1 with a per user token; documents are files the user names.
- No dash separators in user facing copy (UI strings, docs): use commas, colons, or parentheses.
