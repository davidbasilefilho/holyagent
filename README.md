# HolyAgent

HolyAgent turns your coding agent into a root that plans work as Intents and Assignments and delegates it to eighteen specialists. A small CLI keeps the state, commits as the account owner and keeps the prompt cache warm, so the model never has to reason about any of it.

You state what you want. The root writes it down as an Intent, splits it into bounded Assignments, dispatches each to the specialist that fits (implementation, review, validation, research, visual work and more), and accepts nothing without a check run on the current head. It speaks to you only for a decision, a blocker and the final report, apart from a brief acknowledgment of each of your messages.

HolyAgent ships as a Claude Code plugin and as a [Pi package](docs/usage.md#pi), which you use first in T3 Code. The shared runtime underneath is built so other harnesses can follow.

## How do I install it?

You need Claude Code at or above the minimum in [docs/requirements.md](docs/requirements.md#claude-code-version), [Bun](https://bun.sh) on your `PATH` (the plugin's hooks run it), Node.js LTS (22.13 or later, 22.19 or later on Windows; the optional Pi integration needs 22.19 or later on every OS, see [docs/pi/installation.md](docs/pi/installation.md)), `git`, an authenticated `gh`, and [ripgrep](https://github.com/BurntSushi/ripgrep) and [fd](https://github.com/sharkdp/fd), which `holyagent rg` and `holyagent fd` run (for example `brew install ripgrep fd`, or `sudo apt install ripgrep fd-find`; the other platforms are in [docs/components.md](docs/components.md#ripgrep-and-fd)). On a clean WSL Ubuntu or native Windows machine, `install/wsl-install.sh` and `install/windows-install.ps1` install everything except Claude Code, ripgrep and fd, and install mise only when you pass `--dev` or `-Dev` ([docs/usage.md](docs/usage.md#install)). The full list is in [docs/requirements.md](docs/requirements.md). Then, from a shell:

```sh
claude plugin marketplace add davidbasilefilho/holyagent
claude plugin install holyagent@holyagent
```

Restart Claude Code afterwards. The root runs on Opus; [docs/usage.md](docs/usage.md#run-the-root-on-sonnet) shows how to run it on Sonnet instead. Web search needs the Exa connector, which you connect once at [claude.ai/customize/connectors](https://claude.ai/customize/connectors) (see [docs/components.md](docs/components.md#exa)); HolyAgent supports only claude.ai account login. On the first launch, run `/holyagent:setup` once to install ctx7 and to configure Claude Code. The same steps as slash commands, the details and `holyagent doctor` are in [docs/usage.md](docs/usage.md#install), and the status of the other environments (T3 Code, claude.ai) is in [docs/requirements.md](docs/requirements.md#supported-environments).

Those commands install for your user; project and local scope, which a team can share, are in [docs/usage.md](docs/usage.md#install-scopes).

On Pi, [T3 Code](docs/pi/t3-code.md) is the primary interface and the plain `pi` terminal works too; the install, in both scopes, is in [docs/usage.md](docs/usage.md#pi). With T3 Code installed, `holyagent setup` shows a screen for the T3 settings it writes, with `--worktrees`, `--device-access` and `--no-tui` flags ([docs/usage.md](docs/usage.md#the-t3-code-setup-screen)).

## Why HolyAgent?

- **It fits the work you have.** From a one-line fix to a stacked multi-PR delivery, through bug hunts, codebase questions, reviews, refactors, UI work and solo or coursework repositories ([docs/usage.md](docs/usage.md#what-it-fits)).
- **One agent that plans, many that do.** The root owns the relationship with you, the plan and the verdict. Specialists do the work in bounded Assignments, each with acceptance criteria and evidence, so a long request stays reviewable instead of drifting inside one huge context.
- **A warm cache, by design.** Prompts put stable material first, specialists are reused while their cache is alive, and the CLI embeds the timing so the model carries none of that reasoning. See [docs/cache-and-workflows.md](docs/cache-and-workflows.md).
- **State outside the conversation.** Intents and Assignments live in `.holyagent/`, so a resumed or compacted session picks up exactly where the work stands, through a small, bounded session-start hook ([docs/hooks.md](docs/hooks.md)).
- **Commits you own.** `holyagent vcs` commits and opens pull requests as the account owner, keeps agent attribution out of the text and refuses the agent's own identity ([docs/commit-authorship.md](docs/commit-authorship.md)).
- **Opinionated on purpose.** It denies Claude Code's own web tools in favor of Exa, runs the root on Opus at high effort, compacts at 450000 tokens and turns off Claude Code's git instructions and attribution. Each choice has a stated reason and a way to change it, and installing the plugin and running `holyagent setup` at `--scope local` confines both to one repository while `--undo` backs the settings out ([docs/usage.md](docs/usage.md#opinionated-by-design)).
- **Every rule has a reason.** The standing decisions and their evidence are written down in [docs/decisions.md](docs/decisions.md), and what the plugin installs and configures is explained in [docs/components.md](docs/components.md).

## Development

The contributing rules and repository pitfalls are in [AGENTS.md](AGENTS.md). The layout, the tooling, the generated plugin and versioning are in [docs/development.md](docs/development.md).

```sh
bun install --frozen-lockfile   # install native mise first; see docs/development.md
bunx --no-install mise install
bunx --no-install mise run build    # regenerate the Claude plugin after changing its sources
bunx --no-install mise run verify   # type-check, lint, format check and tests
```

`mise.toml` is the source of commands, and the repository toolchain needs a canary Bun, which the `toolchain` task checks for you. Commits follow Conventional Commits.

## Special thanks

- [HolyClaude](docs/decisions.md), the predecessor plugin whose one long session was audited to shape HolyAgent's decisions.
- [t3dotgg/tstack](https://github.com/t3dotgg/tstack), for the inspiration.
- Anthropic's [frontend-design](docs/attributions.md#design-skill-sources) skill, an inspiration for the design skills.
- [Context7](https://context7.com), [Effect](https://effect.website), [Bun](https://bun.sh), [mise](https://mise.jdx.dev), [lefthook](https://lefthook.dev), [TOON](https://toonformat.dev), [acorn](https://github.com/acornjs/acorn), [ripgrep](https://github.com/BurntSushi/ripgrep) and [fd](https://github.com/sharkdp/fd), the software HolyAgent builds with or needs.

The full list, with licenses, is in [docs/attributions.md](docs/attributions.md).

## License

HolyAgent is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
