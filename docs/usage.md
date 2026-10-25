# Usage

## Install

Check [requirements.md](requirements.md) first. Pick one route.

**Marketplace.** In Claude Code:

```text
/plugin marketplace add davidbasilefilho/holyagent
/plugin install holyagent@holyagent
```

This installs only the plugin. The plugin's own `settings.json` makes the main thread the root agent (`agent: holyagent`) while the plugin is enabled.

**`holyagent install`.** The public CLI installs the plugin through `claude plugin marketplace add` and `claude plugin install`, then Billion Context and ctx7. Every step checks its own result first and a failed step does not stop the others.

```sh
holyagent install [--skip-billion-context] [--skip-ctx7]
```

The output has one line per step: `+` done now, `=` already done, `-` skipped, `~` a hint (such as a directory to add to `PATH`), `!` failed (exit 1). The ctx7 skill needs `CONTEXT7_API_KEY` or a saved `ctx7 login`; without either that step is skipped with a hint. What each piece is and why it is installed is in [components.md](components.md).

**A clean WSL Ubuntu.** From a checkout, run `bash install/wsl-install.sh` as your own user, not through sudo; it takes no arguments and calls sudo itself only for missing apt packages (`curl`, `git`, `ca-certificates`, `unzip`, `build-essential`). Its eight steps run in this order, and a re-run skips what is already right: prerequisites, mise, Node LTS, Bun (canary), Claude Code, Billion Context, ctx7 and a final verification. It warns, and continues, on a system that is not WSL or not Ubuntu. It does not install the plugin; use one of the routes above afterwards. Open a new shell when it finishes so `PATH` picks up mise and Bun. The script's header lists what you opt into: Billion Context's local proxy, auto-compact off and npm auto-update; the Context7 skill download; the Bun canary; and two lines added to `~/.bashrc`.

Restart Claude Code after installing so the plugin and Billion Context's native mode load. `holyagent doctor [--fix]` checks the result (see [components.md](components.md)).

## Set up a project

Run once per project, from its root:

```sh
holyagent setup [--dir <path>] [--subagent-cache-ttl 1h|5m] [--dry-run]
```

A plugin can only set `agent` and `subagentStatusLine`, so the rest of the project settings are this command's job. It adds the missing keys to `.claude/settings.json` and never changes a value that is already set (`+` added, `=` already that value, `~` kept, with the recommendation shown).

| Key                                     | Value                               | Why                                                                                                    |
| --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `attribution.commit`, `attribution.pr`  | `""`                                | No attribution trailer or PR line; see [commit-authorship.md](commit-authorship.md)                    |
| `attribution.sessionUrl`                | `false`                             | No claude.ai session link in commits                                                                   |
| `includeGitInstructions`                | `false`                             | Removes Claude Code's built-in commit and PR instructions and the git status snapshot from the context |
| `subagentPromptCacheTtl`                | `1h` (or the flag)                  | Specialists stay warm for the reuse window; see [cache-and-workflows.md](cache-and-workflows.md)       |
| `extraKnownMarketplaces.holyagent`      | GitHub `davidbasilefilho/holyagent` | Offers the marketplace to teammates                                                                    |
| `enabledPlugins["holyagent@holyagent"]` | `true`                              | Turns the plugin on for the project                                                                    |

`attribution` is written as an object (`commit`, `pr`, `sessionUrl`), the form earlier Claude Code versions also read; the shorter `attribution: false` needs 2.1.281 or later.

The project state lives in `.holyagent/` at the git top level, created by the first `intent create`. It is versioned with the project and travels in the same commits as the work (see [decisions.md](decisions.md)); everything under `.holyagent/local/` is per clone and ignored by git. `.holyagent/config.json` holds optional project settings (`vcs.api`, `vcs.allowWords`).

## How a session works

The root agent (Opus, the main thread) owns the conversation, decisions, acceptance and version control. Everything else goes to specialists: explorers, librarians, workers and reviewers, each pinned by the CLI to a model and effort. The root calls the runtime CLI through the plugin wrapper, which is not on your `PATH`. The read-only commands are safe to run by hand: `status`, `plan`, `reconcile`, `intent show|list`, `assignment show|list`. Its rules for asking, assignments, stacks, CI and resuming are in its prompt, and the details of each command are in `holyagent help [command]`; the plugin has only two skills of its own, `merge-ready` and `interface-inspection`, plus the vendored `frontend-design`.

1. **Intent.** The root records one objective and its requirements (`intent create`). Your constraints go in verbatim as binding requirements, and every Assignment carries them as criteria.
2. **Assignments.** Each unit of work is an Assignment: objective, scope, constraints, ownership paths for writers, criteria marked blocking or non-blocking across six dimensions (behavior, regressions, tests, scope, style, repo-standards) and evidence labels.
3. **Three calls per Assignment.**
   1. `assignment dispatch` takes the draft and prints which agent, model and effort to spawn (or which warm agent to continue) and then the specialist prompt.
   2. The root runs it as a workflow entry, a single Assignment as a one-entry workflow. After the run's notice it records each entry with `assignment record <id> --agent workflow:<run-id>/<id>` ([cache-and-workflows.md](cache-and-workflows.md)). Only when the `Workflow` tool is disabled or unavailable does it launch the specialist in the background as printed; a hook then records an agent started through the `Agent` tool ([hooks.md](hooks.md)). A continued agent (`SendMessage`) is recorded by hand with `assignment record <id> --agent <agentId>`, and `--failed` marks a launch that failed.
   3. When the specialist's report arrives, `assignment close <id> --outcome <o>` with the report on stdin; `--accept "<rationale>"` accepts it when the report's `evidence:` block supports every blocking criterion and required label.
4. **Several Assignments.** The root creates them with `assignment create`, runs `plan` and runs what it names: a prebuilt workflow, or a custom script when none fits. Work that continues a warm specialist goes by `SendMessage` beside it. Workflows run all new work, and choosing the holyagent agent is your opt-in to the `Workflow` tool; `plan` prints direct subagents as a fallback for a session where the tool is disabled or unavailable. See [cache-and-workflows.md](cache-and-workflows.md).
5. **Commit, review, push.** The order is a local commit of the writer's work, an independent review of that commit, repairs as new local commits, a re-review, one validation of the final head, and the push once the reviews accept. Reviewer.code starts with Claude Code's built-in `/code-review` and Reviewer.security with `/security-review`, both on the committed range (the other reviewers have no built-in); Reviewer.security runs before the push when the change touches a trust boundary. Only blocking findings start a repair. `holyagent vcs commit` commits the accepted paths with the Intent state as the account owner; see [commit-authorship.md](commit-authorship.md).

The root keeps everything in a task list for the whole request (TaskCreate, TaskUpdate, TaskList, TaskGet): every PR, task, step, dispatch, wait, verdict and repair, none of which it mentions in a message. It writes to you only for a decision, a blocker only you can clear and the final report. A decision always goes through `AskUserQuestion` with options and a recommended default, and only when it materially changes the result and neither the repository nor your words settle it. Hook feedback is handled silently. The root runs no gates itself (a specialist does), judges delegated work from the diff and the check output, and accepts nothing without a check run on the current head. It never polls: the completion notices of the specialists are its only wake-ups, and a new message from you leaves running specialists alone. A specialist interrupted by accident is resumed with `SendMessage`, never launched again.

**Stacks.** One branch and one PR per reviewable change. A change that adds CI gets its PR first, from the base, so every later PR runs it. A PR stacks on another only on a real code dependency, and parallel writers get disjoint paths. A PR is opened or updated in the same step as every push, so nothing stays only local.

**Long mechanical work.** Hundreds of calls, such as paging or exporting, are split into batches across fresh specialists, each saving its results to a named file outside the scratchpad and `.holyagent/`, which the root reads.

**Resume.** After a resume or compaction the root runs `status` (open Intents, Running Assignments, Succeeded ones not yet accepted) and `reconcile` (Running Assignments with their agent ids), then closes as `interrupted` a Running Assignment only once its agent is confirmed gone (by `SendMessage` or the transcript; an exited parent session proves nothing), and otherwise leaves it Running. The session-start hook adds a capped open-work status as context, and after a resume or compaction the `reconcile` result of the Running Assignments too ([hooks.md](hooks.md)).

## claude.ai

The plugin has no `bin/` folder (its executable is `scripts/holyagent`), because claude.ai and Cowork do not install a plugin that has one. Anthropic's [plugin platform support](https://claude.com/docs/plugins/platform-support) table says that in Chat (claude.ai) agents, hooks, local MCP servers and settings are ignored, commands load as skills, and a top-level `bin/` makes the surface refuse the whole plugin (Cowork refuses it too). The [skills documentation](https://code.claude.com/docs/en/skills.md) lists the frontmatter keys claude.ai skill uploads accept: `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`; HolyAgent's skills use `name` and `description`, plus `license` for the vendored one. So the plugin's skills load, but there is no root agent, no runtime CLI calls and no hooks. For the full workflow use Claude Code.

Cloud sessions (claude.ai/code) are a different case: Claude Code does not load plugins you installed on your machine or ones your repository's `.claude/settings.json` enables there. Billion Context does not run in them either, and commits follow the cloud rules in [commit-authorship.md](commit-authorship.md).

## T3 Code

T3 Code drives Claude Code through the Claude Agent SDK. From its source (read 2026-10-24; it is early software and changes):

- It loads the user, project and local settings like the CLI, so the plugin, the project settings from `holyagent setup` and Billion Context's `~/.claude/settings.json` entries apply, unless a provider instance sets a custom `CLAUDE_CONFIG_DIR`. A provider instance can also set `ANTHROPIC_BASE_URL`; which of the two wins was not checked, and an instance that points elsewhere bypasses Billion Context.
- It appends to Claude Code's system prompt rather than replacing it.
- It exposes tools under `mcp__t3-code__`: `html_render` and `html_preview` for visual replies, `preview_*` for the integrated browser and `device_*` for simulators. The root takes `html_render`, `html_preview` and `watch_pull_request`; the visual specialists take the browser and device tools named in the `interface-inspection` skill. Tool names differ across T3 versions.
- Its "Auto-compact after" setting maps to Claude Code's `autoCompactWindow`, which HolyAgent leaves alone (see [decisions.md](decisions.md)).
