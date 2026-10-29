# Components

What HolyAgent installs or configures, and why. The installers (`install/wsl-install.sh` for WSL Ubuntu, `install/windows-install.ps1` for native Windows) and the public CLI (`holyagent setup claude`, `holyagent doctor`) both skip any step that is already right, so re-running changes nothing that is already set.

| Component        | Installed by                                                        | Why                                                         |
| ---------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| mise             | WSL and Windows installers                                          | Version manager and the source of the repository's commands |
| Node.js LTS      | WSL and Windows installers (`mise use -g node@lts`)                 | ctx7 runs on Node                                           |
| Bun (canary)     | WSL and Windows installers (`mise use -g bun`, then canary)         | Runs the plugin CLI and the repository toolchain            |
| Claude Code      | WSL and Windows installers (`bun add -g @anthropic-ai/claude-code`) | The harness                                                 |
| HolyAgent plugin | Marketplace, `holyagent setup claude`                               | The root agent, specialists, skills, hooks and runtime CLI  |
| ctx7 and skill   | Installers, `holyagent setup claude`                                | Current library documentation for the agents                |
| Exa connector    | claude.ai connectors (see [Exa](#exa))                              | Web search and page reading for the Search specialists      |

ripgrep and fd ship inside the plugin rather than being installed; see [ripgrep and fd](#ripgrep-and-fd).

Pi is not installed: 0.1.0 has no Pi integration ([pi/README.md](pi/README.md)).

## mise, Node, Bun

The installer first installs any missing apt packages (`curl`, `git`, `ca-certificates`, `unzip`, `build-essential`) with sudo. mise is installed with its official installer to `~/.local/bin/mise` and activated in `~/.bashrc` (the installer keeps a one-time copy as `~/.bashrc.pre-holyagent`). Node comes from `mise use -g node@lts` and the installer refuses a Node older than 22.13, the floor for ctx7.

The Windows installer (`install/windows-install.ps1`) installs missing `git` and `mise` with `winget` instead of apt and mise's shell installer. It activates mise in your PowerShell profile (`$PROFILE.CurrentUserAllHosts`, with a one-time copy kept as `<profile>.pre-holyagent`), puts Bun's global bin folder on your user `PATH`. Node, Bun, Claude Code and ctx7 are installed exactly as above.

Bun is installed by mise as a stable build and upgraded to canary with `bun upgrade --canary` ([requirements.md](requirements.md) says why). The canary is re-applied rather than assumed: the installer checks `bun --revision` on every run, `holyagent doctor` reports a non-canary Bun and `holyagent doctor --fix` upgrades it (with `BUN_OPTIONS` unset), and the repository's `toolchain` task fails on a non-canary Bun. Installing the global packages below uses `bun add -g`; their commands live in `$BUN_INSTALL/bin` (`~/.bun/bin`), which the installer puts on `PATH`.

## Claude Code

The installer installs `@anthropic-ai/claude-code` with Bun. Anthropic documents the native installer, Homebrew, WinGet, the Linux package repositories and npm; installing the same npm package with Bun works but is not a documented method, and how such a copy auto-updates is undocumented. If you installed Claude Code another way, the installer finds `claude` on `PATH` and leaves it alone.

## Exa

The Search specialists use the Exa connector, which you connect once at [claude.ai/customize/connectors](https://claude.ai/customize/connectors). It loads in claude.ai cloud sessions and in local Claude Code (terminal, IDE, desktop) signed in with that claude.ai account, where its tools are named `mcp__claude_ai_Exa__web_search_exa` and `mcp__claude_ai_Exa__web_fetch_exa` ([MCP](https://code.claude.com/docs/en/mcp), "Use MCP servers from claude.ai"; [permissions](https://code.claude.com/docs/en/permissions)). HolyAgent supports only claude.ai account login, so API keys, Bedrock and Vertex are out of scope. The plugin itself has no dependencies. Every agent, the root included, inherits every MCP server of the session, custom ones too: no generated agent has a `tools:` line, so none lists MCP tool names. Each agent's `disallowedTools:` line instead lists the built-in tools its role must not use, derived in `agents.ts` from one list of built-ins so that a role's grant and its denial cannot drift. Native `WebSearch` and `WebFetch` are denied to every agent, and the Search specialists (Librarian.lookup and Librarian.research) search with the Exa tools `web_search_exa` and `web_fetch_exa`, which their role text says when to use. When the Exa connector is not connected, they report a missing web tool as a blocker instead of guessing, and they do the same when an Exa tool fails on authentication or a rate limit.

**Why Exa.** [Exa 3.0](https://exa.ai/blog/exa-3) (2026-10-19) is, in Exa's words, its largest search-quality improvement. It ranks first on the independent [Artificial Analysis Search Index](https://artificialanalysis.ai/agents/search-api), per [Exa's post](https://exa.ai/blog/artificial-analysis-exa-3-best-search-api). Its Dynamic Highlights use 95% fewer tokens than full page text, which keeps the agents' context small, and Exa runs its own crawler and index. Exa's head-to-head benchmark table against Perplexity, Brave and Parallel is self-reported, so treat it as a vendor claim rather than an independent result.

`holyagent setup claude` also adds `WebSearch` and `WebFetch` to the project's `permissions.deny`, so agents outside HolyAgent do not fall back to them either. A project that already has a `permissions.deny` list keeps it unchanged; add the two entries by hand there. A plugin cannot set permissions, so the marketplace route alone leaves the built-in web tools on for agents other than HolyAgent's.

## ripgrep and fd

The plugin bundles ripgrep 15.2.0 and fd 10.5.0 for macOS on Apple silicon, Linux on x64 and Windows on x64, and runs them through `holyagent rg` and `holyagent fd` (arguments, stdin, stdout and exit code are the program's own). Every agent with a Bash tool searches with them instead of grep, find or the built-in Grep and Glob, so a search answers the same on every machine and the agents need nothing installed. The agents without Bash (the explorers, the librarians, `reviewer-audit`, `reviewer-artifact`, `reviewer-security` and `reviewer-visual`) keep the built-in Grep and Glob. Claude Code documents its Grep tool as built on ripgrep; it documents no backend for Glob. On any other platform the commands fail with `UnsupportedPlatform`, and the agents use their own search. How the programs are pinned and built is in [development.md](development.md#the-generated-plugin).

## ctx7 and the Context7 skill

`bun add -g ctx7`, then `ctx7 setup --cli --claude --yes` (CLI and skills mode, no MCP server). That writes `~/.claude/skills/find-docs/SKILL.md` and a rule `~/.claude/rules/context7.md`, which tells agents to run `npx ctx7@latest library …` and `docs …` (so the agents need `npx` at runtime), and stores credentials in `~/.config/context7/credentials.json`.

Hosted setup needs a login or API key. With neither, `ctx7 setup --yes` would block on a browser device flow, so HolyAgent skips the step with a hint instead. Set `CONTEXT7_API_KEY` or run `ctx7 login`, then re-run. ctx7 reads the key only from the command line during setup, so HolyAgent passes `--api-key`, visible in the process list for the seconds the command runs. `ctx7 library` and `ctx7 docs` work without authentication at a lower rate limit. `ctx7 remove --claude --cli` undoes the setup.

## What `holyagent doctor` checks

One line per check, exit 1 when any fails:

- Bun is a canary build (`--fix` upgrades it);
- `claude` and `ctx7` are on `PATH`;
- the project's `.claude/settings.json` has the keys `holyagent setup claude` writes;
- the `holyagent@holyagent` plugin is installed.
