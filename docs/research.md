# Research notes (2026-11-04)

Clones used for this were made under a scratch directory; re-clone with
`gh repo clone kitlangton/<repo> -- --depth 1` when you need the code.

## TUIs: kitlangton/ghui and kitlangton/nback (OpenTUI on Bun)

- ghui: `@opentui/core` and `@opentui/react` 0.4.2, React 19.2.7, `effect` 4.0.0-beta.90. State in `@effect/atom-react`; one runtime built with `Atom.runtime(Layer.mergeAll(...))` in `src/services/runtime.ts`. Services are `Context.Service<...>()("ghui/Name")` with a static `layerNoDeps`; mock layers chosen by env. Renderer: `createCliRenderer({ screenMode: "alternate-screen", exitOnCtrlC: false })` plus `createRoot` (`src/index.tsx`). Keyboard: its own `packages/keymap` (bindings, contexts, dispatcher) behind one `useKeyboard` (`src/keyboard/opentuiAdapter.ts`). Layout with flexbox `<box>`. Tests: `bun test` with `createTestRenderer({ width, height })` from `@opentui/core/testing`. Packaging: `bun build --compile --bytecode` per platform, npm packages plus a Node launcher `bin/ghui.js`.
- nback: `@opentui/solid` 0.4.5, `solid-js` 1.9.12, `effect` 4.0.0-beta.97. `ManagedRuntime.make(Layer.merge(...))` in `src/runtime.ts`; the app calls `runtime.runFork` and `runPromise`. `render(() => <App/>, { targetFps: 30 })`, `useKeyboard`. Build script bundles with `createSolidTransformPlugin()`.
- kitlangton/opentui is a stale fork; upstream `@opentui/*` is at 0.8.2.

## Browser feedback tools: kitlangton/behold and kitlangton/docket

- behold (`@kitlangton/behold` 0.1.1, Effect 4.0.0-beta.101): exposed to agents as an MCP server (`effect/unstable/ai/McpServer`, tools `host_document`, `update_document`, `wait_for_feedback`, `diff_document_versions`). Detached daemon spawned by `behold-lifecycle.ts` with a lock directory and a runtime record; listens on 127.0.0.1:5173; pushes to the page with SSE (`/api/events`); `waitForFeedback` long polls with `Effect.timeoutOption` (5 minutes). Keeps 21 revisions and diffs them with the `diff` package.
- docket (`@kitlangton/docket` 0.2.0, no Effect): `Bun.serve`, React, SSE. `skill/SKILL.md` says to run docket as a background command so its exit notifies the agent, never poll. The CLI spawns or reuses a detached server (`/api/health`), opens `Bun.spawn(["open", url])`, blocks on `/api/s/:id/wait`, then writes `verdicts.json` and prints its path.
- effect-stack is Effect 3.18 with `@effect/rpc` 0.71 over a websocket: outdated as a template.

## Foldkit (local checkout: ~/.claude/plugins/marketplaces/foldkit)

- Elm architecture on Effect, no React. `foldkit` 0.170.0 (peers `effect ~4.1.0`, `@effect/platform-browser ~4.1.0`), `@foldkit/ui` 0.170.0, `@foldkit/vite-plugin` 0.29.0, `@foldkit/markdown` 0.15.0, `create-foldkit-app` 0.41.0.
- Program: `Model = Schema.Struct(...)`, `Message = defineMessageUnion({...})`, `update(model, msg)` returns `{ model, commands }` via `Message.match`; effects are `Command.define('Name', { args, messages, execute })`; streams via `Subscription.make<Model, Message>()(...)`; long lived connections are a `ManagedResource`; `view(model, h)`; start with `Runtime.run(Runtime.makeApplication({...}))`.
- Server talk: `packages/typing-game` shares `RoomRpcs` (`Rpc.make('subscribeToRoom', { stream: true })`) between client and server; server `RpcServer.layerHttp` with a Node HTTP server; client `RpcClient.layerProtocolHttp` plus `RpcSerialization.layerNdjson`.
- Closest examples: `examples/todo`, `query-sync`, `livestore`, and `@foldkit/markdown`. Use the `foldkit-skills:foldkit` skill when writing Foldkit code.

## Plannotator (~/.claude/skills/plannotator, plugin 0.17.10)

`plannotator annotate <file> [--gate --json]` starts a `Bun.serve` on a random port, opens the browser, and blocks until the person approves, annotates, or closes; the result goes to stdout (`{ decision, feedback }` with `--json`). Plan review runs from a `PermissionRequest` hook on `ExitPlanMode`. The skill tells agents to run it in the background with a long timeout.

## Effect version

Effect v4 is GA (`effect` 4.1.2; 4.0.0 shipped 2026-10-01). kitlangton/effect-solutions recommends v4 idioms: `Context.Service`, `effect/unstable/cli`, `BunServices.layer` with `BunRuntime.runMain`, `@effect/vitest`. HTTP, RPC, CLI, and MCP live under `effect/unstable/*`. Pin 4.1.x exactly to match Foldkit's peer range.

## Merging concurrent edits

No kitlangton repo uses a CRDT. Use `loro-crdt` 1.17.1. The model: a version counter mapped to Loro `Frontiers`, an edit applied on a fork at the named version then merged, stale versions answered with a diff capped at 64 KiB. The JS API has `forkAt(frontiers)`, `LoroText.update(newText)`, `import`/`export`, `subscribe`. `yjs` 13.6.33 is the fallback.
