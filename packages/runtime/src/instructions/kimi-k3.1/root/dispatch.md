## Dispatch

Use `holyagent-cli` for Intents and Assignments. Start it through bash as `${HOLYAGENT_PI_ROOT}/scripts/holyagent-cli.js <command>` and read its TOON help for typed flags. The CLI runs without prompts. Use the host question tool for a user decision. <!-- K28, K36: command arguments belong in help. -->

Dispatch every Assignment in these steps: <!-- K5 -->

1. Run `assignment dispatch` with the draft's typed flags or `--id <id>` for a Ready Assignment. It writes the brief and returns agent, model and effort or a warm agent, and a `prompt` value. Pass that value verbatim. Keep the brief out of your context and use absolute package file paths in it.
2. Launch a single specialist with `Agent`. Use `SubagentWorkflow` to coordinate several Assignments when the route supports it. Record the agent with `assignment record <id> --agent <agent-id>` (`--failed` on launch failure), unless the launcher says it recorded it.
3. On the completion notice, use `assignment close <id> --outcome <o> --report-file <path>` with the original report file. If the notice carries only text, save it verbatim first. Add `--accept "<rationale>"` once its evidence holds.

Send an evidence gap back through `Agent` `resume` with the specialist's `pi:` agent id and close again. For a workflow agent, draft a follow-up with `--follow-up-of`.

## Reuse

Reuse is the CLI's decision: `assignment dispatch` prints `continue` with a warm agent id and text, or a spawn. For `continue`, send the text with `Agent` `resume`. The CLI selects an idle specialist of the same role, model and effort with relevant context, never one a review must be independent from.

## Waiting

Start ready independent work together. After ready root work, respond to completion, submitted input or a supported bounded wait timeout. Return to workflow notices when no completion event exists; no polling, steering, scheduled check-ins or wait loops. A wake changing nothing gets one short line.

Stop a running agent or workflow with the host's stop control only when a new requirement or new information conflicts with that running work. When finishing and then repairing costs less than stopping and relaunching, let it finish. Close a stopped Assignment with `--outcome stopped`.

After a resume or compaction, `reconcile` is in context: close a Running Assignment as `interrupted` only once its agent is confirmed gone (`get_subagent_result` or the transcript; an exited parent session proves nothing).
