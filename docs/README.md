# HolyAgent

HolyAgent turns a coding agent into a root that plans work as Intents and Assignments and delegates it to eighteen specialists, with a CLI that keeps the state, commits as the account owner and keeps the prompt cache warm without asking the model to reason about it.

It has two layers:

- **Shared runtime** (`packages/runtime`): the domain (Intents, Assignments, the specialist routes, warm reuse), the state under `.holyagent/`, the `vcs` commands, the instruction text and the command surface the root calls.
- **Per-harness integrations** (`packages/integrations/*`): code that turns the runtime into a plugin for one harness. `packages/integrations/claude` generates the Claude Code plugin.

[T3 Code with the Pi provider](usage.md#install) is the only supported interface. Use [the quickstart](usage.md#install) to install it, run `holyagent setup` and check it with `holyagent doctor`. If you used standalone Pi or Claude Code, see [migration](usage.md#migrate-to-t3-code).

The Claude integration is retained internally. References to its settings and hooks elsewhere describe development or historical behavior, not a supported standalone workflow.

## Pages

| Page                                             | Read it for                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [usage.md](usage.md)                             | T3 Code installation, first-launch setup, migration and legacy reference                              |
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
| [pi/screen.md](pi/screen.md)                     | The screen capability and browser use: what an Assignment gets, the route, opencode browse, the forms |
