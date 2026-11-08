# Components

What HolyAgent installs or configures, and why. The installers (`install/wsl-install.sh` for WSL Ubuntu, `install/windows-install.ps1` for native Windows) set up only the prerequisites; `holyagent setup` (run as `/holyagent:setup`) installs and configures the rest. Both skip any step that is already right, so re-running changes nothing that is already set.

| Component                       | Installed by                                                               | Why                                                                       |
| ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| mise                            | Installers, only with `--dev` (`-Dev`)                                     | Version manager and the source of the repository's commands (development) |
| Node.js LTS                     | WSL and Windows installers (apt, winget)                                   | ctx7 runs on Node                                                         |
| Bun                             | WSL and Windows installers (Bun's install script)                          | Runs the plugin's hooks and CLI; development needs a canary build         |
| git, gh                         | WSL installer (apt), Windows installer (winget)                            | Every commit, branch and PR step runs them                                |
| HolyAgent plugin                | Marketplace (`claude plugin install holyagent@holyagent`)                  | The root agent, specialists, skills, hooks and runtime CLI                |
| ctx7 and skill                  | `holyagent setup`                                                          | Current library documentation for the agents                              |
| Pi (optional)                   | You, with Pi's installer or npm (see below)                                | The agent host of the Pi integration; needs Node.js 22.19 or newer        |
| HolyAgent Pi package (optional) | `pi install git:github.com/davidbasilefilho/holyagent@holyagent-<version>` | The root, 18 specialists, skills and extension on Pi                      |
| Exa connector                   | claude.ai connectors (see [Exa](#exa))                                     | Web search and page reading for the Search specialists                    |

Claude Code itself is a prerequisite that none of these install; Anthropic documents the ways to get it at <https://code.claude.com/docs/en/setup>.

ripgrep and fd ship inside the plugin rather than being installed; see [ripgrep and fd](#ripgrep-and-fd).

Pi is not installed by these installers. The Pi integration is `packages/integrations/pi`, which builds the HolyAgent Pi package (`packages/integrations/pi/dist`): the 18 specialists as agent files, the skills, an extension that gives each Pi session its role and context, and the bundled CLI behind a wrapper. You install Pi yourself (Node.js 22.19 or newer, then the official installer or `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.5.0`) and the package with `pi install git:github.com/davidbasilefilho/holyagent@holyagent-<version>`, globally or per project; plain `pi` then starts the root ([pi/installation.md](pi/installation.md), [usage.md](usage.md#pi), [pi/README.md](pi/README.md)). The package lists no dependencies; `holyagent setup` installs the Pi packages your `config.json` enables, each at an exact pin ([pi/configuration.md](pi/configuration.md#holyagent-configjson)). T3 Code as its primary interface is planned and not shipped ([pi/t3-code.md](pi/t3-code.md)).

The plugin installs at user, project or local scope ([usage.md](usage.md#install-scopes)). A user-level `~/.holyagent/config.json` holds your defaults and the project's `.holyagent/config.json` overrides it key by key ([pi/configuration.md](pi/configuration.md#the-user-level-config)).

## mise, Node, Bun, gh

The WSL installer first installs any missing apt packages (`curl`, `git`, `ca-certificates`, `unzip`) with sudo. Node LTS comes from NodeSource's apt repository, Bun from its official install script into `~/.bun`, and `gh` from GitHub's apt repository. The installer refuses a Node older than 22.13, the floor for ctx7, and puts Bun's global bin directory on `PATH` through a line in `~/.bashrc` (a one-time copy is kept as `~/.bashrc.pre-holyagent`).

The Windows installer (`install/windows-install.ps1`) installs missing `git`, Node LTS and `gh` with `winget`, and Bun from its official install script into `~\.bun`. It refuses a Node older than 22.19, the floor for Pi (ctx7 needs 22.13), and puts Bun's global bin folder on your user `PATH` ([pi/installation.md](pi/installation.md#what-setup-and-doctor-do)).

mise is installed only with the development option (`--dev` for the WSL installer, `-Dev` for the Windows one), because only developing this repository needs it. The WSL installer runs mise's official installer into `~/.local/bin/mise` and activates it in `~/.bashrc`. The Windows installer installs `jdx.mise` with `winget` and activates it in your PowerShell profile (`$PROFILE.CurrentUserAllHosts`, with a one-time copy kept as `<profile>.pre-holyagent`). Without the option, neither installer installs or activates mise.

The plugin needs only a stable Bun on `PATH`; developing this repository needs a canary build ([requirements.md](requirements.md#why-bun-canary)). `holyagent setup` installs the global package below with `bun add -g`; its command lives in `$BUN_INSTALL/bin` (`~/.bun/bin`), which the installers put on `PATH`, and setup prints a hint when that directory is not on `PATH`.

## Claude Code

Claude Code is not installed by HolyAgent. Anthropic documents the native installer, Homebrew, WinGet, the Linux package repositories and npm. The plugin is installed with the two `claude plugin` commands in [usage.md](usage.md#install).

## Exa

The Search specialists use the Exa connector, which you connect once at [claude.ai/customize/connectors](https://claude.ai/customize/connectors). It loads in claude.ai cloud sessions and in local Claude Code (terminal, IDE, desktop) signed in with that claude.ai account, where its tools are named `mcp__claude_ai_Exa__web_search_exa` and `mcp__claude_ai_Exa__web_fetch_exa` ([MCP](https://code.claude.com/docs/en/mcp), "Use MCP servers from claude.ai"; [permissions](https://code.claude.com/docs/en/permissions)). HolyAgent supports only claude.ai account login, so API keys, Bedrock and Vertex are out of scope. The plugin itself has no dependencies. Every agent, the root included, inherits every MCP server of the session, custom ones too: no generated agent has a `tools:` line, so none lists MCP tool names. Each agent's `disallowedTools:` line instead lists the built-in tools its role must not use, derived in `agents.ts` from one list of built-ins so that a role's grant and its denial cannot drift. Native `WebSearch` and `WebFetch` are denied to every agent, and the Search specialists (Librarian.lookup and Librarian.research) search with the Exa tools `web_search_exa` and `web_fetch_exa`, which their role text says when to use. When the Exa connector is not connected, they report a missing web tool as a blocker instead of guessing, and they do the same when an Exa tool fails on authentication or a rate limit.

**Why Exa.** [Exa 3.0](https://exa.ai/blog/exa-3) (2026-10-19) is, in Exa's words, its largest search-quality improvement. It ranks first on the independent [Artificial Analysis Search Index](https://artificialanalysis.ai/agents/search-api), per [Exa's post](https://exa.ai/blog/artificial-analysis-exa-3-best-search-api). Its Dynamic Highlights use 95% fewer tokens than full page text, which keeps the agents' context small, and Exa runs its own crawler and index. Exa's head-to-head benchmark table against Perplexity, Brave and Parallel is self-reported, so treat it as a vendor claim rather than an independent result.

`holyagent setup` also adds `WebSearch` and `WebFetch` to `permissions.deny` in your user settings, so agents outside HolyAgent do not fall back to them either. A user settings file that already has a `permissions.deny` list keeps it unchanged; add the two entries by hand there. A plugin cannot set permissions, so the plugin alone leaves the built-in web tools on for agents other than HolyAgent's.

## ripgrep and fd

The plugin bundles ripgrep and fd for macOS on Apple silicon, Linux on x64 and Windows on x64, and runs them through `holyagent rg` and `holyagent fd` (arguments, stdin, stdout and exit code are the program's own). Every agent with a Bash tool searches with them instead of grep, find or the built-in Grep and Glob, so a search answers the same on every machine and the agents need nothing installed. The agents without Bash (the explorers, the librarians, `reviewer-audit`, `reviewer-artifact`, `reviewer-security` and `reviewer-visual`) keep the built-in Grep and Glob. Claude Code documents its Grep tool as built on ripgrep; it documents no backend for Glob. On any other platform the commands fail with `UnsupportedPlatform`, and the agents use their own search. How the programs are pinned and built is in [development.md](development.md#the-generated-plugin).

## ctx7 and the Context7 skill

`holyagent setup` runs `bun add -g ctx7`, then `ctx7 setup --cli --claude --yes` (CLI and skills mode, no MCP server). That writes `~/.claude/skills/find-docs/SKILL.md` and a rule `~/.claude/rules/context7.md`, which tells agents to run `npx ctx7@latest library …` and `docs …` (so the agents need `npx` at runtime), and stores credentials in `~/.config/context7/credentials.json`.

Hosted setup needs a login or API key. With neither, `ctx7 setup --yes` would block on a browser device flow, so HolyAgent skips the step with a hint instead. Set `CONTEXT7_API_KEY` or run `ctx7 login`, then re-run. ctx7 reads the key only from the command line during setup, so HolyAgent passes `--api-key`, visible in the process list for the seconds the command runs. `ctx7 library` and `ctx7 docs` work without authentication at a lower rate limit. `ctx7 remove --claude --cli` undoes the setup.

## What `holyagent setup` and `holyagent doctor` do

`holyagent setup [--scope user|project|local] [--undo] [--dry-run] [--subagent-cache-ttl 1h|5m] [--skip-ctx7]` runs three steps, in this order, each of which checks its own result first:

- ctx7: the package and the Context7 skill (above);
- Pi packages: only when Pi is in use (`HOLYAGENT_HOST=pi` or `pi` on `PATH`) and not in a cloud session. For each package the `config.json` enables that Pi's settings do not list at its pin, it runs `pi install npm:<name>@<pin>`, and for each HolyAgent feature package the settings list that the config turns off, `pi remove npm:<name>`. With `pi.enable` off it removes nothing and says so. `--scope user` works on Pi's global settings, and `project` and `local` both on the project's `.pi/settings.json` with `-l` ([pi/installation.md](pi/installation.md#what-setup-and-doctor-do));
- settings: the missing keys (in the file of `--scope`, the user settings by default) among `attribution`, `includeGitInstructions`, `subagentPromptCacheTtl`, `modelSettings["claude-opus-5-5"]` (`effortLevel` and `autoCompactWindow`), `extraKnownMarketplaces`, `enabledPlugins` and `permissions.deny` are added to `~/.claude/settings.json` (or the file in `CLAUDE_CONFIG_DIR`) for `--scope user`, or to the project's `.claude/settings.json` or `.claude/settings.local.json`, and no value that is already set changes ([usage.md](usage.md#user-settings) lists them).

In a claude.ai cloud session (`CLAUDE_CODE_REMOTE=true`) there is no machine of yours to install on, so the ctx7 and Pi steps are skipped and the settings step still runs. Setup does not register the plugin, which the two `claude plugin` commands do, it does not install Pi, and it does not check Bun's build. With `--undo` only the settings change: ctx7 and the Pi packages stay installed.

`holyagent doctor [--scope user|project|local] [--fix]` prints one line per check and exits 1 when any fails:

- `bun` is on `PATH`;
- `ctx7` is on `PATH` (it passes in a cloud session, where setup leaves it out);
- the user settings have the keys `holyagent setup` writes;
- the Pi checks, run only when Pi is in use (`HOLYAGENT_HOST=pi` or `pi` on `PATH`; never in a cloud session) and `pi.enable` is on: `pi` is on `PATH` at the pinned version or newer, Node.js is 22.19 or newer, the HolyAgent Pi package is listed in the global or the project Pi settings, and every package the config enables is listed there at its pin. When Pi is not in use, one `~ pi: not in use` line is printed and nothing fails. These checks only report, with the install command as the fix, and `--fix` installs none of them ([pi/installation.md](pi/installation.md#what-setup-and-doctor-do));

Planned for 0.3.0: `--scope` defaults to the scope the plugin is installed at instead of `user` ([usage.md](usage.md#install-scopes)).

`--fix` runs the setup steps behind a failing check and checks again; it never installs Bun, Pi, Node.js or the Pi package. `/holyagent:setup` runs `holyagent setup` from a session, and the session-start hook adds one line suggesting it while `ctx7` or a key is missing ([hooks.md](hooks.md)).
