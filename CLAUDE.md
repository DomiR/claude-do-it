# Rules of this repo

## Tools

- Use bun for everything: `bun install`, `bun run <script>`, `bun test`. The version is in `.bun-version`.
- Format only with oxfmt (`bun run format`, `bun run fmt:check`). Never prettier. Tabs, single quotes,
  semicolons, width 120, no trailing commas. Markdown is not formatted.
- Typecheck with `bun run check` (the Effect-patched `tsc` from `@effect/tsgo`, once per package
  tsconfig, then the root tsconfig for `tests/` and `scripts/`).
- Lint with `bun run lint` (Oxlint, type-aware, with the `@effect/tsgo` recommended preset, on tsrs).
  Effect diagnostics come from Oxlint: the tsconfig plugin sets `diagnostics: false`, so `check` reports
  type errors only. Fix lint errors; warnings are advice.
- Test with `bun run test`. Build with `bun run build:web` and `bun run build:npm`.
- Every `effect` and `@effect/*` package comes from the root `catalog`, and `overrides.effect` pins the
  one version. Never add a second version.

## Code

- Read the Effect source in `node_modules/effect/src` (and `node_modules/effect/ai-docs`) before
  guessing an API.
- Services: `class X extends Context.Service<X, XShape>()('X') {}`, with layers as static members.
  Platform code (file system, paths, processes, crypto) goes through Effect platform services.
- Errors are tagged error classes in the error channel. In Effect code, do not use try/catch: wrap
  throwing code with `Effect.try` or `Effect.tryPromise` and a `catch`.
- Use `Effect.gen` or `Effect.fn`, never `Effect.Do` or `Effect.bind`. Prefer `Option.match`,
  `Effect.forEach`, and `DateTime`/`Clock` over `isNone` branches, loops over mutable arrays, and `Date`.
- No `as Effect.Effect<...>` casts to silence a channel error.
- See `docs/design.md` for the package contracts and `README.md` for how the pieces fit.

## Writing

- In prose (UI strings, messages, docs, comments), never use an em-dash, an en-dash, or " - " as a
  separator. Use commas, colons, parentheses, or separate sentences. Hyphens inside compound words are
  fine.
