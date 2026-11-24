# HolyAgent

HolyAgent gives your coding agent a workflow for direct fixes and larger deliveries. It carries out small, low-risk work directly and coordinates independent specialists when complexity, risk or review warrants it.

Describe what you want. For coordinated work, the root records an Intent, gives specialists scoped Assignments, and checks the result against evidence before accepting it.

[T3 Code](https://github.com/pingdotgg/t3code) is the only supported interface. HolyAgent runs through its Pi provider; Pi is the backend, not a separate supported interface.

## How do I install it?

Install and open T3 Code, then follow the [T3 Code quickstart](docs/usage.md#install) to install the backend, run `holyagent setup` and open your first thread. See [migration](docs/usage.md#migrate-to-t3-code) if you used standalone Claude Code or Pi.

## Why HolyAgent?

- **It fits the work you have.** From a one-line fix to a stacked multi-PR delivery, through bug hunts, codebase questions, reviews, refactors, UI work and solo or coursework repositories ([docs/usage.md](docs/usage.md#what-it-fits)).
- **A root agent with specialists when needed.** The root handles simple tasks directly and owns the plan and final decision. For complex work, specialists take bounded Assignments with acceptance criteria and evidence.
- **A warm cache, by design.** Prompts put stable material first, specialists are reused while their cache is alive, and the CLI embeds the timing so the model carries none of that reasoning. See [docs/cache-and-workflows.md](docs/cache-and-workflows.md).
- **State outside the conversation.** Intents and Assignments live in `.holyagent/`, so a resumed or compacted session picks up exactly where the work stands, through a small, bounded session-start hook ([docs/hooks.md](docs/hooks.md)).
- **Commits you own.** The internal `holyagent-cli vcs` records commits and pull requests for the project. The Claude integration applies its own authorship rules. [Commit authorship](docs/commit-authorship.md)
- **Opinionated on purpose.** The root and specialists get distinct tools and model routes, with configurable capabilities ([docs/pi/configuration.md](docs/pi/configuration.md)).
- **Every rule has a reason.** The standing decisions and their evidence are written down in [docs/decisions.md](docs/decisions.md), and what the plugin installs and configures is explained in [docs/components.md](docs/components.md).

## Development

The contributing rules and repository pitfalls are in [AGENTS.md](AGENTS.md). The layout, the tooling, the generated plugin and versioning are in [docs/development.md](docs/development.md).

```sh
bun install --frozen-lockfile   # install native mise first; see docs/development.md
bunx --no-install mise install
bunx --no-install mise run build    # regenerate the Claude plugin after changing its sources
bunx --no-install mise run verify   # type-check, lint, format check and tests
```

`mise.toml` is the source of commands, and the repository uses stable Bun plus the locked Oxlint, tsrs and Oxfmt development tools. Commits follow Conventional Commits.

## Special thanks

- [HolyClaude](docs/decisions.md), the predecessor plugin whose one long session was audited to shape HolyAgent's decisions.
- [t3dotgg/tstack](https://github.com/t3dotgg/tstack), for the inspiration.
- Anthropic's [frontend-design](docs/attributions.md#design-skill-sources) skill, an inspiration for the design skills.
- [Context7](https://context7.com), [Effect](https://effect.website), [Bun](https://bun.sh), [mise](https://mise.jdx.dev), [hk](https://hk.jdx.dev), [TOON](https://toonformat.dev), [acorn](https://github.com/acornjs/acorn), [ripgrep](https://github.com/BurntSushi/ripgrep) and [fd](https://github.com/sharkdp/fd), the software HolyAgent builds with or needs.

The full list, with licenses, is in [docs/attributions.md](docs/attributions.md).

## License

HolyAgent is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
