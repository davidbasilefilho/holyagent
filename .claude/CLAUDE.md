# Contributing rules

These rules apply to everyone and every agent working on this codebase.

## Code

- Use Effect for effects and errors, and model failures as tagged errors. In runtime and CLI source, compose with Effect instead of try/catch, `new Promise`, Promise statics or async functions; the linter enforces this (`bunfig.toml`). Call `Effect.runPromise` only at integration boundaries.
- Use Effect Schema (`import { Schema } from "effect"`) at every data boundary: decode first with `onExcessProperty: "error"`, then validate domain rules.
- Prefer Bun APIs over Node equivalents, and fall back to `node:` where Bun has none.
- Use the Bun Shell `$` from "bun" wherever a process would be spawned.
- Add only tools that do something Bun and the configured toolchain do not already do. Bun covers the runtime, tests, type-check, lint and format, and lint plugins configured in `bunfig.toml` are part of that toolchain.
- Write JSDoc on every exported or public function, type, type alias and interface.
- Start a skill description with the situation, then what the skill does, so a model can tell when to load it.

## Done

`mise.toml` is the source of commands; `package.json` scripts and the git hooks delegate to it. Run the gates through mise, because it first checks for the canary Bun that provides `bun check`, `bun lint` and `bun fmt`.

- Done means `mise run verify` passes (type-check, lint, format check and tests).
- When plugin sources change, rebuild the generated plugin with `mise run build`; the pre-commit hook runs it too.

## Commits

- Follow Conventional Commits, in English.
- Write as the author, in first person or neutral voice, about what the change does and why. Keep agents, Claude, sessions and "the user" out of the text, and leave attribution trailers off.

## This file

Change this file only with the maintainer's permission.
