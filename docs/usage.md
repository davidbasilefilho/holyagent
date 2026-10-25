# Usage

## Install

Check [requirements.md](requirements.md) first. Pick one route.

**Marketplace.** The plugin is published from this repository's `main` branch. From a shell:

```sh
claude plugin marketplace add davidbasilefilho/holyagent
claude plugin marketplace add ranxianglei/billion-context
claude plugin install holyagent@holyagent
```

Inside Claude Code the same steps are `/plugin marketplace add davidbasilefilho/holyagent`, `/plugin marketplace add ranxianglei/billion-context` and `/plugin install holyagent@holyagent`. The plugin declares two dependencies, so the install pulls them in: Billion Context's Claude Code plugin (`billion-context@billion-context`) and Exa's (`exa@claude-plugins-official`, from the official marketplace, which Claude Code adds by default). Claude Code resolves a dependency only from a marketplace that is already added. Exa's MCP server gives the Search specialists their web tools; it works without an account under a rate limit, and signing in to Exa raises the limit. The claude.ai Exa connector works in its place, since the specialists' tool lists name both. That plugin carries only the `/billion-context:bili-setup` command, which installs nothing by itself; run it, or `holyagent setup claude`, to set up Billion Context. This route installs only the plugins. The plugin's own `settings.json` makes the main thread the root agent (`agent: holyagent`) while the plugin is enabled.

**`holyagent setup claude`.** The public CLI adds both marketplaces and installs the plugin the same way, then Billion Context and ctx7, then configures the project you run it in (see [Set up a project](#set-up-a-project)). Use it when you also want the project settings and the two tools; it is the only route that writes them.

```sh
holyagent setup claude [--dir <path>] [--subagent-cache-ttl 1h|5m] [--dry-run] [--skip-billion-context] [--skip-ctx7]
```

The steps run in this order: plugin, Billion Context, ctx7, project settings. Every step checks its own result first, so a re-run changes nothing that is already set, and a failed step does not stop the others; the command exits 1 at the end if any step failed. `--dry-run` shows what would change and installs and writes nothing. `setup` is the parent command for per-harness setups; `claude` is the only one so far.

The output has one line per step: `+` done now, `=` already done, `-` skipped, `~` a hint (such as a directory to add to `PATH`), `!` failed (exit 1). The ctx7 skill needs `CONTEXT7_API_KEY` or a saved `ctx7 login`; without either that step is skipped with a hint. What each piece is and why it is installed is in [components.md](components.md).

**A clean WSL Ubuntu.** From a checkout, run `bash install/wsl-install.sh` as your own user, not through sudo; it takes no arguments and calls sudo itself only for missing apt packages (`curl`, `git`, `ca-certificates`, `unzip`, `build-essential`). Its eight steps run in this order, and a re-run skips what is already right: prerequisites, mise, Node LTS, Bun (canary), Claude Code, Billion Context, ctx7 and a final verification. It warns, and continues, on a system that is not WSL or not Ubuntu. It does not install the plugin; use one of the routes above afterwards. Open a new shell when it finishes so `PATH` picks up mise and Bun. The script's header lists what you opt into: Billion Context's local proxy, auto-compact off and npm auto-update; the Context7 skill download; the Bun canary; and two lines added to `~/.bashrc`.

**This repository.** `.claude/settings.json` already declares the checkout as the `holyagent` marketplace (a `directory` source with the relative path `.`, whose `.claude-plugin/marketplace.json` points at `packages/integrations/claude/dist`), declares the `billion-context` marketplace and enables `holyagent@holyagent`, so a session started here runs the root from the local build. Trusting the folder in an interactive session registers the declared marketplaces. From a shell on a new machine, register them in your user settings instead (`marketplace add ./` run without `--scope user` would write an absolute path into the project settings), then install the plugin for the project: `claude plugin marketplace add ./ --scope user`, `claude plugin marketplace add ranxianglei/billion-context --scope user`, `claude plugin marketplace add anthropics/claude-plugins-official --scope user` (only when `exa` cannot resolve, since Claude Code normally has it) and `claude plugin install holyagent@holyagent --scope project`. In WSL, after the checkout was opened and trusted, Claude Code recorded a project-scope install for the plugin in `installed_plugins.json`, and for its dependencies with `auto` true.

**Updates here.** A directory marketplace is read from its source folder at the start of every session: `claude plugin list` prints `Read from <source>` for it, and the session loads the plugin from that folder. After `mise run build` changes the plugin, start a new session or run `/reload-plugins`; no `plugin update` or `marketplace update` command is needed. The cache copy and the record in `installed_plugins.json` go stale and do not matter, because `claude plugin update` rewrites the cache only when the version changes, or refreshes it in place when the plugin declares no version.

**The Claude desktop app lists a second copy.** The desktop app reads plugins from its own account store (`AppData/Roaming/Claude/rpm` on Windows), which never shows the WSL project install (the desktop Plugins screen showed "This project: 0" as seen in the desktop app). There `holyagent` appears as a user-added marketplace plugin, a full copy with the same 0.1.1-2 label, kept as a separate record, so the desktop list says nothing about what a Code-tab session on this checkout loads. To remove the duplicate, uninstall the plugin or remove the user-added `holyagent` marketplace in the desktop app under Settings > Plugins; the project install keeps working.

Restart Claude Code after installing so the plugin and Billion Context's native mode load. `holyagent doctor [--fix]` checks the result (see [components.md](components.md)).

## Set up a project

`holyagent setup claude` does this as its last step. Run it once per project, from its root, or pass `--dir <path>`. A plugin can only set `agent` and `subagentStatusLine`, so the rest of the project settings are this command's job. It adds the missing keys to `.claude/settings.json` and never changes a value that is already set (`+` added, `=` already that value, `~` kept, with the recommendation shown).

| Key                                      | Value                                | Why                                                                                                    |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `attribution.commit`, `attribution.pr`   | `""`                                 | No attribution trailer or PR line; see [commit-authorship.md](commit-authorship.md)                    |
| `attribution.sessionUrl`                 | `false`                              | No claude.ai session link in commits                                                                   |
| `includeGitInstructions`                 | `false`                              | Removes Claude Code's built-in commit and PR instructions and the git status snapshot from the context |
| `subagentPromptCacheTtl`                 | `1h` (or the flag)                   | Specialists stay warm for the reuse window; see [cache-and-workflows.md](cache-and-workflows.md)       |
| `extraKnownMarketplaces.holyagent`       | GitHub `davidbasilefilho/holyagent`  | Offers the marketplace to teammates                                                                    |
| `extraKnownMarketplaces.billion-context` | GitHub `ranxianglei/billion-context` | Offers the marketplace of the plugin's Billion Context dependency                                      |
| `enabledPlugins["holyagent@holyagent"]`  | `true`                               | Turns the plugin on for the project                                                                    |
| `permissions.deny`                       | `["WebSearch", "WebFetch"]`          | Turns off Claude Code's own web tools, so web work goes through Exa; an existing list is kept          |

`attribution` is written as an object (`commit`, `pr`, `sessionUrl`), the form earlier Claude Code versions also read; the shorter `attribution: false` needs 2.1.281 or later.

The project state lives in `.holyagent/` at the git top level, created by the first `intent create`. It is versioned with the project and travels in the same commits as the work (see [decisions.md](decisions.md)); everything under `.holyagent/local/` is per clone and ignored by git. `.holyagent/config.json` holds optional project settings (`vcs.allowWords`; an old `vcs.api` is still read and ignored).

## How a session works

The root agent (Opus, the main thread) owns the conversation, decisions, acceptance and version control. Everything else goes to specialists: explorers, librarians, workers and reviewers, each pinned by the CLI to a model and effort. The root calls the runtime CLI through the plugin wrapper, which is not on your `PATH`. The read-only commands are safe to run by hand: `status`, `plan`, `reconcile`, `intent show|list`, `assignment show|list`. Its rules for asking, assignments, stacks, CI and resuming are in its prompt, and the details of each command are in `holyagent help [command]`; the plugin has only two skills of its own, `dev-server` (the root starts one dev server the visual specialists share) and `user-busy`. The mergeability rubric, the interface inspection rules and Anthropic's `frontend-design` guidance are fixed text in the specialists that need them.

1. **Intent.** The root records one objective and its requirements (`intent create`). Your constraints go in verbatim as binding requirements, and every Assignment carries them as criteria.
2. **Assignments.** Each unit of work is an Assignment: objective, scope, constraints, ownership paths for writers, criteria marked blocking or non-blocking across six dimensions (behavior, regressions, tests, scope, style, repo-standards) and evidence labels.
3. **Three calls per Assignment.**
   1. `assignment dispatch` takes the draft and prints which agent, model and effort to spawn (or which warm agent to continue) and then the specialist prompt.
   2. The root runs it as an `agent()` of an inline workflow script it writes, a single Assignment as a one-entry workflow. After the run's notice it records each entry with `assignment record <id> --agent workflow:<run-id>/<id>` ([cache-and-workflows.md](cache-and-workflows.md)). Only when the `Workflow` tool is disabled or unavailable does it launch the specialist in the background as printed; a hook then records an agent started through the `Agent` tool ([hooks.md](hooks.md)). A continued agent (`SendMessage`) is recorded by hand with `assignment record <id> --agent <agentId>`, and `--failed` marks a launch that failed.
   3. When the specialist's report arrives, `assignment close <id> --outcome <o>` with the report on stdin, verbatim; `--accept "<rationale>"` accepts it when the report's `evidence:` block supports every blocking criterion and required label.
4. **Several Assignments.** The root creates them with `assignment create`, runs `plan` and runs what it names as an inline workflow script it writes on the spot. Work that continues a warm specialist goes by `SendMessage` beside it. Workflows run all new work, and choosing the holyagent agent is your opt-in to the `Workflow` tool; `plan` prints direct subagents as a fallback for a session where the tool is disabled or unavailable. See [cache-and-workflows.md](cache-and-workflows.md).
5. **Commit, review, push.** The order is a local commit of the writer's work, an independent review of that commit, repairs as new local commits, a re-review, one validation of the final head, and the push once the reviews accept. Reviewer.code starts with Claude Code's built-in `/code-review` and Reviewer.security with `/security-review`, both on the committed range (the other reviewers have no built-in); Reviewer.security runs before the push when the change touches a trust boundary. Only blocking findings start a repair. `holyagent vcs commit` commits the accepted paths with the Intent state and the user's git identity, after the message check; branches, pushes, merges and CI are plain Git and `gh` (a force push is denied by the hook), and `holyagent vcs pr` opens the PR; see [commit-authorship.md](commit-authorship.md).

The root keeps everything in a task list for the whole request (TaskCreate, TaskUpdate, TaskList, TaskGet): every PR, task, step, dispatch, wait, verdict and repair, none of which it mentions in a message. It writes to you only for a decision, a blocker only you can clear and the final report, apart from a brief acknowledgment of each message of yours. A decision always goes through `AskUserQuestion` with options and a recommended default, and only when it materially changes the result and neither the repository nor your words settle it. Hook feedback is handled silently. The root runs no gates itself (a specialist does), judges delegated work from the diff and the check output, and accepts nothing without a check run on the current head. It never polls: the completion notices of the specialists are its only wake-ups, and a new message from you leaves running specialists alone. A specialist interrupted by accident is resumed with `SendMessage`, never launched again.

**Stacks.** One branch and one PR per reviewable change. A change that adds CI gets its PR first, from the base, so every later PR runs it. Every PR of one delivery stacks in work order by default, each reviewed and merged on top of the one before it; the repository's own conventions come first, and where they ask for independent PRs each branches from the base. Work outside the delivery branches from the base, and parallel writers get disjoint paths. A PR is opened or updated in the same step as every push, so nothing stays only local.

**Long mechanical work.** Hundreds of calls, such as paging or exporting, are split into batches across fresh specialists, each saving its results to a named file outside the scratchpad and `.holyagent/`, which the root reads.

**Resume.** After a resume or compaction the root runs `status` (open Intents, Running Assignments, Succeeded ones not yet accepted) and `reconcile` (Running Assignments with their agent ids), then closes as `interrupted` a Running Assignment only once its agent is confirmed gone (by `SendMessage` or the transcript; an exited parent session proves nothing), and otherwise leaves it Running. The session-start hook adds a capped open-work status as context, and after a resume or compaction the `reconcile` result of the Running Assignments too ([hooks.md](hooks.md)).

## claude.ai

The plugin has no `bin/` folder (its executable is `scripts/holyagent`), because claude.ai and Cowork do not install a plugin that has one. Anthropic's [plugin platform support](https://claude.com/docs/plugins/platform-support) table says that in Chat (claude.ai) agents, hooks, local MCP servers and settings are ignored, commands load as skills, and a top-level `bin/` makes the surface refuse the whole plugin (Cowork refuses it too). The [skills documentation](https://code.claude.com/docs/en/skills.md) lists the frontmatter keys claude.ai skill uploads accept: `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`; HolyAgent's skills use `name` and `description`, plus `license` for the vendored one. So the plugin's skills load, but there is no root agent, no runtime CLI calls and no hooks. For the full workflow use Claude Code.

Cloud sessions (claude.ai/code) are a different case: plugins installed on your account are synced into them, but Billion Context does not run there. The host manages the model provider (`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`), so Claude Code ignores an `ANTHROPIC_BASE_URL` from any settings file and the proxy is never in the path; the plugin dependency installs but changes nothing there, and commits follow the cloud rules in [commit-authorship.md](commit-authorship.md).

## T3 Code

T3 Code drives Claude Code through the Claude Agent SDK. From its source (read 2026-10-24; it is early software and changes):

- It loads the user, project and local settings like the CLI, so the plugin, the project settings from `holyagent setup claude` and Billion Context's `~/.claude/settings.json` entries apply, unless a provider instance sets a custom `CLAUDE_CONFIG_DIR`. A provider instance can also set `ANTHROPIC_BASE_URL`; which of the two wins was not checked, and an instance that points elsewhere bypasses Billion Context.
- It appends to Claude Code's system prompt rather than replacing it.
- It exposes tools under `mcp__t3-code__`: `html_render` and `html_preview` for visual replies, `preview_*` for the integrated browser and `device_*` for simulators. The root takes `html_render`, `html_preview` and `watch_pull_request`; the visual specialists take the browser and device tools named in their interface inspection rules. Tool names differ across T3 versions.
- Its "Auto-compact after" setting maps to Claude Code's `autoCompactWindow`, which HolyAgent leaves alone (see [decisions.md](decisions.md)).
