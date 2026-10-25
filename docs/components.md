# Components

What HolyAgent installs or configures, and why. The WSL installer (`install/wsl-install.sh`) and the public CLI (`holyagent install`, `holyagent doctor`) both skip any step that is already right, so re-running changes nothing that is already set.

| Component        | Installed by                                           | Why                                                                         |
| ---------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| mise             | WSL installer                                          | Version manager and the source of the repository's commands                 |
| Node.js LTS      | WSL installer (`mise use -g node@lts`)                 | Billion Context and ctx7 run on Node                                        |
| Bun (canary)     | WSL installer (`mise use -g bun`, then canary)         | Runs the plugin CLI and the repository toolchain                            |
| Claude Code      | WSL installer (`bun add -g @anthropic-ai/claude-code`) | The harness                                                                 |
| HolyAgent plugin | Marketplace, `holyagent install`                       | The root agent, specialists, skills, workflows, hooks and runtime CLI       |
| Billion Context  | WSL installer, `holyagent install`                     | Compresses the conversation so long sessions stay inside the context window |
| ctx7 and skill   | WSL installer, `holyagent install`                     | Current library documentation for the agents                                |

Pi is not installed: 0.1.0 has no Pi integration ([pi/README.md](pi/README.md)).

## mise, Node, Bun

The installer first installs any missing apt packages (`curl`, `git`, `ca-certificates`, `unzip`, `build-essential`) with sudo. mise is installed with its official installer to `~/.local/bin/mise` and activated in `~/.bashrc` (the installer keeps a one-time copy as `~/.bashrc.pre-holyagent`). Node comes from `mise use -g node@lts` and the installer refuses a Node older than 22.13, the floor for ctx7.

Bun is installed by mise as a stable build and upgraded to canary with `bun upgrade --canary` ([requirements.md](requirements.md) says why). The canary is re-applied rather than assumed: the installer checks `bun --revision` on every run, `holyagent doctor` reports a non-canary Bun and `holyagent doctor --fix` upgrades it (with `BUN_OPTIONS` unset), and the repository's `toolchain` task fails on a non-canary Bun. Installing the global packages below uses `bun add -g`; their commands live in `$BUN_INSTALL/bin` (`~/.bun/bin`), which the installer puts on `PATH`.

## Claude Code

The installer installs `@anthropic-ai/claude-code` with Bun. Anthropic documents the native installer, Homebrew, WinGet, the Linux package repositories and npm; installing the same npm package with Bun works but is not a documented method, and how such a copy auto-updates is undocumented. If you installed Claude Code another way, the installer finds `claude` on `PATH` and leaves it alone.

## Billion Context

[Billion Context](https://github.com/ranxianglei/billion-context) (`bili`) is a local HTTP proxy between Claude Code and the model API. It adds four tools (`compress`, `decompress`, `search_context`, `acp_status`) and a compression prompt to each request, and the model decides what to fold. See [attributions.md](attributions.md) for its license terms.

`holyagent install` and the installer run `bun add -g billion-context` (its README documents npm only; the commands run on Node through their shebang), then `bili plugin install claude`, the native mode. Native mode merges into `~/.claude/settings.json`:

- `env.ANTHROPIC_BASE_URL` pointing at `http://127.0.0.1:18787/bili/https://api.anthropic.com` (an existing, different `ANTHROPIC_BASE_URL` is never overwritten),
- `env.DISABLE_AUTO_COMPACT=1`, because Billion Context owns compression; a manual `/compact` still works,
- a `SessionStart` hook that starts the proxy for the session,

and adds `~/.claude/commands/acp-cache.md` and an MCP server `bili` in `~/.claude.json`, with settings backups. The step runs only when one of those artifacts is missing, since every run writes another backup.

Settings HolyAgent relies on:

- `compress.rules: true` in `~/.config/billion-context/billion-context.json` (or `$BILI_CONFIG_FILE`), set only when the key is absent, file mode 0600. Billion Context's configuration reference describes it as persistent model reminders delivered through an injected `acp_rule` tool and hard-protected from folds, and as "Proxy-mode only — inert in plugin mode, where the host owns the tool surface". It does not say which of the two applies to Claude Code's native mode, which combines a session-owned proxy with a `bili` MCP server, so whether the setting takes effect there is unconfirmed.
- `subagentSplit`, on by default and left alone: requests from background subagents get their own session namespace, with their own lock chain and compression state, instead of queueing behind the main session. Every HolyAgent specialist runs in the background.

**The root's rules do not depend on `compress.rules`.** They are the body of the root agent, so they sit in the system prompt, and Billion Context keeps the original head system block byte-stable across compressions. Text that arrives as conversation messages, such as the session-start hook's context, is not documented as exempt from folding; the hook adds only a short status (plus the Running rows of `reconcile` after a resume or compaction) for that reason (see [hooks.md](hooks.md)).

**Cache.** Billion Context documents a 95 to 97 percent prefix-cache hit rate for a healthy session. A fold rewrites the prefix from the fold point onward, so the first request after one is a cache miss. Billion Context stamps `cache_control` itself only when the client sets none, and Claude Code sets its own, so its stamps are off here. Its optional keep-alive replay is off by default.

**Limits.**

- Apps that set their own `ANTHROPIC_BASE_URL`, such as the Claude Desktop Code tab, bypass the proxy. `DISABLE_AUTO_COMPACT=1` still applies there, so neither compression runs.
- Cloud sessions (Claude Code on the web) do not run the proxy.
- By default it auto-updates itself from npm in a staggered rollout, and the proxy has no authentication (it listens on `127.0.0.1`). It requires Node 20 or later.
- `bili plugin remove claude` undoes native mode.

## ctx7 and the Context7 skill

`bun add -g ctx7`, then `ctx7 setup --cli --claude --yes` (CLI and skills mode, no MCP server). That writes `~/.claude/skills/find-docs/SKILL.md` and a rule `~/.claude/rules/context7.md`, which tells agents to run `npx ctx7@latest library …` and `docs …` (so the agents need `npx` at runtime), and stores credentials in `~/.config/context7/credentials.json`.

Hosted setup needs a login or API key. With neither, `ctx7 setup --yes` would block on a browser device flow, so HolyAgent skips the step with a hint instead. Set `CONTEXT7_API_KEY` or run `ctx7 login`, then re-run. ctx7 reads the key only from the command line during setup, so HolyAgent passes `--api-key`, visible in the process list for the seconds the command runs. `ctx7 library` and `ctx7 docs` work without authentication at a lower rate limit. `ctx7 remove --claude --cli` undoes the setup.

## What `holyagent doctor` checks

One line per check, exit 1 when any fails:

- Bun is a canary build (`--fix` upgrades it);
- `claude`, `bili` and `ctx7` are on `PATH`;
- the project's `.claude/settings.json` has the keys `holyagent setup` writes;
- the `holyagent@holyagent` plugin is installed.
