# Development

The contributing rules are in `AGENTS.md`; this page explains the layout and the tooling behind them.

## Layout

```text
packages/
  runtime/                      shared by every harness
    src/domain/                 Intents, Assignments, routes, readiness, plan, warm-reuse directive
    src/state/                  records under .holyagent/, the state mode, the state branch and its worktree, the lock, per-clone local state
    src/cli/                    the runtime CLI: intent, assignment, plan, status, reconcile, state, migrate, hook, setup, doctor, rg, fd
    src/setup/                  what setup and doctor read and write: Claude Code settings, ctx7, the shell
    src/vcs/                    the vcs commands (commit, pr, identity)
    src/prompts/                the first-pass review prompt templates (code-review, security-review): the Pi package ships them and the Pi launcher starts reviewer briefs with them
    src/instructions/
      claude-5.5/               a model family: root/, specialist/, roles/<role>/ (one file per section), shared/ (text the root and the specialists both embed), design-core/, skills/, root-core.ts, guide.md
      kimi-k3.1/                the same layout, written to Moonshot's guides
      gpt-6/                    the same layout, written to OpenAI's GPT-6 guidance
      requirements/             the requirements, one file for each Markdown file of a family and the same path: what the family file must say
      families.ts, coverage.ts  the supported families, and where each family carries each requirement
      skills.ts                 builds a family's skills for a harness: the materiality and design core embedded, citation comments stripped, a note added
  integrations/claude/          turns the runtime into the Claude Code plugin
    build.ts, src/              the generator and the wrapper source
    tests/
    dist/                       generated: the built plugin (.claude-plugin/, settings.json, agents/, commands/, skills/, hooks/, scripts/)
  integrations/pi/              turns the runtime into the Pi package
    build.ts, src/              the generator (generate.ts, agents.ts, files.ts, specialists.ts) and the extension source (extension.ts)
    tests/
    dist/                       generated: the built Pi package (package.json, agents/, extensions/, prompts/, scripts/, skills/)
.claude-plugin/marketplace.json generated; the marketplace entry for the plugin
.github/                        the CI, publish and release workflows and the tag-release action
scripts/                        Bun scripts behind the mise tasks: toolchain, hooks, versions, the dependency updater, PR checks
install/wsl-install.sh          prerequisites installer (WSL Ubuntu): Bun, Node LTS, git, gh; --dev adds mise
install/windows-install.ps1     the same for native Windows (PowerShell; -Dev adds mise)
docs/                           these pages; docs/pi holds the Pi integration's docs, its decisions and the research behind them
mise.toml  bunfig.toml  lefthook.yml
```

A new harness gets its own folder under `packages/integrations/`. It reuses the runtime's domain, state, CLI and instructions and generates its own plugin files.

## Getting mise

Install native mise before installing the development dependencies. The npm wrapper is not used: its Windows binary package is unavailable and its install hook makes `bun i` fail. On Windows, run `winget install --id jdx.mise --exact` (or the Windows installer's `-Dev` option); on other systems follow [mise's installation guide](https://mise.jdx.dev/getting-started.html). CI uses `jdx/mise-action`.

`bunx --no-install mise` resolves mise on PATH without downloading the npm wrapper:

```sh
bun install --frozen-lockfile
bunx --no-install mise install
bunx --no-install mise run verify
```

`mise install` installs the pinned tools and upgrades Bun to canary. The upgrade child drops inherited `BUN_OPTIONS` and, on Windows, `PSModulePath`, so a PowerShell 7 host does not make Windows PowerShell load an incompatible archive module. Development installs run the hooks setup only when local lefthook and native mise are available; production installs skip it.

## Commands

`mise.toml` is the single source of commands. `package.json` scripts and the git hooks only delegate to it, and `--no-script` makes Bun run its own tool rather than a same-named script. Run gates through mise (`bunx --no-install mise run <task>` with the local one) so the `toolchain` task can first confirm a canary Bun.

| Task                    | Does                                                            |
| ----------------------- | --------------------------------------------------------------- |
| `toolchain`             | Fails unless Bun is a canary build, and names the fix           |
| `prepare`               | Installs the git hooks; skips outside a git work tree           |
| `check`                 | `bun check`: type-check                                         |
| `lint`                  | `bun lint`: type-aware lint, no fixing                          |
| `lint:fix`              | `bun lint --fix`; extra arguments go to Bun (`--staged`)        |
| `fmt`                   | `bun fmt`: format in place; extra arguments go to Bun           |
| `fmt:check`             | `bun fmt --check`                                               |
| `test`                  | `bun test`                                                      |
| `build`                 | Generates the Claude plugin and the Pi package                  |
| `instructions:scaffold` | Adds the requirements tree to every family as empty files       |
| `bump:patch`            | Raises the root version by a patch, then `build` (Versioning)   |
| `bump:minor`            | Raises the root version by a minor, then `build` (Versioning)   |
| `deps:update`           | Moves every pin to its newest stable release (see Dependencies) |
| `deps:check`            | Fails when a pin is behind                                      |
| `verify`                | `check`, `lint`, `fmt:check` and `test`, all read-only          |

The root `prepare` script is `bun scripts/prepare-dev.ts`, which runs the `prepare` task only when `mise` is installed under `node_modules`, so a consumer install that omits dev dependencies (what Pi runs on a release tag) succeeds without hooks and a development install still installs them.

Done means `mise run verify` passes; after changing plugin sources, run `mise run build`. `scripts/repo-paths.test.ts` (part of `test`) fails on a tracked path over 120 characters, which overruns Windows MAX_PATH in the marketplace clone, or under `.holyagent/`, which lives on the `holyagent/state` branch.

## Instruction text

The instruction text is written from requirements. `packages/runtime/src/instructions/requirements/` mirrors every Markdown file of each supported model family (`families.ts` lists them: `claude-5.5`, `kimi-k3.1` and `gpt-6`) with the same path, and each file holds the requirements that become the family file, one `- R-ID: text` line each. Ids are unique; a file that a requirement also governs refers to it with a `- See: R-ID` line. `root-core.ts` and `guide.md` are not mirrored.

A change starts in `requirements/`. `bunx --no-install mise run instructions:scaffold` then adds every missing folder and file to each family as an empty file, and never overwrites or deletes one with content. The family file is translated from its requirements as the family's `guide.md` directs: `claude-5.5/guide.md` lists the points of Anthropic's prompting guidance for Claude with their source pages, `kimi-k3.1/guide.md` those of Moonshot's guides for Kimi, and `gpt-6/guide.md` those of OpenAI's guidance for GPT-6 and Codex's prompts for it. `coverage.ts` names, per family, the file and phrase that carry each requirement, or the code or page that carries one no prompt text can. The tests fail on a family file without a requirements file, a requirements file without a family file, and a requirement that a listed family does not cover. A source cites the guide point a rule follows in an HTML comment (`<!-- K5 -->`), for the people who edit it; every generator removes such comments with `stripCitations` in `skills.ts`, so they never reach a model, leaves code spans, fenced blocks and indented code blocks as written, and keeps only the marker lines `<!-- materiality -->` and `<!-- design-core -->`, which it replaces with shared text. `requirements/` and `guide.md` are not shipped in the plugin, so changing them leaves `dist/` as it is.

## Dependencies

Every dependency range in every `package.json` is a caret range at its line boundary (`^X.0.0` for X of 1 or more, `^0.X.0`, `^0.0.X`), or `workspace:*` for a workspace package, and `bun.lock` holds the exact versions. A line boundary lets a fresh install take every compatible release without a manifest edit, while the lockfile keeps installs reproducible; `scripts/dependency-ranges.test.ts` fails on any other range, in any dependency field. The one exception is Pi's host packages (`PI_HOST_PACKAGES` in `scripts/dependency-pins.ts`: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox`): the Pi integration declares them as `peerDependencies` with the range `*`, which Pi's package documentation requires so that Pi supplies them and the package bundles none. The exception covers those names in that field only, and the updater leaves them as they are. The same package lists `@earendil-works/pi-coding-agent` as a caret-range `devDependency` for the extension API types. This includes `@anthropic-ai/claude-code` and `mise`: nothing depends on their exact version, because `trustedDependencies` matches names, `scripts/toolchain.ts` checks only that Bun is a canary build, and CI runs the Claude Code binary the lockfile resolves (`bun run claude`).

Dependencies change only through the updater, `scripts/update-dependencies.ts`, so a pin never drifts by hand and a release is never a prerelease. It moves each pin to the newest stable release line (the major, or the minor for a `0.x` project) and the newest stable release within it. For a package, the range it writes comes from the newest stable version that is not deprecated and is no higher than the registry's `latest` dist-tag, so a canary or a version above the publisher's current release is not chosen as the range. The cap covers that range only: `bun update` then resolves the lockfile within it by its own rules and can pick a release above `latest`. The installs run with `--ignore-scripts`, so no package's install script runs during an update; a later plain `bun install` runs the trusted ones, so read the lockfile diff first. The pins:

- the external GitHub Actions in `.github/`: the tag becomes its full commit SHA, and the `# vX.Y.Z` comment follows;
- the mise tools in `mise.toml` that are pinned to a version (`bun`, whose stable base the `postinstall` hook upgrades to canary, and `aqua:BurntSushi/ripgrep` and `aqua:sharkdp/fd`, the aqua backend named so that mise installs the upstream releases, which dev machines and CI need for `holyagent rg` and `holyagent fd`; `node = "lts"` is a channel and stays), each moved to the newest stable tag of its GitHub repository;
- the exact Pi package pins in `packages/runtime/src/config/pi-packages.json` (the provider, the reused extensions, and the npm MCP server of the `browser-use` capability, opencode browse `@opencode/browse`, which Pi does not install: it runs with `npx` at its pin, with the public npm registry passed explicitly), each set to the newest stable, non-deprecated release no higher than the registry's `latest`, never moved down. The Pi host used for development and tests, `@earendil-works/pi-coding-agent` (a caret-range `devDependency` of `packages/integrations/pi`), is not in that table: it moves with `bun.lock` when `bun update` runs, within its caret range, and a user's own Pi install is theirs. The updater does not re-record the CI fixtures, so a move of the host or of a Pi pin shows up as a failing replay until they are re-recorded ([Re-recording the Pi fixtures](#re-recording-the-pi-fixtures));
- the exact PyPI pins in `packages/runtime/src/config/pypi-packages.json` (browser-use, the headless form's MCP server, which `uvx` runs at its pin with `--no-config` and the public PyPI index passed explicitly), each set to the newest stable release of the project's PyPI JSON API (`https://pypi.org/pypi/<name>/json`) that has a file nobody yanked, never a prerelease, a post release or a yanked one, and never moved down;
- the ranges of every `package.json` (the root and the workspace packages, never `node_modules`), followed by `bun update` and `bun install` for the lockfile.

The commit permalinks in `docs/pi/` are research references and stay as written. Tags and commits are read with `git ls-remote`, package releases from the npm registry, PyPI releases from the PyPI JSON API. A `uses:` line the updater cannot read (no commit SHA, or a comment other than `# vX.Y.Z`) is listed as skipped, as is a mise tool it has no source for. Every download and file is read and checked before the first file is written; a failure of `bun update` after that leaves the tree half moved, so revert it with git and run the updater again. `mise run deps:update -- --dry-run` prints `current -> next` for every pin and writes nothing, `mise run deps:update` applies the moves, and `mise run deps:check` exits non-zero when a pin is behind. After an update, run `mise run build` and `mise run verify`; a pin whose update breaks a gate is fixed in code or reverted and reported, not left half-moved.

### Re-recording the Pi fixtures

`packages/integrations/pi/tests/contract.test.ts` pins the Pi events the integration consumes (the JSON-mode run stream with `agent_settled` and the tool execution events, the extension's `session_start`, `before_agent_start`, `message_end`, `tool_call`, `session_compact` and `session_shutdown` events, and the `extension_ui_request` messages of RPC mode) to the Pi host version the fixtures were recorded for. The fixtures are JSONL files in `packages/integrations/pi/tests/fixtures/`, each starting with a header line that names the Pi package and version. They are not recorded from a Pi run: `fixtures/record.ts` builds every event from Pi's exported types with `satisfies`, so `mise run check` fails when an update renames or retypes a field the event spells out. The `before_agent_start` and `session_compact` events are written against a `Pick` of their type, so only the picked fields are covered. Each group is checked differently:

- The `extension-events` fixture runs through the extension's own handlers, where `message_end` reaches `failedFinalMessage`.
- The JSON-mode run streams (ending in `agent_settled`, with the tool execution events) are read through `failedFinalMessage` and `assignmentStatusOf` by a reader local to the test, because the real reader lives in `@tintinweb/pi-subagents`; the test checks the outcome and Assignment status that reader's result implies.
- The `extension_ui_request` messages of RPC mode are pinned by type and field shape only, because the extension has no UI consumer yet.

Nothing starts Pi.

`mise run deps:update` can move the host with `bun.lock`, and then the contract test fails with a message that says to re-record. To record again:

1. Run `bun packages/integrations/pi/tests/fixtures/record.ts`. It writes every file for the installed host's version.
2. Read the diff of `packages/integrations/pi/tests/fixtures/`. Only the version in the headers should move; any other change is an event Pi changed.
3. Run `mise run check` and `mise run test`. A type error in `record.ts`, or a failing consumer assertion, is a change in Pi that the integration must be adapted to, which is a code change and not a re-record. Edit `record.ts` to the new Pi types first, then record.

The test also fails when a fixture file differs from what `record.ts` writes, so do not edit the JSONL by hand.

`packages/integrations/pi/tests/t3-rpc.test.ts` replays the traffic of T3 Code driving `pi --mode rpc`, from the JSONL files in `packages/integrations/pi/tests/fixtures/t3/`. They are synthesized, not recorded from T3: each header says `synthesized` and lists its sources (T3's `buildPiRpcLaunch` and Pi adapter, Pi's RPC types, `@tintinweb/pi-subagents`' new-turn trigger), and the Pi messages are built with `satisfies` on Pi's exported RPC types like the fixtures above. The test runs the real extension (`createExtension`) in RPC mode with the T3 environment (`T3_PI_RUNTIME_MODE` at each access mode, `T3_MCP_URL`), feeds it the session events of the fixtures and records every `ctx.ui` member it reads through a proxy, so an alias or a destructuring is caught too: only `select`, `confirm`, `input`, `editor`, `notify` and `setStatus`, the methods T3 renders, may be touched, and below Full access the one call is the `setStatus` warning; a planted `setWidget`, `custom` or `setTitle` call proves the recording catches a stray one. The fixtures themselves are pinned for their header, their staleness against the installed Pi, the T3 launch (`T3_PI_RUNTIME_MODE`, `T3_MCP_URL` and the injected bridge) and the shape of the `extension_ui_request` and `extension_ui_response` messages; those checks read the files back and say nothing about the extension. The late-completion fixture (a specialist's notice after `agent_settled` opening a new root turn) documents an assumed turn behaviour and is not a regression test: it needs `@tintinweb/pi-subagents` and T3 Code, which the tests do not run, so a change in either would not fail it. After `mise run deps:update` moves Pi, run `bun packages/integrations/pi/tests/fixtures/t3/record.ts` as well, and read the diff of `fixtures/t3/` the same way; `fixtures/record.ts` does not write these files.

## Lint and format rules

Everything is configured in `bunfig.toml`. Bun's own `check`, `lint` and `fmt` are the tools (`eslint-plugin-jsdoc` runs inside `bun lint`); the repository adds none beside them.

- **Type-aware lint with type-check and zero warnings** (`typeAware`, `typeCheck`, `maxWarnings = 0`). The `correctness` category is an error. `consistent-type-imports`, `no-floating-promises` and `no-misused-promises` catch errors the type-checker accepts, such as a dropped promise.
- **Effect enforcement.** In `packages/runtime/src` the lint forbids `async` and `await`, `new Promise`, `try`/`catch` and `Promise` statics. Failures there are tagged Effect errors and effects are composed with Effect; `Effect.runPromise` is for integration boundaries only. One error model keeps failures typed and visible in signatures, and keeps the runtime's behavior testable without exceptions. The generators (`packages/integrations/claude` and `packages/integrations/pi`) are outside the override and use plain async code.
- **JSDoc on the public API.** `jsdoc/require-jsdoc` covers exported functions, classes, methods, interfaces, type aliases, enums and exported variables, and the formatter keeps JSDoc tidy (`jsdoc = true`). Skills open their description with the situation, so a model can tell when to load them.
- **Formatting.** No semicolons, 100 columns, `sortImports` and `sortPackageJson` so imports and `package.json` keys have one order and diffs carry no reordering noise. `bracketSameLine` keeps the closing `>` of a multi-line tag on its last attribute line. The maintainer requested these three options; the repository has no JSX yet, so `bracketSameLine` only fixes the style for later UI code.

## Git hooks

`lefthook.yml` runs on `pre-commit`, piped (the first failing job stops the rest). Its commands go through `bunx --no-install`, which resolves the dev dependency in `node_modules/.bin` and never fetches it, so a hook needs no mise on `PATH`:

1. `lint`: `bunx --no-install mise run lint:fix -- --staged`, then `stage_fixed` re-stages what lint changed (the `bun lint` docs do not say that `--staged --fix` stages again).
2. `fmt`: `bunx --no-install mise run fmt -- --staged`, re-staged (Bun leaves a partly staged file unwritten rather than committing its unstaged changes).
3. `build`: `bunx --no-install mise run build`, then `git add -A --` on exactly the generated paths, deletions included, so a commit always carries a plugin in step with its sources.
4. `build-pi`: `git add -A --` on the Pi package's generated path, `packages/integrations/pi/dist` (`GENERATED_PATHS` in its `src/generate.ts`); the build job already built it.
5. `versions`: when the root `package.json` is staged, `git add --` on `packages/runtime/package.json`, `packages/integrations/claude/package.json`, `packages/integrations/pi/package.json` and `bun.lock`, the copies `build` rewrites, so a version bump carries every copy of the version; otherwise they are left alone.

## The generated plugin

`mise run build` runs `packages/integrations/claude/build.ts`. It removes the generated paths (`GENERATED_PATHS` in `src/generate.ts`: the root `.claude-plugin/marketplace.json` and the built plugin in `packages/integrations/claude/dist/`) and writes them again from:

- `packages/runtime/src/instructions/claude-5.5/`: the root agent (the body of `agents/holyagent.md` is the files of `root/` joined in the order of `ROOT_SECTIONS`), the eighteen specialist agents (the files of `roles/<agent>/` in the order of `ROLE_SECTIONS`, then the files of `specialist/` in the order of `SPECIALIST_SECTIONS` and, for the roles that need them, `CONDITIONAL_SECTIONS`: `specialist/writing-bar.md`, `merge-ready.md` and `interface-inspection.md`), and the skills of its own (one folder each under `skills/`, listed in [usage.md](usage.md#how-a-session-works); the four platform design skills carry the shared `design-core/core.md`, and `shared/materiality.md` replaces its marker line in the design core, `visual-judging` and `specialist/interface-inspection.md`); what an agent kind always needs is fixed text, not a skill. `shared/precedence.md` (the order of precedence) is in the root core and every specialist, and `shared/history-rules.md` is in the root prompt and the version-control reminder hook;
- the route table in `packages/runtime/src/domain/route.ts` (model, effort and tools of each agent) and `packages/integrations/claude/src/agents.ts` (how each agent is assembled);
- `packages/integrations/claude/src/wrapper.sh` and `empty-bunfig.toml`;
- `packages/runtime/src/cli/main.ts`, bundled for Bun into `scripts/holyagent.js`;
- the hook table in `generate.ts`, and the version from `packages/integrations/claude/package.json`, which the build first syncs from the root `package.json` (see Versioning).

Every agent prompt is split into one file per section, and the order of the sections is fixed in `src/agents.ts`, not by file name; the sync test fails when a file in `root/`, `specialist/` or `roles/<agent>/` is not assembled or an assembled file is missing. The core of the root rules, which the SessionStart hook injects when the root is not the main thread, is the files named in `ROOT_CORE_FILES` (`root-core.ts`). `root/instruction-guidelines.md` holds the rules the root applies when it writes model-facing text, each tagged with the Anthropic prompting page it follows.

**The search tools.** The plugin bundles no program: `holyagent rg …` and `holyagent fd …` run the ripgrep and fd on `PATH` (fd also as `fdfind`; only absolute entries outside the working directory, and on Windows only an `.exe`, as `StrictLookup` in `packages/runtime/src/setup/shell.ts` says) with the caller's stdio and exit code (`packages/runtime/src/cli/tools.ts`), and fail with `ToolMissing` when one is not installed. `holyagent setup` and `holyagent doctor` report both (`packages/runtime/src/setup/search-tools.ts`). The programs are prerequisites of the user ([requirements.md](requirements.md)) and of development: `mise.toml` pins `aqua:BurntSushi/ripgrep` and `aqua:sharkdp/fd`, so `mise install` provides them on a dev machine and in CI, Windows included. Tests that run the real programs use whatever is on `PATH` and skip when it is missing; the rest inject a fake lookup or put fake scripts on a temporary `PATH`.

For how a rebuilt plugin reaches a session, see the Updates paragraph in [usage.md](usage.md#install).

Do not edit generated files; each carries a note naming its source. `.prettierignore` and `.eslintignore` list them so the formatter leaves them as built.

`packages/integrations/claude/tests/plugin.test.ts` is the sync test: every committed generated file equals a fresh build byte for byte, the generated paths hold nothing the build does not make, the build is deterministic, the wrapper is the one executable file, and the commit hook stages exactly `GENERATED_PATHS`. Other tests there cover the hooks (the `Workflow` hook's allowed and refused scripts among them) and the plugin manifest.

## The generated Pi package

`mise run build` also runs `packages/integrations/pi/build.ts`, which removes `packages/integrations/pi/dist/` (`GENERATED_PATHS` in `src/generate.ts`) and writes it again from:

- `packages/runtime/src/instructions/<family>/skills/`, the same sources as the Claude plugin's skills, through `skillFiles` in the runtime's `instructions/skills.ts`, which both generators call. The family is a parameter of `generate` and `PI_FAMILY` is its value (`kimi-k3.1`, so the Pi package ships the Kimi skills), written to `dist/skills/`;
- the Kimi family's role and specialist sections and the route table, through `packages/integrations/pi/src/agents.ts`, written to `dist/agents/` as one agent file for each of the 18 specialists, which `@tintinweb/pi-subagents` loads;
- `packages/runtime/src/prompts/`, the `code-review` and `security-review` prompt templates, written to `dist/prompts/` with the generated note added to their frontmatter. The runtime owns them because `holyagent assignment` also reads them, to start a Pi `Reviewer.code` or `Reviewer.security` brief with the matching one;
- `packages/integrations/pi/src/extension.ts`, a default-exported factory that takes Pi's `ExtensionAPI` and registers the `--holyagent-role` flag and its handlers, bundled with `Bun.build` for Node as ESM into `dist/extensions/holyagent.js`. The host modules (the `peerDependencies` of the package's `package.json`, and their subpaths) stay imports;
- `packages/integrations/claude/src/wrapper.sh` and `empty-bunfig.toml`, which become `dist/scripts/holyagent` and `dist/scripts/empty-bunfig.toml`, and `packages/runtime/src/hooks/pi-entry.ts`, bundled for Bun into `dist/scripts/holyagent.js`. Pi runs the extension under Node and the runtime reads files with Bun, so the extension reaches the runtime only through this wrapper;
- `packages/runtime/src/pi/bash/entry.ts`, bundled for Bun into `dist/scripts/just-bash.js` (`SHELL_SOURCE` in `src/generate.ts`): the shell process the extension starts for each bash call, with just-bash inside and `sql.js` stubbed out (`pi/bash/bundle.ts`). It is a bundle of its own, beside `holyagent.js`, so a move of the just-bash pin changes that file and no other; it is committed like the rest of `dist/` (see [pi/shell.md](pi/shell.md));
- `packages/integrations/pi/package.json`, whose `version` the build first syncs from the root and whose `peerDependencies` the generated manifest carries.

The generated `package.json` has the `pi-package` keyword, a `pi` key listing `./extensions`, `./prompts`, `./skills` and, under `subagents`, `./agents`, `files` naming `agents`, `extensions`, `prompts`, `scripts` and `skills`, and the host modules as `peerDependencies` with the range `*`. It lists no `dependencies`: Pi would install every one whatever the config says and load none, because it loads a package only from a `pi install` entry in its settings, which `holyagent setup` writes per config. Each generated file that can hold a comment carries a note naming its source; JSON has none. The root `package.json` has its own `pi` key that points at the same folders under `packages/integrations/pi/dist/`, because `pi install git:<repo>@<ref>` installs the repository root. `.prettierignore` and `.eslintignore` list the folder.

`packages/integrations/pi/tests/pi.test.ts` is its sync test: every committed generated file equals a fresh build byte for byte, the generated path holds nothing the build does not make, the build is deterministic, the commit hook stages exactly `GENERATED_PATHS`, the manifest and the root `pi` key name the same folders, the skills are those of the family, the 18 agent files carry the tools the config decides, the extension registers only its flag and handlers and loads under Node, and the host modules are not bundled. `tests/extension.test.ts` covers the extension's handlers with synthesized Pi events; the tests never run Pi or a model.

## Versioning

Versions follow ZeroVer, `0.X.Y`: the major stays 0, a minor bump advances X and resets Y, and a patch bump advances Y; 0.1.0 was the first release. The version lives in the root `package.json` only, and `mise run bump:patch` or `bump:minor` is the only way it changes: `scripts/bump-version.ts` edits that file and nothing else. `mise run build` then runs `bun scripts/bump-version.ts sync`, which copies the version into `packages/runtime/package.json`, `packages/integrations/claude/package.json`, `packages/integrations/pi/package.json` and the workspace entries of `bun.lock`, and generates `plugin.json` and `.claude-plugin/marketplace.json` from the Claude integration's copy and the Pi package's `package.json` from the Pi integration's; the bundled CLI's `--version` reads the root `package.json`. The workspace manifests keep a `version` field because Bun workspaces and the plugin generator read their own package's, so the build writes it rather than the field being dropped. `scripts/bump-version.test.ts` fails when any copy differs from the source. The branch model that carries a version to a release is below.

## Branches, CI and releases

Work happens on branches with PRs targeting `dev`. The first PR of a release carries the version bump as its own commit (`mise run bump:patch` or `bump:minor`); a release PR promotes `dev` to `main`. A focused repair of an unpublished release may instead use `release/<version>/fix/publication-repair` from fresh `main`, squashed directly into `main`, without a version bump. [AGENTS.md](../AGENTS.md) states the rules and their reasons; this section is the machinery behind them.

**Validation** (`.github/workflows/validation.yml`) runs on pull requests (opened, pushed to, reopened and edited, so a changed base is checked again) and is callable, so `publish.yml` runs the same jobs for a push. Its jobs and their status check names, which are the job ids:

| Check          | Runs on              | Does                                                                                                                                              |
| -------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`        | PRs and calls        | The gates, generated artifact freshness, plugin validation and shellcheck                                                                         |
| `windows`      | PRs and calls        | The test suite on `windows-latest`                                                                                                                |
| `installers`   | PRs and calls        | Parses both installers                                                                                                                            |
| `branch-model` | PRs only             | Allows `dev` or the exact publication-repair branch into `main`, after the inline guard rejects a fork                                            |
| `version`      | PRs into `main` only | Normal releases require a version strictly newer than `main`; publication repairs require exact main/head equality and an unpublished npm version |

Both PR-only jobs fail a pull request whose head repository is not this one, because a fork picks its branch names freely. An inline shell step runs first in each of them, before checkout, and compares the head repository with this repository case-insensitively. A new push or edit cancels an older run for the same pull request, but never a push run called by `publish.yml`: cancelling that would fail the publish and leave the commit untagged. A job skipped by its `if` reports as passed, so `version` can be required on `main` and `branch-model` on every protected branch without blocking other PRs.

**Branch protection.** Protect `main` and `dev` with PRs only, no force push and no deletion. `main` requires `check`, `windows`, `installers`, `branch-model` and `version`, with branches up to date; `dev` requires the first four. Protect `refs/tags/holyagent-*` against update and deletion. A repository admin configures these rules; workflows cannot create them. Required checks must have run recently before GitHub lets an admin select them, and renaming a job requires updating the ruleset.

**Publishing** (`.github/workflows/publish.yml`) validates branch pushes except `holyagent/state`; tags do not trigger it. After validation, protected `main` publishes stable and protected `dev` publishes a prerelease. The development version is `<version>-dev.<commit UTC date>.<commit UTC time>.g<seven-character SHA>`; the `holyagent-` tag prefix is retained. Both publication and tagging derive it from the commit, so retries use the same version. Only release jobs hold `contents: write`; npm jobs receive OIDC. External actions are pinned to full commit SHAs. See [npm publishing](npm-publishing.md) for the publication preflight and required environment configuration.
