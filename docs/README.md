# HolyAgent

HolyAgent turns a coding agent into a root that plans work as Intents and Assignments and delegates it to eighteen specialists, with a CLI that keeps the state, commits as the account owner and keeps the prompt cache warm without asking the model to reason about it.

It has two layers:

- **Shared runtime** (`packages/runtime`): the domain (Intents, Assignments, the specialist routes, warm reuse), the state under `.holyagent/`, the `vcs` commands, the instruction text and the command surface the root calls.
- **Per-harness integrations** (`packages/integrations/*`): code that turns the runtime into a plugin for one harness. `packages/integrations/claude` generates the Claude Code plugin.

Release 0.1.0 ships the Claude Code integration only. A Pi integration comes later; its research is in [pi/README.md](pi/README.md).

Two commands are called `holyagent`, and they are different programs:

| Program                                                                                                                                                                                                                                                                                                                  | Where                                                                  | For                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Public CLI (`packages/cli`)                                                                                                                                                                                                                                                                                              | You run it                                                             | `setup`, `doctor`                                                                |
| Runtime CLI (`bun --no-env-file --config="<plugin>/scripts/empty-bunfig.toml" "<plugin>/scripts/holyagent.js" <command>`, with `<plugin>` the plugin folder, `${CLAUDE_PLUGIN_ROOT}` inside a session; it runs in bash, PowerShell and cmd; `holyagent vcs`, `holyagent plan` and the like in these pages mean this one) | The root agent and the plugin's hooks run it; it is not on your `PATH` | `intent`, `assignment`, `plan`, `status`, `reconcile`, `vcs`, `hook`, `rg`, `fd` |

## Pages

| Page                                             | Read it for                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| [usage.md](usage.md)                             | Install, set up a project, how a session works, claude.ai and T3 Code       |
| [requirements.md](requirements.md)               | What must be installed and which environments work                          |
| [components.md](components.md)                   | What HolyAgent installs and configures, and why                             |
| [commit-authorship.md](commit-authorship.md)     | How commits and PRs are made, why they can be unsigned, how text is cleaned |
| [cache-and-workflows.md](cache-and-workflows.md) | How the design keeps the cache warm; how workflows run                      |
| [hooks.md](hooks.md)                             | The hooks, what was removed and why                                         |
| [development.md](development.md)                 | Repository layout, gates, the generated plugin, versioning                  |
| [decisions.md](decisions.md)                     | Standing decisions and their reasons                                        |
| [attributions.md](attributions.md)               | Third-party software HolyAgent uses and the attribution it owes             |
| [pi/README.md](pi/README.md)                     | Research notes for the future Pi integration                                |
