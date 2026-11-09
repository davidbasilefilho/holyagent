# HolyAgent

HolyAgent turns a coding agent into a root that plans work as Intents and Assignments and delegates it to eighteen specialists, with a CLI that keeps the state, commits as the account owner and keeps the prompt cache warm without asking the model to reason about it.

It has two layers:

- **Shared runtime** (`packages/runtime`): the domain (Intents, Assignments, the specialist routes, warm reuse), the state under `.holyagent/`, the `vcs` commands, the instruction text and the command surface the root calls.
- **Per-harness integrations** (`packages/integrations/*`): code that turns the runtime into a plugin for one harness. `packages/integrations/claude` generates the Claude Code plugin.

HolyAgent ships the Claude Code integration and, from 0.3.0, a Pi integration (`packages/integrations/pi`): the Pi package with the 18 specialists, the skills and an extension, global and project-local installs, the Kimi for Coding provider, the specialist launcher on `@tintinweb/pi-subagents`, the root's system prompt on Pi, T3 Code as the primary interface (its tool filter, the Full access warning and the setup screen for its settings), and `holyagent setup` and `holyagent doctor` for the Pi packages. Still planned: setting Pi's `npmCommand` from `holyagent setup`, the macOS permission walkthrough for computer use, an adapter that shows the todo list under T3 Code, and the cache-hit measurement; [pi/README.md](pi/README.md#what-ships-now-and-what-is-planned) lists every part and its state.

HolyAgent installs as a plugin with two `claude plugin` commands and nothing else ([usage.md](usage.md#install)). Its one command-line program, `holyagent`, is the runtime CLI inside the plugin; `holyagent vcs`, `holyagent plan` and the like in these pages mean it, started as [How the hooks start](hooks.md#how-the-hooks-start) shows. It is not on your `PATH`. The root agent and the plugin's hooks run `intent`, `assignment`, `plan`, `status`, `reconcile`, `state`, `vcs`, `hook`, `rg`, `fd` and, for legacy state, `migrate`; you run `setup` and `doctor`, usually through `/holyagent:setup`.

## Pages

| Page                                             | Read it for                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [usage.md](usage.md)                             | Install and install scopes, first-launch setup, how a session works, claude.ai and T3 Code            |
| [requirements.md](requirements.md)               | What must be installed and which environments work                                                    |
| [components.md](components.md)                   | What HolyAgent installs and configures, and why                                                       |
| [commit-authorship.md](commit-authorship.md)     | How commits and PRs are made, who is author and committer, how text is cleaned                        |
| [cache-and-workflows.md](cache-and-workflows.md) | How the design keeps the cache warm; how workflows run                                                |
| [hooks.md](hooks.md)                             | The hooks, what was removed and why                                                                   |
| [development.md](development.md)                 | Repository layout, gates, the generated plugin, versioning                                            |
| [decisions.md](decisions.md)                     | Standing decisions and their reasons                                                                  |
| [attributions.md](attributions.md)               | Third-party software HolyAgent uses and the attribution it owes                                       |
| [pi/README.md](pi/README.md)                     | The Pi integration: what ships in 0.3.0 and what is planned, the decisions and the research           |
| [pi/t3-code.md](pi/t3-code.md)                   | T3 Code as the primary interface of the Pi integration: how it runs Pi, its tools, settings and setup |
| [pi/shell.md](pi/shell.md)                       | The bash tool on just-bash: which commands run in the shell and which on the machine, state, limits   |
| [pi/search.md](pi/search.md)                     | The find and grep tools on fff: override mode, the switch, the platforms and the fallback             |
