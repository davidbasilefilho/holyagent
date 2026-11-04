# Development

The contributing rules are in `.claude/CLAUDE.md`; this page explains the layout and the tooling behind them.

## Layout

```text
packages/
  runtime/                      shared by every harness
    src/domain/                 Intents, Assignments, routes, readiness, plan, warm-reuse directive
    src/state/                  records under .holyagent/, the state mode, the state branch and its worktree, the lock, per-clone local state
    src/cli/                    the runtime CLI: intent, assignment, plan, status, reconcile, hook, setup, doctor, state
    src/vcs/                    the vcs commands (commit, pr)
    src/instructions/
      claude-5.5/               root/, specialist/, roles/<role>/ (one file per section), root-core.ts, skills/
      requirements/             cache.md, commit-text.md, context.md, mergeability.md: inputs to the instructions, not behavior
  integrations/claude/          turns the runtime into the Claude Code plugin
    build.ts, src/              the generator and the wrapper source
    vendor/frontend-design/     Anthropic's skill text and license, kept byte for byte; the visual roles embed it
    tests/
    dist/                       generated: the built plugin (.claude-plugin/, settings.json, agents/, skills/, hooks/, scripts/)
.claude-plugin/marketplace.json generated; the marketplace entry for the plugin
install/wsl-install.sh          prerequisites installer (WSL Ubuntu): Bun, Node LTS, git, gh; --dev adds mise
install/windows-install.ps1     the same for native Windows (PowerShell; -Dev adds mise)
docs/                           these pages; docs/pi holds the Pi research
mise.toml  bunfig.toml  lefthook.yml
```

A new harness gets its own folder under `packages/integrations/`. It reuses the runtime's domain, state, CLI and instructions and generates its own plugin files.

## Getting mise

mise is a dev dependency (`mise` in `package.json`, the npm package mise's own docs recommend, pinned exactly and listed in `trustedDependencies`), so `bun install` installs it into `node_modules/.bin`. Bun runs a package's install script only when the package is trusted, and the trust entry lets this one fetch the `mise` binary for your platform and link it; that script runs `npm` through `node`, so both must be on `PATH` when you install, and it comes from npm and runs on your machine. Because `trustedDependencies` replaces Bun's default list, `@anthropic-ai/claude-code` and `lefthook` are listed there too. Run the commands through Bun, which finds the local binary. `bunx --no-install mise` never fetches a missing local mise from the registry: Bun uses a mise on `PATH` if there is one, and otherwise the command fails:

```sh
bun install --frozen-lockfile
bunx --no-install mise install
bunx --no-install mise run verify
```

`mise install` installs the pinned Bun and upgrades it to canary, and `mise run verify` runs the gates. The `package.json` scripts (`bun run verify`, `bun run build`) do the same, since Bun puts `node_modules/.bin` on their `PATH`. A mise already on `PATH` works too: the installers' `--dev` option (`-Dev` on Windows) installs one, and `bun add -g --trust mise` installs it globally (after a plain `bun add -g`, run `bun pm -g trust mise`). The rest of this page writes `mise run ...` for either. CI installs its own mise with `jdx/mise-action`. These commands are described here, not verified on Windows.

## Commands

`mise.toml` is the single source of commands. `package.json` scripts and the git hooks only delegate to it, and `--no-script` makes Bun run its own tool rather than a same-named script. Run gates through mise (`bunx --no-install mise run <task>` with the local one) so the `toolchain` task can first confirm a canary Bun.

| Task        | Does                                                     |
| ----------- | -------------------------------------------------------- |
| `toolchain` | Fails unless Bun is a canary build, and names the fix    |
| `prepare`   | Installs the git hooks; skips outside a git work tree    |
| `check`     | `bun check`: type-check                                  |
| `lint`      | `bun lint`: type-aware lint, no fixing                   |
| `lint:fix`  | `bun lint --fix`; extra arguments go to Bun (`--staged`) |
| `fmt`       | `bun fmt`: format in place; extra arguments go to Bun    |
| `fmt:check` | `bun fmt --check`                                        |
| `test`      | `bun test`                                               |
| `vendor`    | Fetches the pinned ripgrep and fd into the plugin        |
| `build`     | Generates the Claude plugin (runs `vendor` first)        |
| `verify`    | `check`, `lint`, `fmt:check` and `test`, all read-only   |

Done means `mise run verify` passes; after changing plugin sources, run `mise run build`. `scripts/repo-paths.test.ts` (part of `test`) fails on a tracked path over 120 characters, which overruns Windows MAX_PATH in the marketplace clone, or under `.holyagent/`, which lives on the `holyagent/state` branch.

## Lint and format rules

Everything is configured in `bunfig.toml`. Bun's own `check`, `lint` and `fmt` are the tools (`eslint-plugin-jsdoc` runs inside `bun lint`); the repository adds none beside them.

- **Type-aware lint with type-check and zero warnings** (`typeAware`, `typeCheck`, `maxWarnings = 0`). The `correctness` category is an error. `consistent-type-imports`, `no-floating-promises` and `no-misused-promises` catch errors the type-checker accepts, such as a dropped promise.
- **Effect enforcement.** In `packages/runtime/src` the lint forbids `async` and `await`, `new Promise`, `try`/`catch` and `Promise` statics. Failures there are tagged Effect errors and effects are composed with Effect; `Effect.runPromise` is for integration boundaries only. One error model keeps failures typed and visible in signatures, and keeps the runtime's behavior testable without exceptions. The plugin generator (`packages/integrations/claude`) is outside the override and uses plain async code.
- **JSDoc on the public API.** `jsdoc/require-jsdoc` covers exported functions, classes, methods, interfaces, type aliases, enums and exported variables, and the formatter keeps JSDoc tidy (`jsdoc = true`). Skills open their description with the situation, so a model can tell when to load them.
- **Formatting.** No semicolons, 100 columns, `sortImports` and `sortPackageJson` so imports and `package.json` keys have one order and diffs carry no reordering noise. `bracketSameLine` keeps the closing `>` of a multi-line tag on its last attribute line. The maintainer requested these three options; the repository has no JSX yet, so `bracketSameLine` only fixes the style for later UI code.

## Git hooks

`lefthook.yml` runs on `pre-commit`, piped (the first failing job stops the rest). Its commands go through `bunx --no-install`, which resolves the dev dependency in `node_modules/.bin` and never fetches it, so a hook needs no mise on `PATH`:

1. `lint`: `bunx --no-install mise run lint:fix -- --staged`, then `stage_fixed` re-stages what lint changed (the `bun lint` docs do not say that `--staged --fix` stages again).
2. `fmt`: `bunx --no-install mise run fmt -- --staged`, re-staged (Bun leaves a partly staged file unwritten rather than committing its unstaged changes).
3. `build`: `bunx --no-install mise run build`, then `git add -A --` on exactly the generated paths, deletions included, so a commit always carries a plugin in step with its sources.

## The generated plugin

`mise run build` runs `packages/integrations/claude/build.ts`. It removes the generated paths (`GENERATED_PATHS` in `src/generate.ts`: the root `.claude-plugin/marketplace.json` and the built plugin in `packages/integrations/claude/dist/`) and writes them again from:

- `packages/runtime/src/instructions/claude-5.5/`: the root agent (the body of `agents/holyagent.md` is the files of `root/` joined in the order of `ROOT_SECTIONS`), the eighteen specialist agents (the files of `roles/<agent>/` in the order of `ROLE_SECTIONS`, then the files of `specialist/` in the order of `SPECIALIST_SECTIONS` and, for the roles that need them, `CONDITIONAL_SECTIONS`: `specialist/writing-bar.md`, `merge-ready.md` and `interface-inspection.md`; the visual roles also embed the vendored `frontend-design` text from `packages/integrations/claude/vendor/`), and the seven skills of its own (`dev-server`, `user-busy`, `visual-judging`, `evidence-judging`, `ci-watch`, `instruction-writing` and `state-mode`, under `skills/`); what an agent kind always needs is fixed text, not a skill;
- the route table in `packages/runtime/src/domain/route.ts` (model, effort and tools of each agent) and `packages/integrations/claude/src/agents.ts` (how each agent is assembled);
- `packages/integrations/claude/src/wrapper.sh` and `empty-bunfig.toml`;
- `packages/runtime/src/cli/main.ts`, bundled for Bun into `scripts/holyagent.js`;
- the hook table in `generate.ts`, and the version from `packages/integrations/claude/package.json`, which the build first syncs from the root `package.json` (see Versioning).

Every agent prompt is split into one file per section, and the order of the sections is fixed in `src/agents.ts`, not by file name; the sync test fails when a file in `root/`, `specialist/` or `roles/<agent>/` is not assembled or an assembled file is missing. The core of the root rules, which the SessionStart hook injects when the root is not the main thread, is the files named in `ROOT_CORE_FILES` (`root-core.ts`). `root/instruction-guidelines.md` holds the rules the root applies when it writes model-facing text, each tagged with the Anthropic prompting page it follows.

**The bundled search tools.** `dist/scripts/vendor/<target>/` holds ripgrep (`rg`) and fd (`fd`) with their licenses (`licenses/<project>/`) for `darwin-arm64`, `linux-x64` and `windows-x64`; `holyagent rg …` and `holyagent fd …` run the one for the current platform with the caller's stdio and exit code (`packages/runtime/src/cli/tools.ts`). They sit under `scripts/` because claude.ai refuses a plugin with a top-level `bin/`. The pins live in `packages/integrations/claude/src/vendor.ts`: a release URL, the SHA-256 of each archive and the SHA-256 of the program inside, for ripgrep 15.2.0 and fd 10.5.0. ripgrep's archive hashes are the ones its release publishes; fd publishes none, so its hashes were taken from the downloads and are trusted on first use. `mise run vendor` (`scripts/vendor.ts`, which `build` depends on) downloads what is missing, checks the archive hash before reading it and the program hash after extracting, marks the programs executable, and removes files no pin names; with everything in place it does nothing, so a build needs no network. The vendor folder is committed, because the marketplace serves the plugin from `dist/`; `build.ts` leaves it in place while it regenerates the rest, and `vendor.test.ts` checks it against the pins offline. To upgrade a tool, change its version and hashes in `vendor.ts`, then run `mise run vendor` and `mise run build`.

For how a rebuilt plugin reaches a session, see the Updates paragraph in [usage.md](usage.md#install).

Do not edit generated files; each carries a note naming its source. `.prettierignore` and `.eslintignore` list them so the formatter leaves them as built.

`packages/integrations/claude/tests/plugin.test.ts` is the sync test: every committed generated file equals a fresh build byte for byte, the generated paths hold nothing the build does not make (apart from the vendored tools, which `vendor.test.ts` checks against their pins), the build is deterministic, the wrapper is the one executable file, and the commit hook stages exactly `GENERATED_PATHS`. Other tests there cover the hooks (the `Workflow` hook's allowed and refused scripts among them) and the plugin manifest.

## Versioning

Versions follow ZeroVer, `0.X.Y`: the major stays 0, a minor bump advances X and resets Y, and a patch bump advances Y; 0.1.0 was the first release. The version lives in the root `package.json` only, and `mise run bump:patch` or `bump:minor` is the only way it changes: `scripts/bump-version.ts` edits that file and nothing else. `mise run build` then runs `bun scripts/bump-version.ts sync`, which copies the version into `packages/runtime/package.json`, `packages/integrations/claude/package.json` and the workspace entries of `bun.lock`, and generates `plugin.json` and `.claude-plugin/marketplace.json` from the integration's copy; the bundled CLI's `--version` reads the root `package.json`. The workspace manifests keep a `version` field because Bun workspaces and the plugin generator read their own package's, so the build writes it rather than the field being dropped. `scripts/bump-version.test.ts` fails when any copy differs from the source. The branch model that carries a version to a release is below.

## Branches, CI and releases

Each release `0.X.Y` has an integration branch, `release/0.X.Y/integration`, cut from `main`. Work happens on `release/0.X.Y/<type>/<change>`, one branch and one PR per reviewable change, and those PRs target the integration branch. The first PR carries the version bump as its own commit (`mise run bump:patch` or `bump:minor`); only the integration branch opens a PR into `main`. [AGENTS.md](../AGENTS.md) states the rules and their reasons; this section is the machinery behind them.

**Validation** (`.github/workflows/validation.yml`) runs on pull requests (opened, pushed to, reopened and edited, so a changed base is checked again) and is callable, so `publish.yml` runs the same jobs for a push. Its jobs and their status check names, which are the job ids:

| Check          | Runs on              | Does                                                                                                                                                       |
| -------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`        | PRs and calls        | The gates, the generated-plugin freshness check, plugin validation and shellcheck                                                                          |
| `windows`      | PRs and calls        | The test suite on `windows-latest`                                                                                                                         |
| `installers`   | PRs and calls        | Parses both installers                                                                                                                                     |
| `branch-model` | PRs only             | `scripts/pr-checks.ts branch-model <base> <head>`: the three branch rules in AGENTS.md, after the inline guard, which runs first, fails a head from a fork |
| `version`      | PRs into `main` only | `scripts/pr-checks.ts version`: the head's root `package.json` version is strictly greater than `main`'s (`compareVersions` in `scripts/bump-version.ts`)  |

Both PR-only jobs fail a pull request whose head repository is not this one, because a fork picks its branch names freely. An inline shell step runs first in each of them, before checkout, and compares the head repository with this repository case-insensitively. A new push or edit cancels an older run for the same pull request, but never a push run called by `publish.yml`: cancelling that would fail the publish and leave the commit untagged. A job skipped by its `if` reports as passed, so `version` can be required on `main` and `branch-model` on every protected branch without blocking other PRs.

**Branch protection.** Two rulesets, one for `main` and one for `refs/heads/release/*/integration` (`*` does not cross `/`), both with PRs only, no force push (`non_fast_forward`) and no deletion. `main` requires `check`, `windows`, `installers`, `branch-model` and `version`, with branches up to date; the integration branches require the first four. A third ruleset covers the tags `refs/tags/holyagent-*` with no update and no deletion, so a published tag, which users pin with `#holyagent-<v>`, cannot be moved or removed; the `tag-release` action only creates tags, and a stale tag is removed by an admin who lifts the ruleset on purpose. They are created with `POST /repos/{owner}/{repo}/rulesets`. Workflows cannot create them, so a repository admin does. A required check must have run in the last seven days before GitHub lets you select it, and a job rename needs the ruleset edited to match.

**Publishing** (`.github/workflows/publish.yml`) runs on branch pushes only, except `holyagent/state`, which holds records and no `package.json`; the workflow has no tag trigger, so the tags it creates do not start it. It calls validation, and when that passes calls `stable.yml` on `main` or `dev.yml` on every other branch. `stable.yml` tags the commit `holyagent-<version>` and publishes a GitHub Release; it fails when that tag is already on another commit, which means `main` moved without a version bump, and does nothing when it is on the same commit. `dev.yml` tags `holyagent-<version>-dev-<short-hash>` (seven characters) and publishes a pre-release, once per commit. Both use the local action `.github/actions/tag-release`, which reads the version from `package.json`, builds the tag and title, and starts a stable Release's generated notes at the previous stable tag, never a development tag. Only the jobs that tag and release hold `contents: write`; every workflow is otherwise read-only. Every external action is pinned to a full commit SHA with a `# vX.Y.Z` comment, and `scripts/workflows.test.ts` checks that and the permissions. The workflows themselves cannot run locally; only that test and the unit tests of `scripts/pr-checks.ts` run in the gates.
