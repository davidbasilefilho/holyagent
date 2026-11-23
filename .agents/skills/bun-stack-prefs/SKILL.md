---
name: bun-stack-prefs
description: Use when setting up, configuring or editing the toolchain of a Bun-based JavaScript or TypeScript project, including runtime API choices, deploys to Cloudflare Workers or Convex, linting, formatting, type checking, testing and package scripts. Applies the user's preferences for Bun APIs, oxlint, oxlint-tsgolint, oxfmt, tsrs, bun test and bun scripts.
---

# Bun Stack Preferences

Preferences for the tools around a Bun project. They are firm rules, not suggestions. Dependency range format, monorepo layout and versioning belong to `bun-prefs`; load it for any project here, because every package this skill adds must follow its range rule. For dependency bumps load `upgrade-deps`; for general coding preferences `general-prefs`; for React or web projects `react-prefs` and `web-stack`.

This skill is model-, harness- and environment-agnostic. It describes **capabilities** and says what to do when each is absent.

## Capabilities to look for (use them when present)

| Capability | Use it for | Fallback when absent |
|---|---|---|
| Web search / fetch | Checking current docs for Bun, oxlint, oxfmt, tsrs and the deploy target before relying on anything marked "verify" | Use the references and say they may be stale |
| Code execution | Installing packages, running the scripts, linters and tests to confirm configs load | Give the user the exact commands and say they were not run |
| Structured question tool | Confirming the deploy targets, whether the project uses Tailwind or React | Ask in plain text with numbered options |

## Rules

1. **Bun runtime APIs by default; portable code where the deploy target cannot run them.** Use Bun's runtime APIs (file, server, password, SQL and the like) in code that runs on Bun. In code that deploys to a target that cannot run them (Cloudflare Workers, Convex backend code, and similar), use portable code instead: web standards and only the `node:` modules the target documents. Keep any Bun-only call behind an adapter used only by Bun-only apps. Check the target's current runtime docs, and consider the `portablejs/portable` packages for the gap. Details, target notes and the portable verdict are in [Runtime](references/runtime.md).
2. **Linting and formatting use oxlint, oxlint-tsgolint and oxfmt.** Configure oxlint with `options.typeAware` and `options.typeCheck` on, JSDoc required for public API only, JSDoc linting on, and the built-in plugins the project needs (unicorn, typescript, oxc, eslint, import, and others such as react, jsx-a11y, promise or nextjs where they apply). Configure oxfmt with `bracketSameLine`, `jsdoc` and `sortImports` on, `sortPackageJson` on, and Tailwind class sorting on when the project uses Tailwind, plus any other options the project needs. Configs and caveats are in [Lint and format](references/lint-and-format.md).
3. **Type checking uses tsrs.** Use the native tsrs binary on platforms that have one and the wasm build on the others. Leave dependencies that use another type checker alone. Install, platform support and the selection script are in [Type check and scripts](references/typecheck-and-scripts.md).
4. **Tests always use `bun test`.** No other test runner. Test files are `*.test.ts`. The tests `bun-prefs` requires are part of this run.
5. **Bun scripts run everything.** Define `lint`, `format`, `typecheck`, `test`, `dev` (hot watching), `start`, `build` and the rest of the project's tasks as `package.json` scripts and run them with `bun run`. Use `bun run --parallel` and `bun run --sequential` to combine scripts. The script set and flag behavior are in [Type check and scripts](references/typecheck-and-scripts.md).

## Workflow

1. Read the project: runtime targets, whether it uses Tailwind, React, or a monorepo, existing configs and scripts. Ask when a deploy target is unclear, since it decides rule 1.
2. Install the tools as dev dependencies, normalize the ranges to `bun-prefs` rule 1 and run its tests.
3. Write the configs and scripts from the references, adapted to the project.
4. Run `lint`, `format:check`, `typecheck` and `test`. Fix findings in the code, not by loosening the config. If code execution is absent, say the checks were not run.

## Honesty

- These tools are young and move fast (oxlint plugin coverage, oxfmt options, tsrs are all changing). Before relying on any option, flag or platform fact marked "verify" in the references, check current docs with web search or fetch, and say when you could not.
- tsrs and `portablejs/portable` are experimental or very new. Use them as the rules say, report the maturity caveat to the user, and do not hide a failure caused by them.

## Self-update

At the end of a session, if it surfaced general lessons (an option that changed, a plugin rule that now exists, a platform the tsrs native build now covers, a runtime API gap), offer the user to update this skill with them. Add only general lessons, never project names, paths or other user data.

## References

- [Runtime](references/runtime.md): Bun APIs versus portable code, deploy target notes, `portablejs/portable`.
- [Lint and format](references/lint-and-format.md): oxlint and oxfmt configs, plugins, JSDoc handling, caveats.
- [Type check and scripts](references/typecheck-and-scripts.md): tsrs native and wasm, the typecheck script, the full script set, `--parallel` and `--sequential`.
