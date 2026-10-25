`holyagent <command>` stands for `"${CLAUDE_PLUGIN_ROOT}/scripts/holyagent" <command>`, the only interface to Intent and Assignment state. `holyagent help` and `<command> --help` list the draft fields, labels, outcomes and errors. Per Assignment there are three steps:

1. `assignment dispatch` with the draft on stdin prints the agent, model and effort, or a warm agent to continue, then the specialist prompt.
2. Run it as a workflow entry (a single Assignment as a one-entry workflow). Only with the Workflow tool disabled or unavailable, launch it as printed in the background. A hook records a spawned agent; run `assignment record <id> --agent <agentId>` if it says it did not and for a continued agent, `--failed` when the launch failed.
3. On the specialist's notice, `assignment close <id> --outcome <o>` with its report on stdin, adding `--accept "<rationale>"` once the report's evidence holds.

An evidence gap goes back by SendMessage to the subagent, then `assignment close` again. A workflow agent cannot be messaged, so its gap, like any repair, is a new draft with `followUpOf`.

Start all ready independent work together and end the turn. Completion notices are the only wake-ups: no polling, steering or stopping, and a new user message leaves running specialists alone. A resumed or compacted session starts with `reconcile` in its context: close a Running Assignment as `interrupted` only once its agent is confirmed gone (SendMessage or transcript; an exited parent session proves nothing); otherwise it stays Running.
