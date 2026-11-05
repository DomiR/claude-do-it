# Conductor resume test

A live test of the `/do-it` resume path (SKILL.md, Step 1: "if `state.json` exists, reconcile it with what still runs"), run on 2026-11-06 inside Herdr with Sonnet everywhere.

## Setup

- A scratch git repo with `check.sh` (`[ "$(cat "$1")" = "$2" ]`) and a `TODO.md` holding three S tasks (create `hello.txt`, `bye.txt`, `note.txt`, each with a `check.sh` test) and the line "Run at most 1 worker at a time." above `## Tasks`, so one worker runs and the rest queue.
- A scratch do-it home and daemon: `DO_IT_HOME=<scratch>/home DO_IT_PORT=47199 DO_IT_BROWSER=true`, passed to each conductor tab with `herdr tab create --env`.
- Each conductor: `claude --model sonnet --effort medium` in a background tab of the test's own workspace, prompted with `/do-it <todo>` plus scratch overrides: the export line in every Bash call and brief, `--cwd <scratch repo> --trust-repository` on `herdr worktree create`, Sonnet workers, no planner or reviewer agents.

## Run

1. **Conductor 1** started the tester and messenger (as `do-5ea6-tester` and `do-5ea6-messenger`, since the real run holds `do-tester`), stamped all three tasks `@started`, dispatched t1, delivered it, and dispatched t2 with t3 queued.
2. **Kill.** With t2's worker just started, the conductor's `claude` process got `kill -9`. While no conductor ran: t2's worker finished and appended `t2 done` to the inbox, and the person (simulated) wrote a note under t3: `also add a second line "end" to note.txt`.
3. **Conductor 2** (the installed skill, unchanged) on the same todo.
4. **Conductor 3** (the skill as fixed on this branch) after conductor 2 was killed too, with t3's `done` in the inbox and a new task t4 added during the downtime.

## Results

| Check | Conductor 2 (old skill) | Conductor 3 (fixed skill) |
| --- | --- | --- |
| No task dispatched twice | pass: one worker, worktree, and branch per task | pass |
| Live workers kept, tester and messenger reused | pass: no second tester or messenger | pass |
| Delivered tasks not redone | pass: t1 untouched, same `@done` | pass: t1 and t2 untouched |
| Status lines not duplicated | pass: one `**tN**` line per task, `@started` kept | pass |
| Work done during the downtime picked up | pass: delivered t2 from its inbox `done` line, and briefed t3 with the person's note | pass: delivered t3, triaged the new t4 |
| Queued tasks start | pass: t3 dispatched | pass: t4 dispatched |
| Keeps conducting after the catch up | **fail**: armed no watches and ended its turn ("I started no watches this session"); t3 finished and was never delivered | pass: killed the dead conductor's watches, armed the todo and inbox watches with `--since`, and delivered t4 from the next watch event |

Conductor 2 passed the reconciliation because it read the todo, the inbox, and `tests.md` whole. The failure was that it treated the resume as the whole job: the old instruction sat at the end of Step 1 and never said that Step 2 follows.

## Other findings

- **Orphaned watches.** `kill -9` on a conductor leaves its `do-it watch ... --as conductor` Monitor processes running. Conductor 1 also had two inbox watches at once, because it re-armed without stopping the first.
- **Conductor 1 never watched the todo.** It armed only the inbox watch, filtered by grep to one task's `done` line, and noted that the Monitor expires after 5 minutes. A person's edit would have gone unseen until its next full read.
- **Session workers had no delivery signal in the skill.** The session worker brief ended with "End with DONE" only, which stays in the worker's own session. Conductor 1 improvised a `tN done` inbox line in its brief; that line is what made both resumes work.
- **`state.json` was too thin.** It held text, size, branch, status, and agent name, but no worktree path, pane, tester or messenger names, or last read versions, and conductors edited it with `sed`. Conductor 3 ran with the rule asking for both: it saved `versions` but left out the tester and messenger names, and did not update the versions after later events.
- **A non default `DO_IT_HOME` or `DO_IT_PORT` does not reach workers.** `herdr worktree create` has no `--env`, so a worker started there talks to the default daemon about the same files. The scratch run passed the export line in every brief by hand.
- Conductors defined `do-it() { bunx claude-do-it "$@"; }` even with `do-it` on PATH, which runs the published npm build instead of the installed one. Harmless here.

## Fixes on this branch (skill/SKILL.md)

- **Step 1a. Resume**, a new step: stop the old conductor watches, find what still runs (and reuse the tester and messenger named in `state.json`), read the todo, inbox, and `tests.md` whole, act on each task by status (delivered: nothing; `done` in the inbox: deliver; live worker: keep and forward the person's notes; gone worker: a new session in the same worktree; queued: dispatch), then arm the watches with `--since` and keep conducting.
- **Step 2:** all three watches run for the whole run and are armed before a turn ends; a Monitor is re-armed on expiry with `--since`, stopped before its replacement starts, and never filtered to one task.
- **Step 3:** `state.json` also keeps the worktree path, pane or handle, the tester and messenger names and panes, and the last read `versions` of the todo, inbox, and tests, and is written whole with the Write tool.
- **Session worker brief:** DONE appends `- tN done: ...` to the inbox.
- **Step 1:** when `DO_IT_HOME` or `DO_IT_PORT` is set, every brief starts with the export line and every `herdr tab create` gets `--env`.

After conductor 3's run, a review tightened Step 1a; these parts are not live tested yet:

- The orphan check comes first: a watch is killed only when no live `claude` process is among its parents, and a live one means another conductor still runs, so the new session does not resume.
- Workers are matched by the worktree path and branch in `state.json`, the agent name only as a cross check.
- A gone worker restarts in its saved worktree in every transport (plain: `Agent` without `isolation`, with `CWD` in the brief).
- Statuses other than delivered, building, and queued follow the Step 5 rows for what changed.
- The `ENV:` brief line asks for the export in the same Bash call as every do-it command, since variables do not survive between calls.
- The `tests.md` watch stays limited to plain and t3code.

No CLI change was needed: `do-it read`, `watch --since`, and `diff --since` cover the catch up.

## Cleanup

All scratch tabs (three conductors, tester, messenger) closed, the four worker worktrees and spaces removed with `herdr worktree remove --force`, the scratch daemon stopped, no scratch watch left running, and nothing written under `~/.do-it`.
