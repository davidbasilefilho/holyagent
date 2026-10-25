# Development

The contributing rules are in `.claude/CLAUDE.md`; this page explains the layout and the tooling behind them.

## Layout

```text
packages/
  runtime/                      shared by every harness
    src/domain/                 Intents, Assignments, routes, readiness, plan, warm-reuse directive
    src/state/                  records under .holyagent/, the lock, per-clone local state
    src/cli/                    the runtime CLI: intent, assignment, plan, status, reconcile, hook
    src/vcs/                    the vcs commands (detect, commit, push, branch, pr, ci)
    src/instructions/
      claude-5.5/               root.md, specialist.md, writing-bar.md, roles/, skills/
      requirements/             cache.md, commit-text.md, mergeability.md: inputs to the instructions, not behavior
  integrations/claude/          turns the runtime into the Claude Code plugin
    build.ts, src/              the generator, the wrapper source, the workflow sources
    vendor/frontend-design/     Anthropic's skill, kept byte for byte
    tests/
    (generated)                 .claude-plugin/, settings.json, agents/, skills/, hooks/, workflows/, scripts/
  cli/                          the public CLI: setup, doctor
.claude-plugin/marketplace.json generated; the marketplace entry for the plugin
install/wsl-install.sh          development environment installer
docs/                           these pages; docs/pi holds the Pi research
mise.toml  bunfig.toml  lefthook.yml
```

A new harness gets its own folder under `packages/integrations/`. It reuses the runtime's domain, state, CLI and instructions and generates its own plugin files.

## Commands

`mise.toml` is the single source of commands. `package.json` scripts and the git hooks only delegate to it, and `--no-script` makes Bun run its own tool rather than a same-named script. Run gates through mise so the `toolchain` task can first confirm a canary Bun.

| Task        | Does                                                     |
| ----------- | -------------------------------------------------------- |
| `toolchain` | Fails unless Bun is a canary build, and names the fix    |
| `prepare`   | Installs the git hooks (`bunx lefthook install`)         |
| `check`     | `bun check`: type-check                                  |
| `lint`      | `bun lint`: type-aware lint, no fixing                   |
| `lint:fix`  | `bun lint --fix`; extra arguments go to Bun (`--staged`) |
| `fmt`       | `bun fmt`: format in place; extra arguments go to Bun    |
| `fmt:check` | `bun fmt --check`                                        |
| `test`      | `bun test`                                               |
| `build`     | Generates the Claude plugin                              |
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

`mise run build` runs `packages/integrations/claude/build.ts`. It removes the generated paths (`GENERATED_PATHS` in `src/generate.ts`) and writes them again from:

- `packages/runtime/src/instructions/claude-5.5/`: the root agent (the body of `agents/holyagent.md` is `root.md`), the eighteen specialist agents (role text, `specialist.md` and, for some roles, the writing bar), the two skills of its own (`merge-ready` and `interface-inspection`; the vendored `frontend-design` comes from `packages/integrations/claude/vendor/`);
- the route table in `packages/runtime/src/domain/route.ts` (model, effort and tools of each agent) and `packages/integrations/claude/src/agents.ts` (the skills each agent loads);
- `packages/integrations/claude/src/workflows/` (each script plus `shared.js`), `wrapper.sh` and `empty-bunfig.toml`;
- `packages/runtime/src/cli/main.ts`, bundled for Bun into `scripts/holyagent.js`;
- the hook table in `generate.ts`, and the version from `packages/integrations/claude/package.json`.

Do not edit generated files; each carries a note naming its source. `.prettierignore` and `.eslintignore` list them so the formatter leaves them as built.

`packages/integrations/claude/tests/plugin.test.ts` is the sync test: every committed generated file equals a fresh build byte for byte, the generated paths hold nothing the build does not make, the build is deterministic, the wrapper is the one executable file, and the commit hook stages exactly `GENERATED_PATHS`. Other tests there cover the hooks, the workflows and the plugin manifest.

## Versioning

Versions are `0.X.Y-Z`, where Z is the hotfix number; 0.1.0 is the first release. The version lives in the `package.json` files, and the build copies the one in `packages/integrations/claude/package.json` into `plugin.json` and `.claude-plugin/marketplace.json`; a test checks they agree. Release work branches as `release/<version>/<type>/<change>`, one branch and one PR per reviewable change.
