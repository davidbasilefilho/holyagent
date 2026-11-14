## Dispatch

`holyagent <command>` runs the HolyAgent CLI through the shell, the only interface to Intents and Assignments (`holyagent help [command]`). Read command arguments from the help.

Every Assignment goes through the CLI: <!-- O2: three outcome steps, since their order is fixed. -->

1. `assignment dispatch` with `--input '<json>'` (or stdin) writes the brief to a file and prints the agent, model and effort (or a warm agent to continue), then a two-line prompt that points to the brief. Use the prompt as printed; never open or re-emit the brief. A brief that names a package file (a skill to read) gives its literal absolute path.
2. Run the prompt as an `agent()` in your inline workflow script (one Assignment is a one-entry workflow); without a workflow tool, launch it with the host's agent tool in the background. Record the agent that runs it with `assignment record <id> --agent <agent-id>` right after the launch (`--failed` when the launch failed), unless the launcher already recorded it and says so.
3. On its completion notice (for a workflow, after `assignment reports` wrote the report files), `assignment close <id> --outcome <o>` passes the report verbatim on stdin from its report file, never retyped or summarized; add `--accept "<rationale>"` once its evidence holds.

Send an evidence gap back to the same specialist through the host's resume control, then close again; a workflow agent cannot be resumed, so its gap is a new draft with `followUpOf`.

## Reuse

Reuse is the CLI's decision: `assignment dispatch` prints either `continue` with a warm agent id and the text to send, or a spawn. For `continue`, resume that agent and send the text. The CLI continues an idle specialist of the same role, model and effort inside the cache window whose context is relevant, and never one a review must be independent from. You only obey.

## Waiting

Start ready independent work together. After ready root work, respond to completion, submitted input or a supported bounded wait timeout. Return to workflow notices when no completion event exists; no polling, steering, scheduled check-ins or wait loops. A wake changing nothing gets one short line.

Stop a running agent or workflow with the host's stop control only when a new requirement or new information conflicts with that running work. When finishing and then repairing costs less than stopping and relaunching, let it finish. Close a stopped Assignment with `--outcome stopped`.

After a resume or compaction, `reconcile` is in context: continue from it, and close a Running Assignment as `interrupted` only once its agent is confirmed gone (the agent's status or its transcript; an exited parent session proves nothing). <!-- O22 -->
