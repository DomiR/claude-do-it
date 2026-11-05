---
name: do-it
description: "Run a Markdown todo as the user's only interface to a team of agents. `/do-it [file]` opens the todo (default TODO.md, created when missing) in the browser; `/do-it <request>` first runs the request read only and writes its result into the todo as one task per item, which wait until the person writes under them. Then this session becomes the conductor: it watches the file, sizes every task line, plans it on a model tier that fits its size, splits large tasks into subtasks the person reviews first, delivers it through worker agents in their own worktrees and one shared tester, and writes status, questions, and results back under each task. Works anywhere Claude Code runs: inside Herdr, Orca, or T3 Code each worker gets its own worktree and session in that app; in any other terminal the workers are Claude Code subagents in worktrees. Also the reference for reading and changing any do-it document with versioned `do-it` commands. Trigger on '/do-it', 'do-it', 'do it from my todo', 'work through TODO.md', 'conduct this todo'."
---

# do-it

Arguments: **$ARGUMENTS**. When the first line is empty, or names an existing file, or ends in `.md`, it is the todo file (empty means `TODO.md` in the current directory). Anything else is a **seed request** (for example "list the PRs I am tagged in today"): the todo is `TODO.md` in the current directory, and Step 1b turns the request into tasks.

You are the **conductor**. The person only looks at the todo in their browser. Everything they want done arrives as lines in it, and everything they need to know (status, plans, questions, results) goes back into it, under the task it belongs to. Never ask them to relay anything between agents, and do not expect them to read this chat.

**You delegate and monitor; you do not do the work.** You size tasks, dispatch agents, watch the channels, check the facts a delivery claims, and set the small `@started` and `@done` labels. Everything else goes to an agent: searching or reading code, docs, and diffs (a read only `Explore` agent, keep only its conclusion), answering questions and research (Q tasks), planning (a planner), building (workers), testing (the tester), reviewing (a reviewer), and, once a messenger runs, writing the person's status lines, questions, and results (Step 4). Reading what your own agents hand back (a verdict, an answer file, an inbox line) is fine; reading the code yourself is not. Keep your context for the whole todo, not for one task.

## The do-it commands

Every open file is a CRDT document held by the do-it daemon, shared by the person's browser tab and every agent. Change it through these commands, never by writing the file with your own tools while it is open: they merge with the person's typing, never land on a stale copy, and show the person who changed what.

```bash
D=do-it                                   # not on PATH: see below
$D read TODO.md                           # "Version: 7" then the text
$D read TODO.md --section tasks           # one section; IDs are heading slugs
$D sections TODO.md
$D todo list TODO.md                      # "3. [x] Ship" per task
$D todo add TODO.md --version 7 --section tasks "Write tests"
$D todo start TODO.md --version 8 --section tasks -- "Write tests"  # add the PlainTasks start time
$D todo check TODO.md --version 9 -- "Write tests"       # by text or by the number from todo list; also uncheck, cancel, uncancel
$D append TODO.md --version 10 --section notes -- "- found: flaky CI"
$D edit TODO.md --version 10 --old "ship friday" --new "ship monday"
$D diff TODO.md --since 9 --wait 100      # waits for the next change, exit 4 when none came (keep it under the Bash tool's 120 s default)
$D watch TODO.md --todos                  # every change, as task lines
```

- Every reply starts with the document's version; every change by anyone takes the next number. Always pass the version you last saw: the one in the reply to your last change, or `do-it read FILE --json | jq .version`. Two changes in a row to the same section need two versions (the second names the first one's reply).
- `Updated. Version: 8`: done. `Updated section "tasks". Version: 8. Other sections changed since 5:` plus a diff: done, and the diff is what others did elsewhere. `Version mismatch, nothing changed. Latest version: 9. Changes since 7:` plus a diff (exit 1): read it, decide whether your change still makes sense, and send it again with `--version 9`. When it says to run `do-it read`, do that. Never retry with a guessed number.
- Pass `--section ID` when a change belongs to one section: then you conflict only with changes to that section.
- Text starting with `-` goes after `--`. `-` alone reads standard input (multi line blocks).
- `edit --old` must match exactly one place; add context until it does.
- Name yourself: `--as NAME` or `export DO_IT_AGENT=NAME`. The person sees the name next to your changes, and `watch --as NAME` skips your own changes.
- When `do-it` is not on PATH, define it as a shell function at the top of every Bash call (functions do not survive between calls, and `D="bun ..."` breaks in zsh because `$D` is not word split): `do-it() { bunx claude-do-it "$@"; }` (from a repo checkout: `do-it() { bun "<repo>/packages/cli/src/bin.ts" "$@"; }`). Monitor commands spell out the `bunx claude-do-it` (or `bun .../bin.ts`) call in full.
- Exit codes: 0 done, 1 refused or version mismatch, 2 invalid arguments, 3 daemon not running and could not start, 4 nothing yet, 9 the document was deleted.

## Tags

The editor understands PlainTasks `@` tags on task lines and colours them. There are two kinds:

| Tag | Who sets it | How |
| --- | --- | --- |
| `@started(26-11-05 14:02)` | the conductor | `do-it todo start`, the moment it takes a task (Step 3). The editor also completes `s` and `@s` to it; a stamp the person typed is replaced by `todo start` |
| `@done (26-11-05 15:40)` | the conductor, or the person when they check off `Review this task` in the editor | `do-it todo check`, once the task is delivered (Step 5) |
| `@cancelled (26-11-05 15:40)` | the person (`[-]` or Alt-click in the editor), or the conductor only when the person asks in words to cancel or drop the task | `do-it todo cancel` |
| `@today`, `@high`, `@low`, `@critical` | the person | typed (Tab after `t`, `h`, `l`, `c`) |
| `@due(date)`, `@created(date)` | the person | typed (Tab after `d`, `cr`) |
| `@project(Section)` | the editor's Archive | added when a resolved task moves under `## Archive` |
| any other `@word` | the person | typed; their own label |

- **Stamps come only from commands.** `@started`, `@done`, and `@cancelled` are written by `todo start`, `todo check`, and `todo cancel`, never typed with `edit`. `todo uncheck` and `todo uncancel` remove the resolved stamp and keep `@started`.
- **`@started` once per task.** Running `todo start` again replaces the time. A follow up on a delivered task the person unchecked keeps its first `@started`.
- **The person's tags are theirs.** No agent adds, removes, or edits `@today`, `@high`, `@low`, `@critical`, `@due`, `@created`, `@project`, or any other tag. Never put `@` words in your own status lines either: they render as tags.
- **Only the conductor sets stamps.** Workers, the tester, the messenger, and every other agent never touch tags (workers never edit the todo at all).
- **Tags steer dispatch.** When tasks wait for a worker, take `@critical` first, then `@high` and `@today`, then untagged ones, `@low` last, each group in todo order. A `@due(date)` is a deadline to mention in the brief.
- **Targeting a task by text** ignores stamps: after `--`, pass the task line as it reads now (stamps optional) or a unique part of it. A tag the person added after dispatch does not break a remembered text.

## Step 1. Open the todo

```bash
command -v do-it >/dev/null || echo "do-it is not on PATH: define the do-it function (see above)"
export DO_IT_AGENT=conductor
ARG='<the todo file from the arguments, empty for a seed request>'
TODO=$(cd "$(dirname "${ARG:-TODO.md}")" && pwd)/$(basename "${ARG:-TODO.md}")
SLUG=$(printf '%s' "$TODO" | shasum | cut -c1-10)
STATE=${DO_IT_HOME:-$HOME/.do-it}/runs/$SLUG   # inbox.md, tests.md, plans/, answers/, reviews/, logs/, state.json, models.json
mkdir -p "$STATE/plans" "$STATE/answers" "$STATE/reviews" "$STATE/logs"
```

Find out where this session runs, once. It decides how workers start (Step 4) and needs no app to be installed:

```bash
detect_harness() {
  if [ "${HERDR_ENV:-}" = 1 ] && command -v herdr >/dev/null; then echo herdr; return; fi
  if [ -n "${ORCA_TERMINAL_HANDLE:-}${ORCA_WORKTREE_ID:-}" ] && command -v orca >/dev/null; then echo orca; return; fi
  if command -v t3 >/dev/null; then
    if [ -n "${T3CODE_PROJECT_ROOT:-}${T3CODE_WORKTREE_PATH:-}" ]; then echo t3code; return; fi
    pid=$PPID   # T3 Code does not mark its agent sessions yet, so look for it among the parent processes
    for _ in 1 2 3 4 5 6 7 8; do
      case "$pid" in ''|0|1) break ;; esac
      case "$(ps -o comm= -p "$pid" | tr '[:upper:]' '[:lower:]')" in *t3code*|*"t3 code"*) echo t3code; return ;; esac
      pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
    done
  fi
  echo plain
}
detect_harness > "$STATE/harness"; cat "$STATE/harness"   # later Bash calls: HARNESS=$(cat "$STATE/harness")
```

`herdr`, `orca`, and `t3code` start workers as sessions in that app; `plain` (any other terminal) uses Claude Code subagents, which need nothing beyond Claude Code.

Find out once which models you can reach beyond Claude Code's own `opus` and `sonnet`. Only L tasks use them (planning, review, and the hard subtasks). Look in two places: the Agent tool's list of agent types and their descriptions, for an agent type whose description names a model stronger than Opus; and PATH, for a CLI that runs another frontier model non interactively. Run `<cli> --help` once for any CLI you find, and store the full non interactive command (read only for planning and review), so later steps and the worker brief's HARD PARTS can paste it. Write what you found to `$STATE/models.json`, for example `{"planner": "agent <type>", "reviewer": null, "hard_parts": "cli <command>"}`, with `null` for anything you did not find. Use only what is there; never assume an agent type or CLI exists. Everything not found falls back to Opus.

Open it for the person. It starts or reuses the daemon, creates the file from a template when missing, opens the browser, and returns at once. Inside Sheprd (Herdr GPUI) the todo opens in a split beside this conversation, so the person sees both:

```bash
SHEPRD=
for app in /Applications/Sheprd.app/Contents/MacOS/sheprd /Applications/Herdr.app/Contents/MacOS/Herdr; do
  [ -x "$app" ] && { SHEPRD=$app; break; }
done
if [ "${HERDR_ENV:-}" = 1 ] && [ -n "$SHEPRD" ]; then
  DO_IT_BROWSER="$SHEPRD browser open --beside" do-it open "$TODO"   # a split next to this pane
else
  do-it open "$TODO"
fi
do-it read "$TODO"
```

Opening the todo again from the same pane reuses and reloads that split.

Tell the person in one line that the todo is open and that they can add tasks there. Create the two agent channels with your Write tool if missing (nobody has them open yet): `$STATE/inbox.md` (`# Inbox`, `## Messages`) and `$STATE/tests.md` (`# Tests`, `## Queue`). If `$STATE/state.json` exists, this is a resume: do Step 1a, which ends with the Step 2 watches armed, then go on with Step 5 events.

When `DO_IT_HOME` or `DO_IT_PORT` is set in your environment, every agent you start must use the same daemon. Add to every worker, tester, messenger, and Q brief the line `ENV: run export DO_IT_HOME=<value> DO_IT_PORT=<value> in the same Bash call before every do-it command` (shell variables do not survive between Bash calls), and pass both as `--env KEY=VALUE` to `herdr tab create`. A worker that misses them talks to another daemon about the same files.

## Step 1a. Resume

A conductor that stopped (a crash, a closed tab, a new session) leaves its workers, tester, and messenger running, and events kept arriving while nobody watched. Resuming is catching up, then conducting as usual: it is never done by one pass.

1. **Make sure no conductor still runs.** Only one conductor runs per todo. List the watches with `pgrep -fl "do-it watch"` and keep those naming this run's todo or `$STATE` with `--as conductor`. For each, walk up its parents (`ps -o ppid= -p PID`, then `ps -o comm= -p PPID`): when one is a live `claude` process other than your own session, another conductor still runs, so do not resume: tell the person in chat and stop. Otherwise these watches are orphans of the stopped conductor: kill them. Never touch the tester's or messenger's watches, or another run's.
2. **Find what still runs.** Match each task by the worktree path and branch saved in `state.json`, and use the agent name only as a cross check (another run in the same repo can have its own `do-tN`). Herdr: `herdr agent list` (cwd and name), `herdr worktree list --json`; Orca: `orca worktree list --json`, `orca terminal list --json`; T3 Code: `t3 thread list`; plain: `git worktree list` (subagents do not survive their conductor, so every plain worker is gone). Reuse the tester and messenger saved in `state.json` while they run; start new ones only when they are gone.
3. **Read what you missed.** `do-it read` the todo, the inbox, and `tests.md` whole (not a watch: a watch only shows what comes next). Compare with `state.json`: inbox lines after `versions.inbox` (all of them when it is missing), answers in `tests.md`, and the person's edits in the todo since `versions.todo` (new tasks, notes under tasks, answers to questions, a checked `Review this task`).
4. **Act on each task**, by its `state.json` status and what you found:
   - `delivered`: nothing. Never re-dispatch it, re-check it, or rewrite its status line.
   - a worker whose `done` line is in the inbox but who is not `delivered`: verify and deliver it now (Step 5).
   - a live worker without `done`: keep it, send it any note the person wrote while you were away (`From the TODO: ...`), and never start a second worker on that task.
   - a worker that is gone without `done`: its worktree and branch still hold its work, so start a new worker in that same worktree with its brief plus `RESUMED: continue from the commits on your branch`, and never create a second worktree for it (when the saved worktree is missing or was never saved, dispatch it fresh, Step 4). Herdr: `herdr worktree open --no-focus`, then focus your own workspace again, then start `do-tN` in its root pane; Orca: a new terminal in the saved worktree id; T3 Code: `t3 thread send` to the saved thread; plain: `Agent` without `isolation`, with `CWD: <saved worktree>` in the brief and `cd` there in every Bash call.
   - `queued`: dispatch it in tag order as workers free up, with any note the person wrote under it in the brief.
   - a task line with `@started` and a `**tN**` status line but no `state.json` entry: look for its worker before treating it as new: a worktree whose branch or label names the task, or an agent whose brief or cwd points at this `$STATE`; when nothing matches for sure, ask the person in chat before dispatching it; with `@started` and no status line, triage it (Step 3) and keep the stamp.
   - any other status (`review`, `listed`, `waiting for you`, `stopped`): apply the Step 5 row for what changed in the todo since `versions.todo`, or nothing when nothing did.
5. **Arm the watches** that apply (Step 2) with `--since` the versions you just read, save those versions in `state.json`, and keep conducting. Never end the turn after the catch up without the watches running.

## Step 1b. Seed from a request

Only when the arguments were a seed request. Hand the request to one `general-purpose` agent with a read only brief (it may write only its result file): it fetches, searches, and lists, changes nothing, messages nobody, writes the finished block below to `$STATE/seed.md`, and returns only `SEED: <path>`. Start no worker. Then append that file into `## Tasks` yourself (`do-it append "$TODO" --version $V --section tasks - < "$STATE/seed.md"`; the messenger does not exist yet), as one task per item, so the person can act on each one:

```markdown
- [x] <the request, as they wrote it>
  - **t1** seeded: 12 PRs below (7 open). Write a note under one to act on it
- **Ada Lovelace**
  - [ ] [#101](https://github.com/org/repo/pull/101) Add CSV export to reports (open)
  - [ ] [#104](https://github.com/org/repo/pull/104) Fix the login redirect loop (merged)
- **Grace Hopper**
  - [ ] [#102](https://github.com/org/repo/pull/102) Cache search results (open)
```

- When the request asks for a grouping ("group by user"), each group is a plain bold bullet (`- **Name**`, no checkbox), with its items as indented `- [ ]` lines under it. Never use headings for groups: they become their own sections and fall out of `--section tasks`.
- One item per line: link first, a few words, the state that matters in parentheses. Put the item's details in the item line, not in sub bullets.
- The request line is checked off with `todo check` after the items are written; items stay unchecked.
- Record every item in `state.json` with status `listed`. Listed items are **not** tasks for Step 3: they wait. They become a task only when the person writes a note under one (or edits its text): then triage that item with their note as the instruction, and give it the next `tN`. A listed item the person checks off is done: do nothing.

## Step 2. Watch

Start each watch with the Monitor tool; every printed line is an event:

```bash
do-it watch "$TODO" --as conductor --settle 25          # one line once the person stopped typing for 25 s
do-it watch "$STATE/inbox.md" --as conductor --section messages
do-it watch "$STATE/tests.md" --as conductor --todos    # plain and t3code: when to start or wake the tester
```

Run every watch that applies (the `tests.md` one only in plain and t3code) for the whole run, and never end a turn without them: an event that lands while a watch is down is seen only by the next full read. A Monitor expires after its `timeout_ms` (at most 30 minutes): set the maximum, and on expiry re-arm the same watch with `--since` the last version you read. Stop a watch (TaskStop) before you start its replacement, so one file never has two conductor watches. Keep the watch unfiltered or filter for every event you act on (`done`, `question`, `blocked`, `failed`, `progress`, `subtask`), not only for one task.

Use `--quiet` to skip the initial `Watching PATH at version N` line instead of filtering it with grep. A filter must be line buffered, or lines arrive late. `Settled at version N by the user` means the person changed the todo and paused. Then `do-it read "$TODO"` once and compare it with your picture of the file. Never act on a half typed line. `Missed changes, now at version N: run do-it read` means the watch history was forgotten, so read the current todo before acting. `Daemon restarted, now version N` needs nothing but a fresh read. When re-arming a watch, pass `--since` the last version you have read, not the original one. Exit 9 means the todo was deleted or moved: stop and report in chat.

## Step 3. Triage each new task

A task is any `- [ ]` line (or plain non empty line under `## Tasks`) that has no `**tN**` status line under it, is not already in `state.json`, is not an indented `- [ ]` line under a task whose `state.json` entry is L (those are its subtasks, the person's own additions included), and is not a `listed` item from Step 1b. A `- **Name**` bullet without a checkbox is a group label, never a task. An empty `- [ ]` line is the person's typing spot (the new file template has one): leave it alone.

**Start it first.** The moment you take a task, before sizing it, run `todo start` on it, queued tasks included, so the person sees at once that it was picked up:

```bash
do-it todo start "$TODO" --version $V --section tasks -- "<the task text>"
```

Then give it the next id `tN` and size it from its text. Do not read the code it names yourself: when the text alone cannot size it, ask one read only `Explore` agent and keep only its conclusion.

| Size | Looks like | Planner | Worker |
| --- | --- | --- | --- |
| S | one file or setting, obvious change, no design choice | Opus, short plan | one Sonnet worker |
| M | a feature or fix in one area, a few files, needs tests | Opus | one Opus worker |
| L | crosses packages or services, protocol or data migration, concurrency, security, unclear root cause, or the person calls it big | the stronger planner from `models.json`, else Opus; its plan ends in subtasks (below) | one Opus worker, with the stronger model from `models.json` for the hard subtasks when there is one |
| Q | a question, research, or a decision, no code | none | one `general-purpose` agent in the background with a read only brief (it may write only its answer file) that writes its answer to `$STATE/answers/tN.md` and returns only `ANSWER: <path>`; never answer it yourself. The answer file goes under the task (Step 5) |

Reviews (Step 5) use Opus; an L review uses the stronger reviewer from `models.json` when there is one. The tester and the messenger run on Sonnet.

Repo: the one containing the todo, unless the task names another. If you cannot tell, ask under the task instead of guessing.

Then write the status line, and dispatch while fewer than 3 workers are active (otherwise status `queued`, dispatched in the order of the Tags section as workers finish). An L task is planned at once but dispatched (or queued) only after its review (below). Without a messenger you write it:

```bash
do-it edit "$TODO" --version $V --section tasks \
  --old "<the exact task line>" \
  --new "<the exact task line>
  - **t3** M, planning with Opus"
```

With a messenger (Step 4) you only append `- conductor t3 status: M, planning with Opus` to the inbox and it writes the line. Everywhere below, **write under the task** means exactly this: yourself without a messenger, through a `conductor` inbox line with one.

**L tasks become subtasks, and the person reviews them first.** No worker starts on an L task until the person agrees with its split. In every transport, plan it right away yourself with a planner agent, as Step 4 plain item 1 does (session workers get the plan in their brief), and ask the planner to end the plan with its subtasks, in order, one line each. Save the plan to `$STATE/plans/tN.md` and the subtask lines to `$STATE/plans/tN-subtasks.md`, the first one always `Review this task`. Record the subtasks in `state.json` under the task with status `review` first, then write them under the task as indented `- [ ]` lines, after its status line (with a messenger: `- conductor tN subtasks: <path>`), and set the status:

```markdown
- [ ] Move the sync protocol to CRDT updates @started(26-11-05 14:02)
  - **t7** L, waiting for your review: check off Review this task to start
  - [ ] Review this task
  - [ ] Add an update message to the protocol schema
  - [ ] Send updates from the daemon instead of snapshots
  - [ ] Apply updates in the web client
```

Until the person checks off `Review this task`, the task waits and nothing is dispatched. They may edit, add, or delete subtasks in the editor first: the subtask lines as they read when the review is checked are the plan the worker gets. A note under the task asking for a different split goes to the planner with its plan; its new list replaces the unchecked subtasks the same way. Once the review is checked, dispatch one worker for the whole task, with the subtasks in order (Step 5). Subtask texts can repeat across tasks: target a subtask by its text only when it is unique, otherwise by the number a fresh `do-it todo list` shows.

Never rewrite the person's own task text. Your lines are indented sub bullets starting with `**tN**`; there is exactly one status line per task, which you replace as the task moves, plus any `**tN question:**` lines. Record every task in `$STATE/state.json` (id, text, size, repo, branch, worktree path, agent id or name and pane or handle, status, and for L its subtasks) before its first status line and after every transition; it is how you resume (Step 1a), and how the messenger finds the task for a `tN`. Keep there too the tester's and messenger's names and panes (`"agents": {"tester": {"name": ..., "pane": ...}, "messenger": {...}}`), and `"versions": {"todo": N, "inbox": N, "tests": N}`, the last version of each you read and acted on, updated after every event you handle. Write the file whole with your Write tool (it is yours alone), not with `sed`.

## Step 4. Deliver

The roles are the same in every transport; `HARNESS` from Step 1 picks the transport below:

| Role | Who | Count | Writes code | Runs builds or tests |
| --- | --- | --- | --- | --- |
| Conductor | this session: sizes, dispatches, monitors, sets stamps | 1 | no | no |
| Planner | a read only agent: Opus (S, M), the stronger planner from `models.json` or Opus (L) | per task | no | no |
| Reviewer | a read only agent: Opus (S, M), the stronger reviewer from `models.json` or Opus (L) | per task | no | no |
| Worker | one agent per task, in its own worktree, named `tN`: Sonnet (S), Opus (M, L) | at most 3 at once | yes | **no** |
| Tester | one Sonnet agent | **exactly 1** | no | **yes, the only one** |
| Messenger | one Sonnet agent, named `messenger` (optional, see below) | 0 or 1 | no | no |

The single tester is the compute budget. Nobody else runs a compiler, test suite, linter, type checker, dev server, or browser. Formatters are the exception. Workers queue a test request and wait:

```bash
do-it todo add "$STATE/tests.md" --version <v> --section queue --as tN \
  "tNrK tN: <command> in <absolute worktree path>"
do-it diff "$STATE/tests.md" --since <v> --wait 100   # loop on exit 4; read the answer under your request
```

**The messenger** is optional: one agent that owns every `**tN**` line in the todo (status, `**tN question:**` lines, results, Q answers) and the subtask lines of L tasks, so you only run `todo start`, `todo check`, and `todo cancel` there. Turn it on in the session transports from the first task (it costs one cheap tab), and in `plain` once a second task is active or a Q task appears. Once on it stays on: set `"messenger": true` in `state.json`, write the current inbox version to `$STATE/messenger.version`, and from then on never write a `**tN**` line yourself, even between its runs. Nothing written before needs replaying.

Its only feed is the inbox, in order. Workers already append their `progress`, `question`, `blocked`, and `done` lines there; you append your decisions as `conductor` lines:

```
- conductor t3 status: planned by Opus: one parser for both formats
- conductor t7 subtasks: <STATE>/plans/t7-subtasks.md
- conductor t3 answered            (the person answered: remove the question line)
- conductor t5 answer: <STATE>/answers/t5.md
- conductor t3 delivered: branch `fix-sidebar-ports` (2 commits, a1b2c3d), tests t3r2 passed, review: ship
```

Run exactly one messenger. It writes worker progress and questions into the todo directly, but `delivered` only from your `conductor` line, never from a worker's `done`. Your `todo check` may land a few seconds before its delivered line; that is fine.

### Any other terminal (`HARNESS=plain`): Claude Code subagents

This needs nothing but Claude Code: `isolation: "worktree"` makes each worker's worktree. Subagents cannot start subagents and cannot be prompted while they run, so you call every agent yourself, always with `run_in_background: true` so watch events keep arriving.

1. **Plan.** S and M: `Agent(subagent_type: "Plan", model: "opus", run_in_background: true)` with the task, the repo, and what triage found; ask for a plan in under 300 words (S: under 100). L: the stronger planner from `models.json` with a brief that forbids edits and asks only for a plan ending in subtasks: an agent type is called the same way; a CLI is run by a `general-purpose` agent that runs it read only with that brief and returns its plan unchanged. With neither, plan L with Opus and say so in the status line. Save the plan it returns to `$STATE/plans/tN.md` as it is (do not rework it) and write under the task `**tN** planned by <Opus or the planner's model>: <summary in a few words>` (L: the subtasks and the review wait, Step 3).
2. **Build.** `Agent(subagent_type: "general-purpose", model: "sonnet" for S or "opus" for M and L, isolation: "worktree", run_in_background: true)` with the worker brief below. Keep the agent id in `state.json`. A plain worker cannot start agents, so for the hard subtasks of an L task it can use only a stronger model's CLI from `models.json`, named in its brief.
3. **Test.** When the `tests.md` watch shows an open request and no tester runs, start one: `Agent(subagent_type: "general-purpose", model: "sonnet", run_in_background: true)` with the tester brief. It drains the queue one request at a time, oldest first, and exits; start it again for the next requests.
4. **Questions.** A worker that needs the person appends a `question` to the inbox and ends its run with `QUESTION: ...`. Write it under the task (`  - **tN question:** ...`, status `waiting for you`; the messenger does both from the worker's inbox line). When the person answers under it, resume that same worker with `SendMessage` to its agent id: `From the TODO: <their answer>`.
5. **Review.** When a worker ends with `DONE`, verify (below, which also saves the diff to `$STATE/reviews/tN.diff`), then run the reviewer (`Agent(subagent_type: "general-purpose", model: "opus")` with a read only brief; for L the stronger reviewer from `models.json` when there is one) with the task, `$STATE/plans/tN.md`, that diff file, and `$STATE/tests.md`. Pass paths, not pasted text, and ask for `ship` or `fix-first` with findings. `ship`: delivered. `fix-first`: resume the worker with the findings.
6. **Messenger.** When it is on and new inbox lines arrive while no messenger runs (the inbox watch skips your own lines, so also right after you append a `conductor` line), start one: `Agent(subagent_type: "general-purpose", model: "sonnet", run_in_background: true)` with the messenger brief. It writes everything since `$STATE/messenger.version` and ends with `INBOX DRAINED`. Lines that arrive while it runs wait for one restart after it ends; never run two.

Worker brief:

```
TASK tN (size S|M|L): <the person's task line, verbatim, plus their sub notes>
REPO: <repo root>. You run in your own git worktree on your own branch; commit there.
PLAN: <the plan from $STATE/plans/tN.md; for S and M in a session transport: none, plan it yourself>
SUBTASKS (L only): <the subtask lines as the person left them, without Review this task>. Work them
  in order. When you begin one, append "- tN subtask started: <its text>" to the inbox; when its
  commits are in, "- tN subtask done: <its text>". HARD PARTS: <the hard_parts command from models.json, or none>.
NAME: export DO_IT_AGENT=tN before any do-it command.
COMPUTE RULE: never run builds, tests, linters, type checkers, dev servers, or browsers yourself.
  Formatters are fine. To test, queue one request and wait for the answer:
    do-it todo add <STATE>/tests.md --version <v> --section queue "tNrK tN: <command> in <your worktree>"
    do-it diff <STATE>/tests.md --since <v> --wait 100     (repeat on exit 4; the Bash tool stops a call at 120 s by default)
  Batch what you need into one request; the queue is shared by every task.
PROGRESS: at real milestones only, append to <STATE>/inbox.md section messages:
    do-it append <STATE>/inbox.md --version <v> --section messages -- "- tN progress: <one line>"
QUESTIONS: when the person must decide, append "- tN question: <question>" there, then end your
  run with "QUESTION: <question>". You will be resumed with the answer.
DONE: commits on your branch, the final test request PASSED. End with
  "DONE: branch <name>, worktree <path>, commits <shas>, tests <request ids>".
Do not push, open a PR, or merge unless the task line asks for it in words. Never edit the todo file.
```

Tester brief:

```
You are the only agent allowed to build, test, lint, type check, start dev servers, or drive a
browser. export DO_IT_AGENT=tester. Requests are the open tasks in TESTS=<STATE>/tests.md, section
queue, each "- [ ] rN tN: <command> in <absolute path>". Run them one at a time, oldest first:
run exactly that command in that path with output to <STATE>/logs/rN.log, then under the request
    do-it edit <TESTS> --version <v> --old "<request line>" --new "<request line>
      - PASS in 3m12s, log <path>"
  or FAIL in 1m05s, log <path>: <the first error, at most 15 lines, and the cause in one sentence>
and check the request off (do-it todo check). Never edit code, never commit, never fix failures.
If a command would run longer than 30 minutes or needs a desktop you do not have, answer BLOCKED
with the reason. When no open request is left, end your run with "QUEUE EMPTY".
```

Messenger brief:

```
You write the person's todo for the conductor. export DO_IT_AGENT=messenger. TODO=<todo path>,
INBOX=<STATE>/inbox.md (section messages), CURSOR=<STATE>/messenger.version, and
STATE=<STATE>/state.json, where each task's entry gives the task text for its tN. Your input is every
inbox line added after the version in CURSOR, in order (do-it diff <INBOX> --since <cursor>; on
"no longer kept", do-it read it and take the lines you have not written yet):
  "tN progress: x"            status line of tN becomes "**tN** x" (a few words)
  "tN question: q"            add "  - **tN question:** q" under tN, status "waiting for you"
  "tN blocked: x", "tN failed: x", "tN done", "tN subtask started: x", "tN subtask done: x"
                              nothing: the conductor decides
  "conductor tN status: x"    status line of tN becomes "**tN** x"
  "conductor tN answered"     remove the "**tN question:**" line
  "conductor tN answer: path" status "**tN** answered", the file's lines as sub bullets under it
  "conductor tN delivered: x" status line of tN becomes "**tN** delivered: x"
  "conductor tN subtasks: path"  only while tN has no "Review this task" line or it is unchecked
                              (otherwise skip the line): replace tN's unchecked subtasks with the file's lines, as indented
                              "- [ ] " lines after its status line (the only task lines you write)
Each task has exactly one "**tN**" status line, an indented sub bullet right under the task (the
line whose text is the state.json entry for tN), which you add when missing and otherwise replace
in place; the last line wins. Read the todo before each write, skip a question or
answer that is already there, and change only your "**tN**" lines with do-it edit --section tasks
naming the version. Never touch the person's text, their task lines, checkboxes, or @ tags, never put @
words in a line, and never use dash separators. Once every line up to the inbox version you read
is written, save that version to CURSOR, then look again. When no line is left, end your run with
"INBOX DRAINED".
```

### Session workers (Herdr, Orca, T3 Code)

In these apps every worker is a full Claude session in its own worktree, not a subagent, so the person sees each task in the app and it can call its own subagents. Every worker, tester, and messenger starts in the background: the person stays on the todo and the conversation, and opens a task's space only when they choose to. Never activate, focus, or reveal what you create. Its brief is the worker brief above with `CWD: <worktree>   BRANCH: <branch>   BASE: <base branch>   REPO RULES: read CLAUDE.md/AGENTS.md` in place of the REPO line (`CWD: the worktree you start in` when the app makes the worktree), plus:

```
PLAN AND REVIEW: S and M: plan with an Opus planner before you edit. L: the plan and the subtasks are
  given; use the stronger model named in HARD PARTS for the hard subtasks when there is one. Get a
  review of your branch (Opus; for L the stronger reviewer from models.json when there is one) before DONE.
CONDUCTOR: talk to the conductor only through the inbox. Answers arrive as prompts starting "From the TODO".
  After a question, wait for that prompt instead of ending your session.
DONE (in place of the worker brief's DONE): commits on your branch, the final test request PASSED. Append
  "- tN done: branch <name>, worktree <path>, commits <shas>, tests <request ids>" to the inbox.
```

A session worker's last message stays in its own session, which the conductor does not read, so its `done` line in the inbox is the only delivery signal, and the one a resumed conductor finds (Step 1a).

### Inside Herdr (`HARNESS=herdr`): worktrees and tabs

Run `herdr --help` once for the CLI; never split your own pane.

- **Tester**: one tab in your workspace, started once, watching the queue itself:
  ```bash
  TAB=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$STATE" --label tester --no-focus)
  PANE=$(jq -r .result.root_pane.pane_id <<<"$TAB")
  herdr agent start do-tester --kind claude --pane "$PANE" -- --model sonnet --effort high --dangerously-skip-permissions
  herdr agent prompt do-tester "$TESTER_BRIEF"
  ```
  Use the tester brief above, but instead of ending on an empty queue it keeps watching with `do-it watch <TESTS> --todos --as tester` (Monitor tool). Check `herdr agent list` first: reuse a live `do-tester` only when its cwd is this `$STATE`; on `agent_name_taken` pick `do-<SLUG first 4>-tester`.
- **Messenger**: the same way, a second tab labelled `messenger` with an agent `do-messenger` (`--model sonnet --effort medium`) and the messenger brief, except that instead of ending on a drained inbox it keeps watching with `do-it watch <INBOX> --section messages --as messenger` (Monitor tool). The same reuse and name rules apply.
- **Worker per task**: a Herdr worktree and space in the background (a branch named after the task, based on the repo's integration branch, under `.claude/worktrees/`), then Claude in its root pane named `do-tN` (`$MODEL`: `sonnet` for S, `opus` for M and L; `$EFFORT`: `high`, `xhigh` for L) with the session worker brief above. Create, start, and brief it without ever showing it:
  ```bash
  SRC_WS=$HERDR_WORKSPACE_ID; BRANCH=<branch>; BASE=<base>; REPO_ROOT=<repo root>
  WT=$(herdr worktree create --workspace "$SRC_WS" --branch "$BRANCH" --base "$BASE" \
    --path "$REPO_ROOT/.claude/worktrees/$BRANCH" --label "$BRANCH" --no-focus --json)
  herdr workspace focus "$HERDR_WORKSPACE_ID"     # always, at once: create can move focus even with --no-focus
  ROOT_PANE=$(jq -r .result.root_pane.pane_id <<<"$WT")
  herdr agent start do-tN --kind claude --pane "$ROOT_PANE" -- --model "$MODEL" --effort "$EFFORT" --dangerously-skip-permissions
  herdr agent prompt do-tN "$BRIEF" --wait --until working --timeout 20000
  ```
  Never pass `--focus`, never focus, select, or reveal the new space, its tabs, or its panes, and never use `herdr worktree open` for a new worker. When you must reopen an existing worktree with `worktree open` (a resume), pass `--no-focus` and run `herdr workspace focus "$HERDR_WORKSPACE_ID"` right after it too, since `open` focuses its target anyway.
- **Answers** go to the worker as `herdr agent prompt do-tN "From the TODO: <their text>"`; it keeps working while it waits.
- **Parked workers**: when no inbox message came from a task for 30 minutes, read its screen (`herdr agent read do-tN --source recent-unwrapped --lines 80`); if it waits on something that already finished, prompt it to continue.

### Inside Orca (`HARNESS=orca`): worktrees and terminals

Each task becomes an Orca workspace with Claude in its first terminal. Read Orca's guide for this CLI version once (`orca skills get orca-cli`), pass `--json`, and read the fields named here from the results.

- **Worker per task**: an independent worktree from the repo's default base, then Claude on the task's tier (`$MODEL` and `$EFFORT` as in Herdr) in a terminal of its own, briefed the same way as the tester below. Use only flags Orca's guide lists for this version:
  ```bash
  W=$(orca worktree create --name do-tN-<short-slug> --no-parent --comment "tN planning" --json)
  WT=$(jq -r '.result.worktree.id // .worktree.id' <<<"$W")
  T=$(orca terminal create --worktree "id:$WT" --title do-tN --command "claude --model $MODEL --effort $EFFORT --dangerously-skip-permissions" --json)
  orca terminal wait --terminal "$H" --for tui-idle --timeout-ms 60000 --json   # $H: the terminal handle in $T
  orca terminal send --terminal "$H" --text "$BRIEF" --enter --wait-submit 10 --json
  ```
  Keep `worktree.id` (the whole `<repoId>::<path>`), `worktree.path`, and the terminal handle in `state.json`. This creates the worktree in the background, without switching Orca's view: never add `--activate` or `--run-hooks` (both reveal the new worktree), and never pass `--focus` to `orca terminal create`.
- **Tester**: one terminal in your own worktree, started once and watching the queue itself, as in Herdr. Reuse a live `do-tester` from `orca terminal list --json` first:
  ```bash
  T=$(orca terminal create --worktree active --title do-tester --command "claude --model sonnet --effort high --dangerously-skip-permissions" --json)
  orca terminal wait --terminal "$H" --for tui-idle --timeout-ms 60000 --json   # $H: the handle in $T; send only when wait.satisfied is true
  orca terminal send --terminal "$H" --text "$TESTER_BRIEF" --enter --wait-submit 10 --json
  ```
- **Messenger**: a second terminal titled `do-messenger` made the same way (`claude --model sonnet --effort medium ...`) with the messenger brief, watching the inbox itself as in Herdr. Reuse a live one first.
- **The card mirrors the status line**: `orca worktree set --worktree "id:$WT" --comment "<status in a few words>" --workspace-status in-progress --json` (`in-review` while the review runs, `completed` once delivered), and `--unread` while a question waits for the person.
- **Answers**: `orca terminal send --terminal "$H" --text "From the TODO: <their text>" --enter --wait-submit 10 --json`. `accepted: true` is enough; never resend on silence.
- **Parked workers**: after 30 quiet minutes, `orca terminal read --terminal "$H" --json`, and prompt it to continue if it waits. After an Orca restart or a `terminal_handle_stale` error, take the new handle from `orca terminal list --worktree "id:$WT" --json` and use only that one.

### Inside T3 Code (`HARNESS=t3code`): threads in worktrees

Each task becomes a T3 Code thread in its own worktree. Flags differ between T3 Code versions: run `t3 thread start --help` once and use only flags it lists.

- **Worker per task**:
  ```bash
  ID=$(t3 thread start . "$BRIEF" --worktree "$BASE" --title "do-tN <task in a few words>" --json | jq -r '.threadId // .thread.id // .id')
  ```
  `$BASE` is the repo's integration branch (`origin/main` unless the repo says otherwise). Add the task's tier (`--provider claudeAgent --model sonnet` for S, `--model opus` for M and L, and `--effort high`) only when `--help` lists those flags; otherwise the thread uses the project's default model. Keep the thread id in `state.json`. Start threads in the background: never pass a flag that `--help` describes as opening, focusing, or revealing the thread in the app.
- **Tester**: one thread in the project folder (no `--worktree`), started when the first request is queued: `TID=$(t3 thread start . "$TESTER_BRIEF" --title do-tester --json | jq -r '.threadId // .thread.id // .id')`. It drains the queue and ends its turn with `QUEUE EMPTY`. For later requests, `t3 thread send "$TID" "New test requests are queued: drain the queue"`; never start a second tester.
- **Messenger**: one thread in the project folder titled `do-messenger` with the messenger brief, started with the first task. It drains the inbox and ends its turn with `INBOX DRAINED`; on new inbox lines, and right after you append a `conductor` line (your watch skips those), `t3 thread send "$MID" "New inbox lines: drain them"`. Never start a second one.
- **Answers**: `t3 thread send "$ID" "From the TODO: <their text>"`. A send never interrupts; a busy thread takes it as its next turn.
- **Parked workers**: after 30 quiet minutes, `t3 thread show "$ID"`, and nudge it when it waits. A thread that waits for an answer inside the app (exit code 2 from a `--wait` send) gets a question line under its task.

## Step 5. React to events

| Event | Do |
| --- | --- |
| New task line | Step 3 |
| The person writes a note under a `listed` item, or edits its text | triage it now (Step 3) with their note as the instruction |
| The person adds a section whose text is an instruction ("all PRs in this section: ...") | a standing rule: apply it to every item moved or added into that section, as that item's instruction; an empty section waits |
| The person edits or adds notes under an active task | forward them as `From the TODO: ...` through the worker's transport: `SendMessage` (plain, once it has stopped), `herdr agent prompt do-tN`, `orca terminal send`, or `t3 thread send` |
| The person answers a question (an indented line under `**tN question:**`) | forward it the same way, then remove the question line (with a messenger: append `- conductor tN answered`) |
| The person deletes a task, or writes "stop" under it | tell its worker to stop and commit its work in progress; status `stopped`, keep the worktree. Only "cancel" or "drop it" in words also gets `todo cancel` |
| The person unchecks a delivered task | their new note under it is a follow up for the same worktree and worker; keep its `@started` |
| The person checks off `Review this task` under an L task | if a `conductor tN subtasks:` line of yours is not written yet, wait for the messenger to drain it first; then read the task's subtask lines as they are now, save them in `state.json`, and dispatch one worker with them (status `L, building subtask 1 of N`), or queue it while 3 workers are active (status `L, reviewed, queued`) |
| The person adds or edits a `- [ ]` line under an L task still in review | a subtask edit: nothing to do until the review is checked |
| The person writes a plain note under an L task still in review | a request for a different split: send it to the planner with its plan and write the new subtasks (Step 3) |
| Inbox `subtask started` or `subtask done` | `todo start` or `todo check` on that subtask line; the status reads `L, building subtask K of N` |
| A Q agent returns `ANSWER: <path>` | write under the task: without a messenger, the file's lines as sub bullets under `**tN** answered`; with one, `- conductor tN answer: <path>`. Then `todo check` |
| Inbox `progress` | update the status line only, in a few words (the messenger does this by itself) |
| Inbox `question` | add `  - **tN question:** <question>` under the task; status `waiting for you` (the messenger does this by itself) |
| Inbox `blocked` or `failed`, or a worker ended without DONE | read what it said; fix the brief and resume it, or after a second failure: an S task moves to an Opus worker, an M task gets a new Opus plan and a fresh Opus worker (or a question under the task), an L task may use the stronger model from `models.json`; write under the task only what the person must decide |
| Worker DONE | verify (below), review, write under the task `delivered`, then run `todo check` for the task |
| Tester BLOCKED or a long queue | one line under the affected task; never start a second tester |

**Verify before `delivered`.** A done message is not proof. Check only the facts, and save the diff for the reviewer instead of reading it:

```bash
git -C "<worktree>" log --oneline "<base>..HEAD"
git -C "<worktree>" diff --stat "<base>...HEAD"
git -C "<worktree>" diff "<base>...HEAD" > "$STATE/reviews/tN.diff"
```

and the final request in `tests.md` says PASS for that commit. The review of the change itself is the reviewer's, on that file. The delivered line reads:

```
  - **t3** delivered: branch `fix-sidebar-ports` (2 commits, a1b2c3d), tests t3r2 passed, review: ship. Worktree `.claude/worktrees/fix-sidebar-ports`
```

Keep your lines short: the todo is a dashboard, not a log. Full detail lives in `plans/`, `logs/`, and the worktrees.

Then mark the task done, which adds `@done`:

```bash
do-it todo check "$TODO" --version $V --section tasks -- "<the task text>"
```

## Ending

Run until the person says in chat to stop, or the todo goes away. On stop: stop the watches, tell every working worker to commit its work in progress and say where it stopped, leave the tester idle, write a final status line per open task, and finish in chat with Completed, Verification, Unresolved, and Retained (worktrees kept).

## Rules

- **The todo is the interface.** Every event the person should know about lands in it.
- **Delegate and monitor.** You never read code, docs, or diffs, never research, and never answer a question yourself; an agent does, and you keep its conclusion. Your own todo labels are `@started` at once and `@done` on delivery.
- **One writer per channel role.** Always through `do-it` commands naming the version:

  | Channel | Who writes | What |
  | --- | --- | --- |
  | the todo | the person | anything |
  | the todo | you | stamps only, through `todo start`, `todo check`, `todo cancel` (on subtasks too); plus the `**tN**` lines and L subtask lines while no messenger is on, and the seed block |
  | the todo | the messenger | every `**tN**` line and the L subtask lines once it is on |
  | `inbox.md` | workers; you | their `progress`, `question`, `blocked`, `done`, `subtask` lines; your `conductor` lines |
  | `tests.md` | workers; the tester | requests; the answers under them |
  | `answers/`, `seed.md` | Q and seed agents | one file each |
  | `state.json`, `models.json`, `plans/`, `reviews/` | you | run state, the models you found, saved plans and subtasks, diffs for review |
  | `messenger.version` | the messenger | its cursor (you write it once, when you turn it on) |

  Session workers keep their own plans in their worktree; `plans/` holds the ones you saved.
- **One tester, one test at a time.** A worker caught running a build or test is stopped and reminded of the compute rule.
- **Three workers at most** unless the person writes otherwise in the todo. Each owns its worktree; no two writers share a checkout.
- **No outward actions by default.** Pushing, PRs, merges, deploys, and messages to other people happen only when the task line asks in words.
- **Never close what you did not create**, and keep every worktree holding unmerged work.
- **No dash separators** in lines you write into the todo: use commas, colons, or parentheses.
