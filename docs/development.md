# Development

The contributing rules are in `.claude/CLAUDE.md`; this page explains the layout and the tooling behind them.

## Layout

```text
packages/
  runtime/                      shared by every harness
    src/domain/                 Intents, Assignments, routes, readiness, plan, warm-reuse directive
    src/state/                  records under .holyagent/, the state branch and its worktree, the lock, per-clone local state
    src/cli/                    the runtime CLI: intent, assignment, plan, status, reconcile, hook
    src/vcs/                    the vcs commands (commit, pr)
    src/instructions/
      claude-5.5/               root/, specialist/, roles/<role>/ (one file per section), root-core.ts, skills/
      requirements/             cache.md, commit-text.md, mergeability.md: inputs to the instructions, not behavior
  integrations/claude/          turns the runtime into the Claude Code plugin
    build.ts, src/              the generator and the wrapper source
    vendor/frontend-design/     Anthropic's skill text and license, kept byte for byte; the visual roles embed it
    tests/
    dist/                       generated: the built plugin (.claude-plugin/, settings.json, agents/, skills/, hooks/, scripts/)
  cli/                          the public CLI: setup, doctor
.claude-plugin/marketplace.json generated; the marketplace entry for the plugin
install/wsl-install.sh          development environment installer (WSL Ubuntu)
install/windows-install.ps1     the same for native Windows (PowerShell)
docs/                           these pages; docs/pi holds the Pi research
mise.toml  bunfig.toml  lefthook.yml
```

A new harness gets its own folder under `packages/integrations/`. It reuses the runtime's domain, state, CLI and instructions and generates its own plugin files.

## Commands

`mise.toml` is the single source of commands. `package.json` scripts and the git hooks only delegate to it, and `--no-script` makes Bun run its own tool rather than a same-named script. Run gates through mise so the `toolchain` task can first confirm a canary Bun.

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

Done means `mise run verify` passes; after changing plugin sources, run `mise run build`.

## Lint and format rules

Everything is configured in `bunfig.toml`. Bun's own `check`, `lint` and `fmt` are the tools (`eslint-plugin-jsdoc` runs inside `bun lint`); the repository adds none beside them.

- **Type-aware lint with type-check and zero warnings** (`typeAware`, `typeCheck`, `maxWarnings = 0`). The `correctness` category is an error. `consistent-type-imports`, `no-floating-promises` and `no-misused-promises` catch errors the type-checker accepts, such as a dropped promise.
- **Effect enforcement.** In `packages/runtime/src` and `packages/cli/src` the lint forbids `async` and `await`, `new Promise`, `try`/`catch` and `Promise` statics. Failures there are tagged Effect errors and effects are composed with Effect; `Effect.runPromise` is for integration boundaries only. One error model keeps failures typed and visible in signatures, and keeps the runtime's behavior testable without exceptions. The plugin generator (`packages/integrations/claude`) is outside the override and uses plain async code.
- **JSDoc on the public API.** `jsdoc/require-jsdoc` covers exported functions, classes, methods, interfaces, type aliases, enums and exported variables, and the formatter keeps JSDoc tidy (`jsdoc = true`). Skills open their description with the situation, so a model can tell when to load them.
- **Formatting.** No semicolons, 100 columns, `sortImports` and `sortPackageJson` so imports and `package.json` keys have one order and diffs carry no reordering noise. `bracketSameLine` keeps the closing `>` of a multi-line tag on its last attribute line. The maintainer requested these three options; the repository has no JSX yet, so `bracketSameLine` only fixes the style for later UI code.

## Git hooks

`lefthook.yml` runs on `pre-commit`, piped (the first failing job stops the rest):

1. `lint`: `mise run lint:fix -- --staged`, then `stage_fixed` re-stages what lint changed (the `bun lint` docs do not say that `--staged --fix` stages again).
2. `fmt`: `mise run fmt -- --staged`, re-staged (Bun leaves a partly staged file unwritten rather than committing its unstaged changes).
3. `build`: `mise run build`, then `git add -A --` on exactly the generated paths, deletions included, so a commit always carries a plugin in step with its sources.

## The generated plugin

`mise run build` runs `packages/integrations/claude/build.ts`. It removes the generated paths (`GENERATED_PATHS` in `src/generate.ts`: the root `.claude-plugin/marketplace.json` and the built plugin in `packages/integrations/claude/dist/`) and writes them again from:

- `packages/runtime/src/instructions/claude-5.5/`: the root agent (the body of `agents/holyagent.md` is the files of `root/` joined in the order of `ROOT_SECTIONS`), the eighteen specialist agents (the files of `roles/<agent>/` in the order of `ROLE_SECTIONS`, then the files of `specialist/` in the order of `SPECIALIST_SECTIONS` and, for the roles that need them, `CONDITIONAL_SECTIONS`: `specialist/writing-bar.md`, `merge-ready.md` and `interface-inspection.md`; the visual roles also embed the vendored `frontend-design` text from `packages/integrations/claude/vendor/`), and the two skills of its own, `dev-server` and `user-busy`; what an agent kind always needs is fixed text, not a skill;
- the route table in `packages/runtime/src/domain/route.ts` (model, effort and tools of each agent) and `packages/integrations/claude/src/agents.ts` (how each agent is assembled);
- `packages/integrations/claude/src/wrapper.sh` and `empty-bunfig.toml`;
- `packages/runtime/src/cli/main.ts`, bundled for Bun into `scripts/holyagent.js`;
- the hook table in `generate.ts`, and the version from `packages/integrations/claude/package.json`.

Every agent prompt is split into one file per section, and the order of the sections is fixed in `src/agents.ts`, not by file name; the sync test fails when a file in `root/`, `specialist/` or `roles/<agent>/` is not assembled or an assembled file is missing. The core of the root rules, which the SessionStart hook injects when the root is not the main thread, is the files named in `ROOT_CORE_FILES` (`root-core.ts`); a test caps it at 4,100 characters. `root/instruction-guidelines.md` holds the rules the root applies when it writes model-facing text, each tagged with the Anthropic prompting page it follows.

**The bundled search tools.** `dist/scripts/vendor/<target>/` holds ripgrep (`rg`) and fd (`fd`) with their licenses (`licenses/<project>/`) for `darwin-arm64`, `linux-x64` and `windows-x64`; `holyagent rg …` and `holyagent fd …` run the one for the current platform with the caller's stdio and exit code (`packages/runtime/src/cli/tools.ts`). They sit under `scripts/` because claude.ai refuses a plugin with a top-level `bin/`. The pins live in `packages/integrations/claude/src/vendor.ts`: a release URL, the SHA-256 of each archive and the SHA-256 of the program inside, for ripgrep 15.2.0 and fd 10.5.0. ripgrep's archive hashes are the ones its release publishes; fd publishes none, so its hashes were taken from the downloads and are trusted on first use. `mise run vendor` (`scripts/vendor.ts`, which `build` depends on) downloads what is missing, checks the archive hash before reading it and the program hash after extracting, marks the programs executable, and removes files no pin names; with everything in place it does nothing, so a build needs no network. The vendor folder is committed, because the marketplace serves the plugin from `dist/`; `build.ts` leaves it in place while it regenerates the rest, and `vendor.test.ts` checks it against the pins offline. To upgrade a tool, change its version and hashes in `vendor.ts`, then run `mise run vendor` and `mise run build`.

For how a rebuilt plugin reaches a session, see the Updates paragraph in [usage.md](usage.md#install).

Do not edit generated files; each carries a note naming its source. `.prettierignore` and `.eslintignore` list them so the formatter leaves them as built.

`packages/integrations/claude/tests/plugin.test.ts` is the sync test: every committed generated file equals a fresh build byte for byte, the generated paths hold nothing the build does not make (apart from the vendored tools, which `vendor.test.ts` checks against their pins), the build is deterministic, the wrapper is the one executable file, and the commit hook stages exactly `GENERATED_PATHS`. Other tests there cover the hooks (the `Workflow` hook's allowed and refused scripts among them) and the plugin manifest.

## Versioning

Versions are `0.X.Y-Z`, where Z is the hotfix number; 0.1.0 is the first release. The version lives in the `package.json` files, and the build copies the one in `packages/integrations/claude/package.json` into `plugin.json` and `.claude-plugin/marketplace.json`; a test checks they agree. Release work branches as `release/<version>/<type>/<change>`, one branch and one PR per reviewable change.
