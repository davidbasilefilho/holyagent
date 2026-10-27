# HolyAgent

HolyAgent turns your coding agent into a root that plans work as Intents and Assignments and delegates it to eighteen specialists. A small CLI keeps the state, commits as the account owner and keeps the prompt cache warm, so the model never has to reason about any of it.

You state what you want. The root writes it down as an Intent, splits it into bounded Assignments, dispatches each to the specialist that fits (implementation, review, validation, research, visual work and more), and accepts nothing without a check run on the current head. It speaks to you only for a decision, a blocker and the final report.

HolyAgent ships today as a Claude Code plugin. The shared runtime underneath is built so other harnesses can follow.

## How do I install it?

You need Claude Code 2.1.242 or later, [Bun](https://bun.sh), `git` and an authenticated `gh`. The full list is in [docs/requirements.md](docs/requirements.md). From a shell:

```sh
claude plugin marketplace add davidbasilefilho/holyagent
claude plugin marketplace add ranxianglei/billion-context
claude plugin install holyagent@holyagent
```

Inside Claude Code the same steps are `/plugin marketplace add davidbasilefilho/holyagent`, `/plugin marketplace add ranxianglei/billion-context` and `/plugin install holyagent@holyagent`. The plugin requires `billion-context` and `exa`, so add the Billion Context marketplace first, as above. Restart Claude Code afterwards.

This route installs only the plugins. To also set up Billion Context, ctx7 and the project settings in one go, run the public CLI from a checkout, after `bun install` there:

```sh
bun packages/cli/src/index.ts setup claude
```

Add `--dry-run` to see what it would change, and run `holyagent doctor` to check the result. On a clean WSL Ubuntu, `bash install/wsl-install.sh` prepares the whole environment first. The details, options and the other environments (T3 Code, the desktop app, claude.ai) are in [docs/usage.md](docs/usage.md).

## Why HolyAgent?

- **One agent that plans, many that do.** The root owns the relationship with you, the plan and the verdict. Specialists do the work in bounded Assignments, each with acceptance criteria and evidence, so a long request stays reviewable instead of drifting inside one huge context.
- **A warm cache, by design.** Prompts put stable material first, specialists are reused while their cache is alive, and the CLI embeds the timing so the model carries none of that reasoning. See [docs/cache-and-workflows.md](docs/cache-and-workflows.md).
- **State outside the conversation.** Intents and Assignments live in `.holyagent/`, so a resumed or compacted session picks up exactly where the work stands, through a small, bounded session-start hook ([docs/hooks.md](docs/hooks.md)).
- **Commits you own.** `holyagent vcs` commits and opens pull requests as the account owner, keeps agent attribution out of the text and refuses what looks like an agent identity ([docs/commit-authorship.md](docs/commit-authorship.md)).
- **Every rule has a reason.** The standing decisions and their evidence are written down in [docs/decisions.md](docs/decisions.md), and what the plugin installs and configures is explained in [docs/components.md](docs/components.md).

## Development

The contributing rules are in [.claude/CLAUDE.md](.claude/CLAUDE.md) and the pitfalls of this repository in [AGENTS.md](AGENTS.md). The layout, the tooling, the generated plugin and versioning are in [docs/development.md](docs/development.md).

```sh
bun install --frozen-lockfile
mise run build    # regenerate the Claude plugin after changing its sources
mise run verify   # type-check, lint, format check and tests
```

`mise.toml` is the source of commands, and the repository toolchain needs a canary Bun, which the `toolchain` task checks for you. Commits follow Conventional Commits.

## Special thanks

- [HolyClaude](docs/decisions.md), the predecessor plugin whose long sessions were audited to shape HolyAgent's decisions.
- [Billion Context](https://github.com/ranxianglei/billion-context) and its [acp-kernel](https://github.com/ranxianglei/acp-kernel), which HolyAgent installs to compress the conversation ([docs/attributions.md](docs/attributions.md)).
- [t3dotgg/tstack](https://github.com/t3dotgg/tstack), for the inspiration.
- Anthropic's [frontend-design](docs/attributions.md#vendored-skill) skill, embedded in the visual specialists.
- [Context7](https://context7.com), [Effect](https://effect.website), [Bun](https://bun.sh), [mise](https://mise.jdx.dev), [lefthook](https://lefthook.dev), [TOON](https://toonformat.dev) and [acorn](https://github.com/acornjs/acorn), the software HolyAgent is built with.

The full list, with licenses, is in [docs/attributions.md](docs/attributions.md).

## License

HolyAgent is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
