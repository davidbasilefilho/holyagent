# HolyAgent

HolyAgent turns a coding agent into a root that plans work as Intents and Assignments and delegates it to eighteen specialists, with a CLI that keeps the state, commits as the account owner and keeps the prompt cache warm without asking the model to reason about it.

It has two layers:

- **Shared runtime** (`packages/runtime`): the domain (Intents, Assignments, the specialist routes, warm reuse), the state under `.holyagent/`, the `vcs` commands, the instruction text and the command surface the root calls.
- **Per-harness integrations** (`packages/integrations/*`): code that turns the runtime into a plugin for one harness. `packages/integrations/claude` generates the Claude Code plugin.

Release 0.1.0 ships the Claude Code integration only. A Pi integration comes later; its research is in [pi/README.md](pi/README.md).

HolyAgent installs as a plugin with three `claude plugin` commands and nothing else ([usage.md](usage.md#install)). Its one command-line program, `holyagent`, is the runtime CLI inside the plugin: `bun --no-env-file --config="<plugin>/scripts/empty-bunfig.toml" "<plugin>/scripts/holyagent.js" <command>`, with `<plugin>` the plugin folder (`${CLAUDE_PLUGIN_ROOT}` inside a session); it runs in bash, PowerShell and cmd, is not on your `PATH`, and `holyagent vcs`, `holyagent plan` and the like in these pages mean it. The root agent and the plugin's hooks run `intent`, `assignment`, `plan`, `status`, `reconcile`, `vcs`, `hook`, `rg` and `fd`; you run `setup` and `doctor`, usually through `/holyagent:setup`.

## Pages

| Page                                             | Read it for                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| [usage.md](usage.md)                             | Install, first-launch setup, how a session works, claude.ai and T3 Code     |
| [requirements.md](requirements.md)               | What must be installed and which environments work                          |
| [components.md](components.md)                   | What HolyAgent installs and configures, and why                             |
| [commit-authorship.md](commit-authorship.md)     | How commits and PRs are made, why they can be unsigned, how text is cleaned |
| [cache-and-workflows.md](cache-and-workflows.md) | How the design keeps the cache warm; how workflows run                      |
| [hooks.md](hooks.md)                             | The hooks, what was removed and why                                         |
| [development.md](development.md)                 | Repository layout, gates, the generated plugin, versioning                  |
| [decisions.md](decisions.md)                     | Standing decisions and their reasons                                        |
| [attributions.md](attributions.md)               | Third-party software HolyAgent uses and the attribution it owes             |
| [pi/README.md](pi/README.md)                     | Research notes for the future Pi integration                                |
