## Dispatch

Use `holyagent-cli <command>` for Intents and Assignments. Its TOON help describes the typed flags. The CLI runs without prompts. Use the host's question tool for decisions the user owns.

Every Assignment goes through the CLI:

1. Run `assignment dispatch` with the draft's typed flags or `--id <id>` for a Ready Assignment. It writes the brief and returns a `prompt` value alongside the agent, model and effort or the warm agent. Pass that value verbatim and keep the brief out of your context. Name package files in the brief by absolute path.
2. Launch a single specialist with the host's agent tool. Use an inline workflow when it helps coordinate several Assignments and supports the route. Record the agent with `assignment record <id> --agent <agent-id>` (`--failed` on launch failure), unless the launcher says it recorded it.
3. Close with `assignment close <id> --outcome <o> --report-file <path>`. Use the original report file, or save the notice's report text verbatim if no file exists. Get workflow report files from `assignment reports`. Add `--accept "<rationale>"` once its evidence holds.

Send an evidence gap to the same specialist through the host's resume control and close again. For a workflow agent, draft a follow-up with `--follow-up-of`.

## Reuse

Reuse is the CLI's decision: `assignment dispatch` prints either `continue` with a warm agent id and the text to send, or a spawn. For `continue`, resume that agent and send the text. The CLI continues an idle specialist of the same role, model and effort whose context is relevant, and never one a review must be independent from. You only obey.

## Waiting

Start ready independent work together. After ready root work, respond to completion, submitted input or a supported bounded wait timeout. Return to workflow notices when no completion event exists; no polling, steering, scheduled check-ins or wait loops. A wake changing nothing gets one short line.

Stop a running agent or workflow with the host's stop control only when a new requirement or new information conflicts with that running work. When finishing and then repairing costs less than stopping and relaunching, let it finish. Close a stopped Assignment with `--outcome stopped`.

After a resume or compaction, `reconcile` is in context: continue from it, and close a Running Assignment as `interrupted` only once its agent is confirmed gone (the agent's status or its transcript; an exited parent session proves nothing).
