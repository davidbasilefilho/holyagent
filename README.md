# HolyAgent

HolyAgent turns your coding agent into a root that plans work as Intents and Assignments and delegates it to eighteen specialists. A small CLI keeps the state, commits as the account owner and keeps the prompt cache warm, so the model never has to reason about any of it.

You state what you want. The root writes it down as an Intent, splits it into bounded Assignments, dispatches each to the specialist that fits (implementation, review, validation, research, visual work and more), and accepts nothing without a check run on the current head. It speaks to you only for a decision, a blocker and the final report, apart from a brief acknowledgment of each of your messages.

HolyAgent ships today as a Claude Code plugin. The shared runtime underneath is built so other harnesses can follow.

## How do I install it?

You need Claude Code 2.1.295 or later (the highest minimum the plugin documents, see [Claude Code version](docs/requirements.md#claude-code-version)), [Bun](https://bun.sh) on your `PATH` (the plugin's hooks run it), Node.js LTS (22.13 or later), `git` and an authenticated `gh`. On a clean WSL Ubuntu or native Windows machine, `install/wsl-install.sh` and `install/windows-install.ps1` install everything except Claude Code, and install mise only when you pass `--dev` or `-Dev` ([docs/usage.md](docs/usage.md#install)). The full list is in [docs/requirements.md](docs/requirements.md). Then, from a shell:

```sh
claude plugin marketplace add davidbasilefilho/holyagent
claude plugin marketplace add ranxianglei/billion-context
claude plugin install holyagent@holyagent
```

The plugin requires `billion-context` and `exa`, so add the Billion Context marketplace first, as above, and restart Claude Code afterwards. On the first launch, run `/holyagent:setup` once to install Billion Context and ctx7 and to configure Claude Code. The same steps as slash commands, the details and `holyagent doctor` are in [docs/usage.md](docs/usage.md#install), and the status of the other environments (T3 Code, the desktop app, claude.ai) is in [docs/requirements.md](docs/requirements.md#supported-environments).

## Why HolyAgent?

- **One agent that plans, many that do.** The root owns the relationship with you, the plan and the verdict. Specialists do the work in bounded Assignments, each with acceptance criteria and evidence, so a long request stays reviewable instead of drifting inside one huge context.
- **A warm cache, by design.** Prompts put stable material first, specialists are reused while their cache is alive, and the CLI embeds the timing so the model carries none of that reasoning. See [docs/cache-and-workflows.md](docs/cache-and-workflows.md).
- **State outside the conversation.** Intents and Assignments live in `.holyagent/`, so a resumed or compacted session picks up exactly where the work stands, through a small, bounded session-start hook ([docs/hooks.md](docs/hooks.md)).
- **Commits you own.** `holyagent vcs` commits and opens pull requests as the account owner, keeps agent attribution out of the text and refuses what looks like an agent identity ([docs/commit-authorship.md](docs/commit-authorship.md)).
- **Every rule has a reason.** The standing decisions and their evidence are written down in [docs/decisions.md](docs/decisions.md), and what the plugin installs and configures is explained in [docs/components.md](docs/components.md).

## Development

The contributing rules are in [.claude/CLAUDE.md](.claude/CLAUDE.md) and the pitfalls of this repository in [AGENTS.md](AGENTS.md). The layout, the tooling, the generated plugin and versioning are in [docs/development.md](docs/development.md).

```sh
mise install
bun install --frozen-lockfile
mise run build    # regenerate the Claude plugin after changing its sources
mise run verify   # type-check, lint, format check and tests
```

`mise.toml` is the source of commands, and the repository toolchain needs a canary Bun, which the `toolchain` task checks for you. Commits follow Conventional Commits.

## Special thanks

- [HolyClaude](docs/decisions.md), the predecessor plugin whose one long session was audited to shape HolyAgent's decisions.
- [Billion Context](https://github.com/ranxianglei/billion-context) and its [acp-kernel](https://github.com/ranxianglei/acp-kernel), which HolyAgent installs to compress the conversation ([docs/attributions.md](docs/attributions.md)).
- [t3dotgg/tstack](https://github.com/t3dotgg/tstack), for the inspiration.
- Anthropic's [frontend-design](docs/attributions.md#vendored-skill) skill, embedded in the visual specialists.
- [Context7](https://context7.com), [Effect](https://effect.website), [Bun](https://bun.sh), [mise](https://mise.jdx.dev), [lefthook](https://lefthook.dev), [TOON](https://toonformat.dev) and [acorn](https://github.com/acornjs/acorn), the software HolyAgent builds with or installs.

The full list, with licenses, is in [docs/attributions.md](docs/attributions.md).

## License

HolyAgent is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
