# Components

What HolyAgent installs or configures, and why. The installers (`install/wsl-install.sh` for WSL Ubuntu, `install/windows-install.ps1` for native Windows) set up only the prerequisites; `holyagent setup` (run as `/holyagent:setup`) installs and configures the rest. Both skip any step that is already right, so re-running changes nothing that is already set.

| Component        | Installed by                                              | Why                                                                       |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| mise             | Installers, only with `--dev` (`-Dev`)                    | Version manager and the source of the repository's commands (development) |
| Node.js LTS      | WSL and Windows installers (apt, winget)                  | ctx7 runs on Node                                                         |
| Bun              | WSL and Windows installers (Bun's install script)         | Runs the plugin's hooks and CLI; development needs a canary build         |
| git, gh          | WSL installer (apt), Windows installer (winget)           | Every commit, branch and PR step runs them                                |
| HolyAgent plugin | Marketplace (`claude plugin install holyagent@holyagent`) | The root agent, specialists, skills, hooks and runtime CLI                |
| ctx7 and skill   | `holyagent setup`                                         | Current library documentation for the agents                              |
| Exa connector    | claude.ai connectors (see [Exa](#exa))                    | Web search and page reading for the Search specialists                    |

Claude Code itself is a prerequisite that none of these install; Anthropic documents the ways to get it at <https://code.claude.com/docs/en/setup>.

ripgrep and fd ship inside the plugin rather than being installed; see [ripgrep and fd](#ripgrep-and-fd).

Pi is not installed: 0.1.0 has no Pi integration ([pi/README.md](pi/README.md)).

## mise, Node, Bun, gh

The WSL installer first installs any missing apt packages (`curl`, `git`, `ca-certificates`, `unzip`) with sudo. Node LTS comes from NodeSource's apt repository, Bun from its official install script into `~/.bun`, and `gh` from GitHub's apt repository. The installer refuses a Node older than 22.13, the floor for ctx7, and puts Bun's global bin directory on `PATH` through a line in `~/.bashrc` (a one-time copy is kept as `~/.bashrc.pre-holyagent`).

The Windows installer (`install/windows-install.ps1`) installs missing `git`, Node LTS and `gh` with `winget`, and Bun from its official install script into `~\.bun`. It refuses a Node older than 22.13 and puts Bun's global bin folder on your user `PATH`.

mise is installed only with the development option (`--dev` for the WSL installer, `-Dev` for the Windows one), because only developing this repository needs it. The WSL installer runs mise's official installer into `~/.local/bin/mise` and activates it in `~/.bashrc`. The Windows installer installs `jdx.mise` with `winget` and activates it in your PowerShell profile (`$PROFILE.CurrentUserAllHosts`, with a one-time copy kept as `<profile>.pre-holyagent`). Without the option, neither installer installs or activates mise.

The plugin needs only a stable Bun on `PATH`. Developing this repository needs a canary build ([requirements.md](requirements.md#why-bun-canary) says why), which the `postinstall` hook of `mise install` provides and the repository's `toolchain` task checks; `holyagent setup` and `holyagent doctor` do not look at the build. `holyagent setup` installs the global package below with `bun add -g`; its command lives in `$BUN_INSTALL/bin` (`~/.bun/bin`), which the installers put on `PATH`, and setup prints a hint when that directory is not on `PATH`.

## Claude Code

Claude Code is not installed by HolyAgent. Anthropic documents the native installer, Homebrew, WinGet, the Linux package repositories and npm. The plugin is installed with the two `claude plugin` commands in [usage.md](usage.md#install).

## Exa

The Search specialists use the Exa connector, which you connect once at [claude.ai/customize/connectors](https://claude.ai/customize/connectors). It loads in claude.ai cloud sessions and in local Claude Code (terminal, IDE, desktop) signed in with that claude.ai account, where its tools are named `mcp__claude_ai_Exa__web_search_exa` and `mcp__claude_ai_Exa__web_fetch_exa` ([MCP](https://code.claude.com/docs/en/mcp), "Use MCP servers from claude.ai"; [permissions](https://code.claude.com/docs/en/permissions)). HolyAgent supports only claude.ai account login, so API keys, Bedrock and Vertex are out of scope. The plugin itself has no dependencies. Every agent, the root included, inherits every MCP server of the session, custom ones too: no generated agent has a `tools:` line, so none lists MCP tool names. Each agent's `disallowedTools:` line instead lists the built-in tools its role must not use, derived in `agents.ts` from one list of built-ins so that a role's grant and its denial cannot drift. Native `WebSearch` and `WebFetch` are denied to every agent, and the Search specialists (Librarian.lookup and Librarian.research) search with the Exa tools `web_search_exa` and `web_fetch_exa`, which their role text says when to use. When the Exa connector is not connected, they report a missing web tool as a blocker instead of guessing, and they do the same when an Exa tool fails on authentication or a rate limit.

**Why Exa.** [Exa 3.0](https://exa.ai/blog/exa-3) (2026-10-19) is, in Exa's words, its largest search-quality improvement. It ranks first on the independent [Artificial Analysis Search Index](https://artificialanalysis.ai/agents/search-api), per [Exa's post](https://exa.ai/blog/artificial-analysis-exa-3-best-search-api). Its Dynamic Highlights use 95% fewer tokens than full page text, which keeps the agents' context small, and Exa runs its own crawler and index. Exa's head-to-head benchmark table against Perplexity, Brave and Parallel is self-reported, so treat it as a vendor claim rather than an independent result.

`holyagent setup` also adds `WebSearch` and `WebFetch` to `permissions.deny` in your user settings, so agents outside HolyAgent do not fall back to them either. A user settings file that already has a `permissions.deny` list keeps it unchanged; add the two entries by hand there. A plugin cannot set permissions, so the plugin alone leaves the built-in web tools on for agents other than HolyAgent's.

## ripgrep and fd

The plugin bundles ripgrep 15.2.0 and fd 10.5.0 for macOS on Apple silicon, Linux on x64 and Windows on x64, and runs them through `holyagent rg` and `holyagent fd` (arguments, stdin, stdout and exit code are the program's own). Every agent with a Bash tool searches with them instead of grep, find or the built-in Grep and Glob, so a search answers the same on every machine and the agents need nothing installed. The agents without Bash (the explorers, the librarians, `reviewer-audit`, `reviewer-artifact`, `reviewer-security` and `reviewer-visual`) keep the built-in Grep and Glob. Claude Code documents its Grep tool as built on ripgrep; it documents no backend for Glob. On any other platform the commands fail with `UnsupportedPlatform`, and the agents use their own search. How the programs are pinned and built is in [development.md](development.md#the-generated-plugin).

## ctx7 and the Context7 skill

`holyagent setup` runs `bun add -g ctx7`, then `ctx7 setup --cli --claude --yes` (CLI and skills mode, no MCP server). That writes `~/.claude/skills/find-docs/SKILL.md` and a rule `~/.claude/rules/context7.md`, which tells agents to run `npx ctx7@latest library …` and `docs …` (so the agents need `npx` at runtime), and stores credentials in `~/.config/context7/credentials.json`.

Hosted setup needs a login or API key. With neither, `ctx7 setup --yes` would block on a browser device flow, so HolyAgent skips the step with a hint instead. Set `CONTEXT7_API_KEY` or run `ctx7 login`, then re-run. ctx7 reads the key only from the command line during setup, so HolyAgent passes `--api-key`, visible in the process list for the seconds the command runs. `ctx7 library` and `ctx7 docs` work without authentication at a lower rate limit. `ctx7 remove --claude --cli` undoes the setup.

## What `holyagent setup` and `holyagent doctor` do

`holyagent setup [--dry-run] [--subagent-cache-ttl 1h|5m] [--skip-ctx7]` runs three steps, each of which checks its own result first:

- Billion Context cleanup: what an earlier setup left in your Claude Code files is removed (matched by Billion Context's own install rules, listed in [usage.md](usage.md#install)), and each removal is printed; HolyAgent no longer installs or uses Billion Context;
- ctx7: the package and the Context7 skill (above);
- user settings: the missing keys among `attribution`, `includeGitInstructions`, `subagentPromptCacheTtl`, `extraKnownMarketplaces`, `enabledPlugins` and `permissions.deny` are added to `~/.claude/settings.json` (or the file in `CLAUDE_CONFIG_DIR`), and no value that is already set changes ([usage.md](usage.md#user-settings) lists them).

In a claude.ai cloud session (`CLAUDE_CODE_REMOTE=true`) there is no machine of yours to install on, so the ctx7 step is skipped and the other two still run. Setup does not register the plugin, which the two `claude plugin` commands do, and it does not check Bun's build.

`holyagent doctor [--fix]` prints one line per check and exits 1 when any fails:

- `bun` is on `PATH`;
- `ctx7` is on `PATH` (it passes in a cloud session, where setup leaves it out);
- the user settings have the keys `holyagent setup` writes;
- no leftovers of an earlier Billion Context setup remain in your Claude Code files, and those files can be read (a `warn` line that does not fail the run; `holyagent setup` removes them).

`--fix` runs the setup steps behind a failing check and checks again; it never installs Bun and leaves leftovers to `holyagent setup`. `/holyagent:setup` runs `holyagent setup` from a session, and the session-start hook adds one line suggesting it while `ctx7` or a key is missing or setup can remove a Billion Context leftover ([hooks.md](hooks.md)).
