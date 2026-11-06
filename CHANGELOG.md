# Changelog

The npm package `claude-do-it` and the Claude Code plugin `do-it` share one version.

## 0.1.2 (2026-11-06)

### Editor

- Every line stays rendered wherever the caret is. Markdown marks are hidden, a task's box acts as one character, and a formatting bar holds the common commands.
- Long lines scroll instead of wrapping. A wrap toggle in the formatting bar turns wrapping on.
- Projects, tasks, and `<details>` sections fold from a gutter control, a shortcut, or the command palette, and each tab remembers what you folded.
- An `html do-it` fence renders as a live HTML section under its task, indented like the fence. Its scripts run with the page's full access, so only add HTML you wrote or trust.
- Typing or deleting next to a folded block or an HTML section keeps its markup whole.
- Shift-Enter on a task starts a note inside it. Enter below a task starts a note at the same indentation.
- Pasted Markdown becomes todo lines that render at once. Pasted code and backslashes stay as they are.
- Marking a started task done records how long it took. `@done` shows in orange, every tag on a done or cancelled line is muted, and tag words are never removed.
- The editor follows the system dark mode with a PlainTasks dark notebook, and the command palette can choose System, Light, or Dark.
- Shortcuts show as keycaps with drawn key icons, and the editor uses the full width of the window.
- After a daemon restart, an open tab rebases its typing on the new text instead of losing it, and it never waits forever for a resync.

### Conductor skill

- Workers can run in Orca and T3 Code as well as Herdr, and start in the background. Any other terminal still uses Claude Code subagents in worktrees.
- Inside Sheprd, the todo opens in a split beside the conversation.
- Roles are described by model tier. Large tasks are split into subtasks that the person reviews first, and the stronger models are kept for them.
- The skill documents the PlainTasks tags, a conductor that delegates, and an optional messenger that places new status lines.
- Resuming a conductor catches up on missed changes, keeps conducting, matches orphan tasks safely, and copes with a missing worktree.
- Agents learn to put longer explanations in a folded `<details>` section and tables, diagrams, or small demos in an HTML section.

### CLI and daemon

- do-it ships as a Claude Code plugin: the skill plus a `do-it` command that runs the npm release of the same version.
- `do-it doctor` checks Bun, PATH, the running daemon's version and build, and the installed skill, and prints the fixes. It never suggests a downgrade or an unsafe relink.
- A watch settles after `--settle-line` seconds when the person's change adds a line, so a new todo reaches the agents quickly.
- Each version carries a hash of its text. Sync and watch send the hash they hold, so after a restart that reused a version number the daemon refuses the stale sync and resyncs the watch. A sync whose document was deleted while hashing fails with a clear DocumentGone error.
- The client retries slow health checks before it replaces a live daemon, and the daemon removes `daemon.json` only after it stops listening.
- The first run template teaches the keys, the tags, and how agents reply.

### Tooling

- GitHub Actions CI runs the typecheck, lint, format check, tests, and both builds on Linux and macOS. Pushing a `v*` tag publishes to npm with provenance.
- The typecheck uses effect-tsgo (TypeScript 7 with the Effect language service), lint uses type-aware Oxlint, and oxfmt formats the code. Effect comes from one root catalog.
- The npm bundles are minified and built for production.
- The release workflow fails when the tag does not match `APP_VERSION` or the version in `.claude-plugin/plugin.json`. Publishing uses npm trusted publishing (OIDC), so no npm token is stored in the repository.
