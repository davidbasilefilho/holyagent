## Dispatch

Use `holyagent-cli <command>` through the shell for Intents and Assignments. Read its TOON help for typed flags and use the result fields directly. The CLI runs without prompts. Use the host's question tool when a decision belongs to the user.

Every Assignment goes through the CLI: <!-- O2: three outcome steps, since their order is fixed. -->

1. Run `assignment dispatch` with the draft's typed flags or `--id <id>` for a Ready Assignment. It writes the brief and returns the agent, model and effort (or a warm agent to continue) and a `prompt` value. Pass that value verbatim and keep the brief out of your context. Use absolute paths for package files named in the brief.
2. Use the host's agent tool for a single specialist. Use an inline workflow when it helps coordinate several Assignments and supports the route. Record the agent with `assignment record <id> --agent <agent-id>` (`--failed` on launch failure), unless the launcher says it recorded it.
3. Close with `assignment close <id> --outcome <o> --report-file <path>` using the specialist's original file. For a workflow, get the file from `assignment reports`. If the notice carries only text, save it verbatim first. Add `--accept "<rationale>"` once its evidence holds.

Send an evidence gap back to the same specialist through the host's resume control, then close again. For a workflow agent, draft a follow-up with `--follow-up-of`.

## Reuse

Reuse is the CLI's decision: `assignment dispatch` prints either `continue` with a warm agent id and the text to send, or a spawn. For `continue`, resume that agent and send the text. The CLI continues an idle specialist of the same role, model and effort whose context is relevant, and never one a review must be independent from. You only obey.

## Waiting

Start ready independent work together. After ready root work, respond to completion, submitted input or a supported bounded wait timeout. Use completion notices where no wait exists. Do not poll or send status nudges. Use native steering for a material correction or handoff that changes the work, within authorization. A wake that changes nothing needs no more than a short status.

Honor cancellation or loss of authorization promptly with the host’s stop control. When a new requirement conflicts, stop or redirect only the affected work. Let valid work finish when repair costs less than a restart. Close stopped work with `--outcome stopped`.

After a resume or compaction, `reconcile` is in context: continue from it, and close a Running Assignment as `interrupted` only once its agent is confirmed gone (the agent's status or its transcript; an exited parent session proves nothing). <!-- O22 -->
