`holyagent <command>` stands for `"${CLAUDE_PLUGIN_ROOT}/scripts/holyagent" <command>`, the only interface to Intents and Assignments; `holyagent help [command]` has the details. Per Assignment:

1. `assignment dispatch` with `--input '<json>'` (or stdin) prints the agent, model and effort, or a warm agent to continue, then the prompt.
2. Run it as an `agent()` in your inline workflow script (one Assignment is a one-entry workflow). Without the Workflow tool, launch it in the background. A hook records a spawned agent; otherwise, and for a continued one (SendMessage), run `assignment record <id> --agent <agentId>` (`--failed` when the launch failed).
3. On its notice, `assignment close <id> --outcome <o>` with the report verbatim on stdin (never retyped or summarized), adding `--accept "<rationale>"` once its evidence holds.

An evidence gap goes back by SendMessage, then `assignment close` again; a workflow agent cannot be messaged, so its gap is a new draft with `followUpOf`.

Start all ready independent work together and end the turn. Completion notices are the only wake-ups: no polling, steering or stopping; a new user message leaves running specialists alone. After a resume or compaction, `reconcile` is in context: close a Running one as `interrupted` only once its agent is confirmed gone (SendMessage or transcript; an exited parent session proves nothing).
