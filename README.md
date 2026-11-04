# claude-do-it

A Markdown todo you edit in the browser while Claude reads it, changes it, and
conducts the work it lists. Your typing, the agents' changes, and edits made
to the file on disk merge instead of overwriting each other (one Loro CRDT
per file, served by a small local daemon).

- `do-it`: a CLI with versioned commands agents use to read and change the todo
- a background daemon on `127.0.0.1` that holds the documents, watches the
  files, and serves the editor
- a browser editor (Foldkit) that shows the todo live and lets you check,
  add, and edit tasks
- the `do-it` Claude Code skill: `/do-it [file]` opens the todo and turns the
  session into a conductor that plans and delivers every task through worker
  agents and one shared tester

Design: [docs/plan.md](docs/plan.md) and [docs/design.md](docs/design.md).

## Install

Needs [Bun](https://bun.sh) 1.3 or newer (macOS or Linux).

```bash
git clone <this repo> ~/Developer/claude-do-it
cd ~/Developer/claude-do-it
bun install
bun run build:web                     # the editor the daemon serves
mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/src/bin.ts" ~/.local/bin/do-it   # any directory on PATH
do-it --help
```

The binary is `do-it`, not `do`: `do` is a reserved word in bash and zsh.

Install the skill for Claude Code:

```bash
ln -s "$PWD/skill" ~/.claude/skills/do-it
```

## Use it from Claude Code

```
/do-it            # TODO.md in the current directory, created when missing
/do-it PLAN.md
```

The browser opens on the todo (inside Herdr, in a Herdr browser tab). Add
one task per line. The session sizes each task, plans it, starts a worker in
its own worktree, and writes one status line under it, plus any question it
needs you to answer (answer by writing under the question). Delivered tasks
are checked off with their branch and test result. Inside Herdr
(`HERDR_ENV=1`) the workers are Claude architects in Herdr worktrees and tabs
with Codex lanes; elsewhere they are Claude Code subagents.

## Use the CLI

```bash
do-it open TODO.md                    # start or reuse the daemon, open the browser, return
do-it read TODO.md                    # "Version: 7" then the text
do-it todo list TODO.md
do-it todo add TODO.md --version 7 --section tasks "Write tests"
do-it todo check TODO.md --version 8 3
do-it edit TODO.md --version 9 --old "ship friday" --new "ship monday"
do-it append TODO.md --version 10 --section notes -- "- found: flaky CI"
do-it diff TODO.md --since 9 --wait 300
do-it watch TODO.md --todos           # or --settle 25 for one line per pause
do-it status
do-it stop
```

Every reply starts with the document's version and every change, by anyone,
takes the next one. A change names the version it was made against; when the
document moved on, nothing is applied and the reply is the latest version and
a diff (exit 1). With `--section ID` a stale version still applies while that
section is unchanged. `--json` works on every command; `--as NAME` (or
`DO_IT_AGENT`) names the agent. Exit codes: 0 done, 1 refused or version
mismatch, 2 invalid arguments, 3 daemon not running and could not start,
4 nothing yet, 9 the document was deleted.

## The daemon

One per user, started on demand by any command, stopped with `do-it stop` or
after 30 idle minutes. State lives in `~/.do-it` (`DO_IT_HOME`): the runtime
record, a per user token (mode 0600), the log, and the last version of each
file so numbers survive restarts. It listens on `127.0.0.1:47100`
(`DO_IT_PORT`) and only answers requests carrying the token or the browser
cookie the `open` link sets.

## Develop

```bash
bun test ./packages ./tests           # unit, daemon, and end to end tests
bun run typecheck
bun run build:web
bun --cwd packages/web run dev        # editor with a proxy to the daemon on 47100
```

`packages/tui` is a placeholder for the terminal editor (phase 4).
