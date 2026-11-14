## Dispatch

`holyagent <command>` is `${HOLYAGENT_PI_ROOT}/scripts/holyagent <command>`, run through bash, the only interface to Intents and Assignments (`holyagent help [command]`). The extension fills `${HOLYAGENT_PI_ROOT}` with the installed package path in prompts; skills and briefs hold no placeholder. <!-- K28, K36: command arguments are read from the CLI help, not restated here. -->

Dispatch every Assignment in these steps: <!-- K5 -->

1. `assignment dispatch` with `--input '<json>'` (or stdin) writes the brief and prints agent, model, effort or warm agent, and a two-line prompt. Use it as printed; never open or re-emit the brief. Name package files in briefs by literal absolute path under the package folder above `scripts/`.
2. Run the prompt as an `agent()` in your inline `SubagentWorkflow` script (one Assignment is a one-entry workflow); without that tool, launch it with the `Agent` tool in the background. The launcher records an `Agent` launch of a dispatched Assignment and says so in its tool result. Otherwise, for a continued agent and for a workflow's agents, run `assignment record <id> --agent <agent-id>` right after the launch (`--failed` when the launch failed): `pi:<agent-id>` for an `Agent` launch, with the id the tool returns, and `pi-workflow:<run-id>/<id>` for a workflow's agent, with the run id the tool returns.
3. On its completion notice, `assignment close <id> --outcome <o>` passes the report verbatim on stdin, never retyped or summarized; add `--accept "<rationale>"` once its evidence holds.

Send an evidence gap back to the same specialist through the `Agent` tool's `resume` (its `pi:` agent id), then close again; a workflow agent cannot be resumed, so its gap is a new draft with `followUpOf`.

## Reuse

Reuse is the CLI's decision: `assignment dispatch` prints `continue` with a warm agent id and text, or a spawn. For `continue`, send the text with `Agent` `resume`. The CLI selects an idle specialist of the same role, model and effort with relevant context inside the cache window, never one a review must be independent from.

## Waiting

Start ready independent work together. After ready root work, respond to completion, submitted input or a supported bounded wait timeout. Return to workflow notices when no completion event exists; no polling, steering, scheduled check-ins or wait loops. A wake changing nothing gets one short line.

Stop a running agent or workflow with the host's stop control only when a new requirement or new information conflicts with that running work. When finishing and then repairing costs less than stopping and relaunching, let it finish. Close a stopped Assignment with `--outcome stopped`.

After a resume or compaction, `reconcile` is in context: close a Running Assignment as `interrupted` only once its agent is confirmed gone (`get_subagent_result` or the transcript; an exited parent session proves nothing).
