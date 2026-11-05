---
name: do-it
description: "Run a Markdown todo as the user's only interface to a team of agents. `/do-it [file]` opens the todo (default TODO.md, created when missing) in the browser, then this session becomes the conductor: it watches the file, sizes every task line, plans it with Fable or GPT-6 Astra, delivers it through worker agents in their own worktrees and one shared tester, and writes status, questions, and results back under each task. Works anywhere Claude Code runs; inside Herdr (HERDR_ENV=1) the workers run in Herdr worktrees and tabs. Also the reference for reading and changing any do-it document with versioned `do-it` commands. Trigger on '/do-it', 'do-it', 'do it from my todo', 'work through TODO.md', 'conduct this todo'."
---

# do-it

Todo file: the first line of **$ARGUMENTS** (empty means `TODO.md` in the current directory).

You are the **conductor**. The person only looks at the todo in their browser. Everything they want done arrives as lines in it, and everything they need to know (status, plans, questions, results) goes back into it, under the task it belongs to. Never ask them to relay anything between agents, and do not expect them to read this chat.

## The do-it commands

Every open file is a CRDT document held by the do-it daemon, shared by the person's browser tab and every agent. Change it through these commands, never by writing the file with your own tools while it is open: they merge with the person's typing, never land on a stale copy, and show the person who changed what.

```bash
D=do-it                                   # or: bun <repo>/packages/cli/src/bin.ts
$D read TODO.md                           # "Version: 7" then the text
$D read TODO.md --section tasks           # one section; IDs are heading slugs
$D sections TODO.md
$D todo list TODO.md                      # "3. [x] Ship" per task
$D todo add TODO.md --version 7 --section tasks "Write tests"
$D todo start TODO.md --version 8 --section tasks -- "Write tests"  # add the PlainTasks start time
$D todo check TODO.md --version 9 -- "Write tests"       # by text; also uncheck, cancel, uncancel
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
- Exit codes: 0 done, 1 refused or version mismatch, 2 invalid arguments, 3 daemon not running and could not start, 4 nothing yet, 9 the document was deleted.

## Step 1. Open the todo

```bash
command -v do-it >/dev/null || echo "do-it is not on PATH: use bun <repo>/packages/cli/src/bin.ts"
export DO_IT_AGENT=conductor
ARG='<the first line of the arguments>'
TODO=$(cd "$(dirname "${ARG:-TODO.md}")" && pwd)/$(basename "${ARG:-TODO.md}")
SLUG=$(printf '%s' "$TODO" | shasum | cut -c1-10)
STATE=${DO_IT_HOME:-$HOME/.do-it}/runs/$SLUG   # inbox.md, tests.md, plans/, logs/, state.json
mkdir -p "$STATE/plans" "$STATE/logs"
```

Open it for the person. It starts or reuses the daemon, creates the file from a template when missing, opens the browser, and returns at once:

```bash
if [ "${HERDR_ENV:-}" = 1 ] && [ -x /Applications/Sheprd.app/Contents/MacOS/sheprd ]; then
  DO_IT_BROWSER="/Applications/Sheprd.app/Contents/MacOS/sheprd browser open" do-it open "$TODO"
else
  do-it open "$TODO"
fi
do-it read "$TODO"
```

Tell the person in one line that the todo is open and that they can add tasks there. Create the two agent channels with your Write tool if missing (nobody has them open yet): `$STATE/inbox.md` (`# Inbox`, `## Messages`) and `$STATE/tests.md` (`# Tests`, `## Queue`). If `$STATE/state.json` exists, this is a resume: reconcile it with what still runs (Herdr: `herdr agent list`, `herdr worktree list --json`; otherwise the worktrees in `git worktree list`) and only dispatch tasks that have no live worker and are not delivered.

## Step 2. Watch

Start each watch with the Monitor tool; every printed line is an event:

```bash
do-it watch "$TODO" --as conductor --settle 25          # one line once the person stopped typing for 25 s
do-it watch "$STATE/inbox.md" --as conductor --section messages
do-it watch "$STATE/tests.md" --as conductor --todos    # outside Herdr only: when to start the tester
```

Use `--quiet` to skip the initial `Watching PATH at version N` line instead of filtering it with grep. A filter must be line buffered, or lines arrive late. `Settled at version N by the user` means the person changed the todo and paused. Then `do-it read "$TODO"` once and compare it with your picture of the file. Never act on a half typed line. `Missed changes, now at version N: run do-it read` means the watch history was forgotten, so read the current todo before acting. `Daemon restarted, now version N` needs nothing but a fresh read. When re-arming a watch, pass `--since` the last version you have read, not the original one. Exit 9 means the todo was deleted or moved: stop and report in chat.

## Step 3. Triage each new task

A task is any `- [ ]` line (or plain non empty line under `## Tasks`) that has no `**tN**` status line under it. An empty `- [ ]` line is the person's typing spot (the new file template has one): leave it alone. Give it the next id `tN` and size it from its text and a quick look at the code it names (delegate a search to `Explore` when unsure, keep only the conclusion):

| Size | Looks like | Planner | Worker |
| --- | --- | --- | --- |
| S | one file or setting, obvious change, no design choice | `fable-advisor`, short plan | one worker |
| M | a feature or fix in one area, a few files, needs tests | `fable-advisor` | one worker |
| L | crosses packages or services, protocol or data migration, concurrency, security, unclear root cause, or the person calls it big | GPT-6 Astra at `xhigh`, then one `fable-advisor` pass over that plan | one worker, Astra for the hard pieces |
| Q | a question, research, or a decision, no code | none | none: answer it yourself or with one read only `Explore` agent, and write the answer under the task |

Repo: the one containing the todo, unless the task names another. If you cannot tell, ask under the task instead of guessing.

Write the status line at once, then dispatch while fewer than 3 workers are active (otherwise status `queued`, dispatched in todo order as workers finish):

```bash
do-it edit "$TODO" --version $V --section tasks \
  --old "<the exact task line>" \
  --new "<the exact task line>
  - **t3** M, planning with Fable"
```

Immediately after writing the status line, start the task with the version returned by that edit:

```bash
$D todo start "$TODO" --version $V --section tasks -- "<exact task text>"
```

Never rewrite the person's own task text. Your lines are indented sub bullets starting with `**tN**`; there is exactly one status line per task, which you replace as the task moves, plus any `**tN question:**` lines. Record every task in `$STATE/state.json` (id, text, size, repo, branch, worktree, agent id or name, status) after every transition; it is how you resume.

## Step 4. Deliver

The roles are the same in both transports:

| Role | Who | Count | Writes code | Runs builds or tests |
| --- | --- | --- | --- | --- |
| Conductor | this session | 1 | no | no |
| Planner | `fable-advisor` (S, M) or GPT-6 Astra (L) | per task | no | no |
| Worker | one agent per task, in its own worktree, named `tN` | at most 3 at once | yes | **no** |
| Tester | one agent | **exactly 1** | no | **yes, the only one** |

The single tester is the compute budget. Nobody else runs a compiler, test suite, linter, type checker, dev server, or browser. Formatters are the exception. Workers queue a test request and wait:

```bash
do-it todo add "$STATE/tests.md" --version <v> --section queue --as tN \
  "tNrK tN: <command> in <absolute worktree path>"
do-it diff "$STATE/tests.md" --since <v> --wait 100   # loop on exit 4; read the answer under your request
```

### Outside Herdr: Claude Code subagents

Subagents cannot start subagents and cannot be prompted while they run, so you call every agent yourself, always with `run_in_background: true` so watch events keep arriving.

1. **Plan.** S and M: `Agent(subagent_type: "fable-advisor")` with the task, the repo, and what triage found; ask for a plan in under 300 words. L: `Agent(subagent_type: "astra-implementer")` with a brief that forbids edits and asks only for a plan at effort `xhigh`, then one `fable-advisor` pass over it (when `astra-implementer` is not among your agent types or reports the codex CLI unavailable, plan L tasks with `fable-advisor` and say so in the status line). Save the plan to `$STATE/plans/tN.md` and set the status line to `**tN** planned by <Fable or Astra>: <summary in a few words>`.
2. **Build.** `Agent(subagent_type: "general-purpose", isolation: "worktree", run_in_background: true)` with the worker brief below. Keep the agent id in `state.json`.
3. **Test.** When the `tests.md` watch shows an open request and no tester runs, start one: `Agent(subagent_type: "general-purpose", run_in_background: true)` with the tester brief. It drains the queue one request at a time, oldest first, and exits; start it again for the next requests.
4. **Questions.** A worker that needs the person appends a `question` to the inbox and ends its run with `QUESTION: ...`. Write it under the task (`  - **tN question:** ...`, status `waiting for you`). When the person answers under it, resume that same worker with `SendMessage` to its agent id: `From the TODO: <their answer>`.
5. **Review.** When a worker ends with `DONE`, verify (below), then run `fable-advisor` on the branch diff against the task. `ship`: delivered. `fix-first`: resume the worker with the findings.

Worker brief:

```
TASK tN (size S|M|L): <the person's task line, verbatim, plus their sub notes>
REPO: <repo root>. You run in your own git worktree on your own branch; commit there.
PLAN: <the plan from $STATE/plans/tN.md>
NAME: export DO_IT_AGENT=tN before any do-it command.
TASK TARGET: keep the person's task text verbatim. For todo start and todo check, target that exact text after --, never a remembered task number. If the text is unavailable, run do-it todo list immediately before choosing a target.
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

### Inside Herdr (`HERDR_ENV=1`): worktrees and tabs

The same roles as herdrdocwatch, with `do-it` commands in place of Herdr's `doc` commands. Load the [[herdr]] skill for the CLI; never split your own pane.

- **Tester**: one tab in your workspace, started once, watching the queue itself:
  ```bash
  TAB=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$STATE" --label tester --no-focus)
  PANE=$(jq -r .result.root_pane.pane_id <<<"$TAB")
  herdr agent start do-tester --kind claude --pane "$PANE" -- --model claude-sonnet-5 --effort high --dangerously-skip-permissions
  herdr agent prompt do-tester "$TESTER_BRIEF"
  ```
  Use the tester brief above, but instead of ending on an empty queue it keeps watching with `do-it watch <TESTS> --todos --as tester` (Monitor tool). Check `herdr agent list` first: reuse a live `do-tester` only when its cwd is this `$STATE`; on `agent_name_taken` pick `do-<SLUG first 4>-tester`.
- **Worker per task**: a Herdr worktree and space (see [[herdrworktree]], `--no-focus`), then a Claude architect in its root pane named `do-tN` (`claude-opus-5-5[1m]`, effort high, xhigh for L) that follows [[orchestration]]: it plans with `fable-advisor` (S, M) or a read only Astra tab (L), routes the typing to Codex lanes in herdr tabs, and gets a `fable-advisor` review before reporting done. Its brief is the worker brief above with `CWD: <worktree>   BRANCH: <branch>   BASE: <base branch>   REPO RULES: read CLAUDE.md/AGENTS.md` in place of the REPO line, plus: "Talk to the conductor only through the inbox; answers arrive as prompts starting From the TODO. Wait for lanes with `herdr agent wait <lane> --timeout 1800000`, never by grepping a screen." Start and brief it as herdrdocwatch does:
  ```bash
  herdr agent start do-tN --kind claude --pane "$ROOT_PANE" -- --model 'claude-opus-5-5[1m]' --effort high --dangerously-skip-permissions
  herdr agent prompt do-tN "$BRIEF" --wait --until working --timeout 20000
  herdr workspace focus "$HERDR_WORKSPACE_ID"     # if focus moved
  ```
- **Answers** go to the architect as `herdr agent prompt do-tN "From the TODO: <their text>"`; it keeps working while it waits.
- **Parked architects**: when no inbox message came from a task for 30 minutes, read its screen (`herdr agent read do-tN --source recent-unwrapped --lines 80`) and its lanes'; if a lane finished and the architect still waits, prompt it to continue.

## Step 5. React to events

| Event | Do |
| --- | --- |
| New task line | Step 3 |
| The person edits or adds notes under an active task | forward them: `SendMessage` to the worker (outside Herdr, once it has stopped) or `herdr agent prompt do-tN "From the TODO: ..."` |
| The person answers a question (an indented line under `**tN question:**`) | forward it the same way, then remove your question line |
| The person deletes a task, or writes "stop" under it | tell its worker to stop and commit its work in progress; status `stopped`, keep the worktree |
| The person unchecks a delivered task | their new note under it is a follow up for the same worktree and worker |
| Inbox `progress` | update the status line only, in a few words |
| Inbox `question` | add `  - **tN question:** <question>` under the task; status `waiting for you` |
| Inbox `blocked` or `failed`, or a worker ended without DONE | read what it said; fix the brief and resume it, or escalate a twice failed S or M task to Astra; tell the person only what they must decide |
| Worker DONE | verify (below), Fable review, write status `delivered`, then run `todo check` for the task |
| Tester BLOCKED or a long queue | one line under the affected task; never start a second tester |

**Verify before `delivered`.** A done message is not proof:

```bash
git -C "<worktree>" log --oneline "<base>..HEAD"
git -C "<worktree>" diff --stat "<base>...HEAD"
```

and the final request in `tests.md` says PASS for that commit. The delivered line reads:

```
  - **t3** delivered: branch `fix-sidebar-ports` (2 commits, a1b2c3d), tests t3r2 passed, Fable: ship. Worktree `.claude/worktrees/fix-sidebar-ports`
```

Keep your lines short: the todo is a dashboard, not a log. Full detail lives in `plans/`, `logs/`, and the worktrees.

After writing the delivered status line, mark the task done with the version returned by that status edit:

```bash
$D todo check "$TODO" --version $V --section tasks -- "<exact task text>"
```

## Ending

Run until the person says in chat to stop, or the todo goes away. On stop: stop the watches, tell every working worker to commit its work in progress and say where it stopped, leave the tester idle, write a final status line per open task, and finish in chat with Completed, Verification, Unresolved, and Retained (worktrees kept).

## Rules

- **The todo is the interface.** Every event the person should know about lands in it.
- **One writer per channel role.** Only you write status into the todo; workers write only to the inbox and the test queue; only the tester answers test requests. Always through `do-it` commands naming the version.
- **One tester, one test at a time.** A worker caught running a build or test is stopped and reminded of the compute rule.
- **Three workers at most** unless the person writes otherwise in the todo. Each owns its worktree; no two writers share a checkout.
- **No outward actions by default.** Pushing, PRs, merges, deploys, and messages to other people happen only when the task line asks in words.
- **Never close what you did not create**, and keep every worktree holding unmerged work.
- **No dash separators** in lines you write into the todo: use commas, colons, or parentheses.
