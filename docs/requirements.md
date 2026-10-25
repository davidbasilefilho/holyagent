# Requirements

| Requirement          | Needed for                                                 | Detail                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code          | The plugin                                                 | 2.1.242 or later for `subagentPromptCacheTtl`; developed against 2.1.310. See below for hooks and workflows                                                                                                  |
| Bun                  | The plugin's CLI, the public CLI, the repository toolchain | The plugin wrapper runs `bun`, from `PATH` or `$BUN_INSTALL/bin` (default `~/.bun/bin`), and exits 127 with `error: BunMissing` when there is none. The repository toolchain needs a **canary** build        |
| Node.js LTS          | Billion Context and ctx7                                   | Billion Context needs Node 20 or later and ctx7 needs 22.13 or later; mise's `lts` satisfies both. ctx7's Context7 rule also calls `npx ctx7@latest` at runtime                                              |
| git                  | `holyagent vcs`                                            | Every commit, branch and push step runs `git`                                                                                                                                                                |
| gh with a credential | `vcs detect`, `commit` (API path), `pr`, `ci`              | `gh auth login` or `GH_TOKEN`. The credential's owner is who commits are attributed to. Without one, `vcs detect` falls back to the configured git identity, or refuses if that identity looks like an agent |
| mise                 | Developing this repository, the WSL installer              | Source of the repository's commands; `mise.toml` pins Bun (1.4.4, then upgraded to canary) and tracks Node as `lts`                                                                                          |

## Why Bun canary

The repository's toolchain is Bun's own `bun check`, `bun lint` and `bun fmt`, which exist only in canary builds. mise cannot install `bun@canary`, so it installs the stable base and `bun upgrade --canary` replaces the binary in place (mise's `postinstall` hook, the installer and `holyagent doctor --fix` do this). A later `mise upgrade bun` that installs a new stable version brings stable back, so every repository gate first runs the `toolchain` task and fails with the fix when Bun is not canary. A `--smol` in `BUN_OPTIONS` makes `bun upgrade` fail, so the `postinstall` hook in `mise.toml` and `holyagent doctor --fix` run the upgrade with `BUN_OPTIONS` unset; when you upgrade by hand, run `env -u BUN_OPTIONS bun upgrade --canary`.

The plugin's runtime only calls `bun` and does not check the build. Running the plugin needs Bun; developing HolyAgent needs the canary.

## Claude Code version

- Documented minimums: `subagentPromptCacheTtl` (written by `holyagent setup`) 2.1.242 or later, agent `experimental.cacheTtl` (set in every specialist file) 2.1.248 or later, hook `onFailure: "block"` 2.1.295 or later (stated on the Claude Code [hooks](https://code.claude.com/docs/en/hooks.md), [sub-agents](https://code.claude.com/docs/en/sub-agents.md) and settings reference pages). The 55-minute reuse window assumes the 1-hour cache that `subagentPromptCacheTtl` selects. The plugin was tested with 2.1.310.
- The `PreToolUse` hooks use `onFailure: "block"`, the `vcs-redirect` entries use `if` filters, the launch recorder is a `PostToolUse` hook on Agent, and the prebuilt workflows use the `Workflow` tool. Workflows are also subject to your plan and settings: `enableWorkflows: false`, `disableWorkflows: true` or `CLAUDE_CODE_DISABLE_WORKFLOWS=1` turns them off, and `plan` then recommends direct subagents (see [cache-and-workflows.md](cache-and-workflows.md)).
- Plugin `settings.json` supports `agent` (and `subagentStatusLine`) only, which is why `holyagent setup` exists.

## Supported environments

| Environment                                   | Status                                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code in a terminal (Linux, macOS, WSL) | Supported. The installer targets WSL Ubuntu and warns on other distributions                                                                                                      |
| Claude Code on Windows with Git Bash          | The wrapper is POSIX `sh` written to avoid forks under Git Bash; the installer does not cover it                                                                                  |
| T3 Code                                       | Works through the Claude Agent SDK; see [usage.md](usage.md)                                                                                                                      |
| Claude Code desktop app, Code tab             | Billion Context is bypassed because the app sets its own `ANTHROPIC_BASE_URL`, yet `DISABLE_AUTO_COMPACT` still applies, so nothing compacts (see [components.md](components.md)) |
| Claude Code on the web (cloud sessions)       | Billion Context does not run; commits are unsigned (see [commit-authorship.md](commit-authorship.md)). Claude Code does not load locally installed plugins there                  |
| claude.ai chat and Cowork                     | Skills only; agents, hooks and settings are ignored (see [usage.md](usage.md))                                                                                                    |
| Pi                                            | Not in 0.1.0; see [pi/README.md](pi/README.md)                                                                                                                                    |

The public `holyagent` CLI is a Bun program (`packages/cli/src/index.ts`, with a `bun` shebang). Run it from a checkout, after `bun install` there, with `bun packages/cli/src/index.ts <command>`, or put that file on your `PATH`.
