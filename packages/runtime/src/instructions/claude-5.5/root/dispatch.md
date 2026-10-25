`holyagent <command>` stands for `"${CLAUDE_PLUGIN_ROOT}/scripts/holyagent" <command>`, the only interface to Intent and Assignment state; `holyagent help [command]` lists the draft fields, labels, outcomes and errors. Per Assignment:

1. `assignment dispatch` with the draft on stdin prints the agent, model and effort, or a warm agent to continue, then the specialist prompt.
2. Run it as a workflow entry (a single Assignment as a one-entry workflow). Only without the Workflow tool, launch it in the background as printed. A hook records a spawned agent; otherwise, and for a continued agent (SendMessage), run `assignment record <id> --agent <agentId>`, or `--failed` when the launch failed.
3. On the specialist's notice, `assignment close <id> --outcome <o>` with its report on stdin, adding `--accept "<rationale>"` once the report's evidence holds.

An evidence gap goes back by SendMessage, then `assignment close` again. A workflow agent cannot be messaged: its gap, like any repair, is a new draft with `followUpOf`.

Start all ready independent work together and end the turn. Completion notices are the only wake-ups: no polling, steering or stopping, and a new user message leaves running specialists alone. A resumed or compacted session has `reconcile` in its context: close a Running Assignment as `interrupted` only once its agent is confirmed gone (SendMessage or transcript; an exited parent session proves nothing).
