# Repository pitfalls

Rules for working in this repository, each with the reason it exists. Claude Code reads `AGENTS.md` directly, so repository instructions live here.

## The session agent

- Every session in this repository works as the holyagent root, whatever agent it started as: "the root" in these rules is the default, user-facing agent, which is you. Read `packages/integrations/claude/dist/agents/holyagent.md` before acting and run all work through an Intent and Assignments dispatched to the specialists, without being reminded; a session that read "the root" as someone else's role edited and committed in the main thread.

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

## Branches and worktrees

- Keep the main checkout on `main` (in a cloud session, the assigned branch, because the session panel shows the primary checkout's diff) and do other branches in git worktrees, for example `../holyagent-<branch-slug>`. Use worktrees for stack branches where helpful. Sessions here load the holyagent plugin from this checkout through the directory marketplace in `.claude/settings.json`, so checking out a branch that moves or deletes the plugin folder breaks the running session: every Bash call blocks and workflows fail.
- `.holyagent/` state lives on its own branch, `holyagent/state`, in one worktree shared by every worktree of the clone, so work branches never carry it and nothing is copied between worktrees. Push `holyagent/state` with plain Git alongside the work branches.
- Run the gates as `bunx --no-install mise run <task>` (see `docs/development.md`). A missing `mise` on PATH is no reason to skip the gates or run Bun steps by hand. Each worktree needs its own `bun install --frozen-lockfile`, because `node_modules` is not shared between worktrees. `bun install` runs the `prepare` step, which installs the repository's lefthook hooks into the shared `.git/hooks`; that is expected.

## The release-branch model

This repository's release convention includes CI checks; HolyAgent's instructions do not carry it.

- Work PRs target `dev`; normal release PRs promote `dev` to `main` with a version strictly newer than `main`. The first PR of a release carries its version bump as a separate commit made with `mise run bump:patch` (or `bump:minor`).
- A deployment failure alone does not require a version bump. For a focused repair of an unpublished release, create `release/<version>/fix/publication-repair` from fresh `main` and squash its PR directly into `main`. The `version` check requires exact main/head version equality and confirmation that the exact npm version is absent. Never downgrade or overwrite an immutable published version. Retry an already published artifact only after verifying identical identity and provenance; product or source changes to a published artifact require a new version.
- Protect `main` and `dev` (PRs only, no force push, no deletion) and `holyagent-*` tags (no update, no deletion). Required checks are the job ids `check`, `windows`, `installers` and `branch-model`, plus `version` on `main`. Renaming a job drops its check from protection until the ruleset names the new one.
- Branch pushes run validation, then publish stable on protected `main` or a development release on protected `dev`. Development versions use the commit UTC time and short SHA. Tags never trigger publication.
- Pin every external action to a full commit SHA with a `# vX.Y.Z` comment, and give `contents: write` only to the jobs that tag and release. A moving tag can change what runs with the repository's token; `scripts/workflows.test.ts` checks both rules.

## The version

- The version lives in the root `package.json` only and changes only through `mise run bump:patch` or `bump:minor`, which edit that file alone. `mise run build` copies it to the workspace `package.json` files and `bun.lock` and generates the plugin and marketplace manifests from it, and `scripts/bump-version.test.ts` fails when any copy differs. A hand-edited copy is overwritten by the next build and fails that test, and a second place to bump is how copies drift apart.

## Commits and pull requests

- Never create draft pull requests. Open pull requests ready for review, and leave them unmerged while prerequisites or validation are pending, so every PR is available for review.
- Keep each PR to one reviewable change. When branch rules allow, stack on the preceding open owner PR and set the PR base to the branch the work started from, so each review shows only its own change.
- `holyagent vcs` has three commands, `commit`, `pr` and `identity` (the commit author in a cloud session); branches, pushes, merges and CI use plain Git and `gh`. The `commit-msg` hook (`holyagent hook commit-msg`, wired in `lefthook.yml`) keeps agent attribution out of commits made with plain Git too.
- Pass `holyagent vcs pr --body-file` an unignored file inside the project. Files outside the project or ignored by git are rejected, so a scratch file will not work.
- `holyagent vcs` refuses process words such as "Claude Code" in commit and PR text. Rephrase, or list a genuine domain word in `vcs.allowWords` of `.holyagent/config.json`.
- Start each evidence line of a specialist report with the criterion text or the evidence label, then a colon and the support. `assignment close --accept` matches the text before the colon after normalizing case, spacing, trailing punctuation, a leading `[blocking]` and a trailing `(dimension)`, so those differences are fine; a paraphrase or another criterion's text matches nothing. A support may continue on indented lines below its entry.

## Version-control rules

- The root commits only with `holyagent vcs commit`, uses plain Git and `gh` for branches, pushes, merges and CI, and never force-pushes or pushes to a protected branch without the user's approval. After a denial it stops that line of work and reports a blocker, and does not reach the same result through another tool, because a workaround defeats the boundary the user set. A specialist makes no version-control writes and no edits under `.git/` or `.holyagent/`, and reports its changed paths for the root to record. Nothing blocks these writes: the rules are instruction text, restated by hooks that only add context (`docs/hooks.md`).

## Dependencies

- Dependencies change only through the updater: `mise run deps:update` (`--dry-run` previews it, `mise run deps:check` fails when a pin is behind). It moves the GitHub Actions, the mise tools (ripgrep and fd included), the exact Pi package pins in `packages/runtime/src/config/pi-packages.json` and the `package.json` ranges to the newest stable release line, and refreshes `bun.lock`. The Pi host used for development and tests, `@earendil-works/pi-coding-agent` (a caret-range `devDependency` of `packages/integrations/pi`), is not in the pin table; it moves with `bun.lock` when the updater's `bun update` runs, and a user's own Pi install is theirs. A hand edit of a pin or of `bun.lock` skips the SHA resolution, the checksum recomputation and the prerelease filter, and drifts from what the updater and `scripts/dependency-ranges.test.ts` expect. Every dependency range in a `package.json` is a caret range at its line boundary, or `workspace:*`.

## The README

- Keep `README.md` to exactly these sections, in this order: `# HolyAgent` (what it is, as a pitch), `## How do I install it?` (quick install), `## Why HolyAgent?` (the reasons to use it), `## Development` (contributing and the gates), `## Special thanks` (inspirations and projects) and `## License` (points to `LICENSE`). The maintainer set this structure so a reader finds the same things in the same place; detail belongs in `docs/`, which the README links to rather than repeats, so the two cannot drift.
