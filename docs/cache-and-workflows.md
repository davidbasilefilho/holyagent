# Cache and workflows

The model never reasons about the prompt cache, its lifetime or cost. The design carries that knowledge, so prompts contain no cache or TTL talk to follow, misread or report on. This page lists the mechanisms and then how the root runs workflows.

## Mechanisms

**Static first.** Every prompt puts stable material before task specifics. The agent files, skills and instruction text hold no dates, counters or state. The specialist prompt that `assignment dispatch` prints has a fixed order (role line, objective, scope, constraints, ownership paths, criteria, required evidence, closing instruction). Changing the system prompt, the tools or the roster mid-session would invalidate the prompt cache, so such changes ship only as versioned releases. The audit of the predecessor found this layout cost nothing: no tool, agent or skill changes across 402 session starts.

**Warm reuse is the CLI's decision.** `assignment dispatch` prints either a spawn (`agent`, `model`, `effort`, `reason`) or `continue: <agentId>` with the same specialist prompt to send. The root only obeys. The CLI continues a specialist when it passes every stage, in order:

1. it is idle and has the same role task;
2. it has the same model and effort, so its prompt prefix is identical;
3. it finished inside the reuse window, 55 minutes by default, set by `HOLYAGENT_REUSE_TTL_MINUTES` (a number of minutes; anything else is a usage error). The window sits under the one-hour cache that `subagentPromptCacheTtl: "1h"` selects;
4. it is independent of the work the Assignment must be independent from;
5. its context is relevant: the Assignment is a follow-up of one it did, their ownership paths overlap, or they share related Assignments.

The strongest relevance wins, then the most recently finished. If a stage empties the pool the CLI spawns and the `reason` names the stage (`no idle specialist of this role task`). A reviewer, or any Assignment that names `independentFrom`, never continues a specialist that worked on or reviewed those Assignments, so a reviewer is never the writer or an earlier reviewer of the change. The registry of launched specialists is per clone, in `.holyagent/local/specialists.json`.

**Cache lifetimes.** `holyagent setup` writes `subagentPromptCacheTtl: "1h"` into your user settings (Claude Code 2.1.242 or later), which covers subagents, workflows and Claude Code's own helper requests. Each generated specialist file also sets `experimental.cacheTtl: 1h`.

**Compact outputs.** CLI output is TOON, `status`, `show` and `list` print one row per record, specialists end with a fixed compact report (`result`, `changed`, `checks`, `blockers`, `questions`, `notes`, then an `evidence:` block) and long logs go to files outside the repository. The root's large prefix therefore grows slowly and stays warm.

## Workflows

A workflow runs one or more Assignments in one call. The plugin ships no workflow script: the point of a workflow is a script composed for the work at hand, so the root writes each one on the spot, inline, as the `script` of the `Workflow` call. `plan` reads the Ready Assignments and says how to run them: the Assignments to launch together, and for a writer with a review that names it in `independentFrom`, the writer and its review in turn. An `entry` is `{id, agent, model, effort, prompt}`, exactly what `assignment dispatch` printed.

The script is plain JavaScript with these parts:

- a literal `export const meta = { name, description }` first;
- one `agent(prompt, { agentType: "holyagent:<agent>", model, effort })` per Assignment, with the dispatched prompt, model and effort, identical within a phase so the prompt prefix is shared, and no `schema`, so the call returns the specialist's own report;
- `pipeline()` over the Assignments by default (no barrier between stages), `parallel()` only where a stage needs every earlier result, and a review stage after the writers it reviews;
- a returned object of the reports keyed by Assignment id.

Work that would continue a warm specialist stays out of the workflow, since a workflow's agents are new and cannot be messaged; the warm context is worth more.

An inline script whose every `agent()` call passes a string-literal `agentType` of a holyagent specialist runs without a permission prompt, through the `PreToolUse` hook ([hooks.md](hooks.md)). A script with any other agent type, a computed one, an `agent()` without one, `workflow()`, a `scriptPath`, a `name` or a resume goes through the normal permission flow.

**Opt-in and fallback.** Workflows run all new work, in parallel or in sequence, and a single Assignment runs as a one-entry workflow. Choosing the holyagent agent is your opt-in to the `Workflow` tool, so the root asks for nothing more. `plan` prints, next to a workflow recommendation, a **fallback**: the same Assignments as direct subagents, for a session where the tool is disabled or unavailable. Its writers launch together, and its `afterwards` entries (the reviews of those writers) launch once the writers they depend on are terminal. The contract is the same either way. A workflow is recommended in preference to direct subagents even for one Assignment; `plan` recommends none at all when the host has workflows off (`CLAUDE_CODE_DISABLE_WORKFLOWS=1`, or `disableWorkflows: true` or `enableWorkflows: false` in `~/.claude/settings.json`, `.claude/settings.json` or `.claude/settings.local.json`).

**Warm specialists beside a workflow.** Ready work that continues a warm specialist is listed under `continues` and goes by `SendMessage` beside the workflow, taking the reuse as printed. When only such work is ready, `plan` recommends the continuation itself.

**Recording and closing.** The run ends with a notice carrying the returned value, and the tool result has the run id. For each entry:

```text
assignment record <id> --agent workflow:<run-id>/<id>
assignment close <id> --outcome <o> [--accept "<rationale>"]   # the entry's report on stdin, verbatim
```

The agent id must have exactly that form, naming its own Assignment. The root passes each report to `assignment close` exactly as the specialist returned it and never retypes or summarizes it, since the CLI stores and checks that text. A null report means the agent died: close it `errored`. Workflow agents (`workflow:` ids) are never continued; a gap in their report is a new draft with `followUpOf`.
