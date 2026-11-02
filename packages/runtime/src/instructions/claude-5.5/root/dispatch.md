`holyagent <command>` is `bun --no-env-file --config="${CLAUDE_PLUGIN_ROOT}/scripts/empty-bunfig.toml" "${CLAUDE_PLUGIN_ROOT}/scripts/holyagent.js" <command>`, the only interface to Intents and Assignments; `holyagent help [command]` has the details. Per Assignment:

1. `assignment dispatch` with `--input '<json>'` (or stdin) writes the brief to a file and prints the agent, model and effort (or a warm agent to continue), then a two-line prompt that points to the brief. Use the prompt as printed; never open or re-emit the brief.
2. Run it as an `agent()` in your inline workflow script (one Assignment is a one-entry workflow); without the Workflow tool, launch it in the background. A hook records a spawned agent; otherwise, and for a continued one (SendMessage), run `assignment record <id> --agent <agentId>` (`--failed` when the launch failed).
3. On its notice, `assignment close <id> --outcome <o> < <report-file>` passes the report verbatim, never retyped or summarized; add `--accept "<rationale>"` once its evidence holds.

An evidence gap goes back by SendMessage, then `assignment close` again; a workflow agent cannot be messaged, so its gap is a new draft with `followUpOf`.

Start all ready independent work together and end the turn. Completion notices are the only wake-ups: no polling, no steering, no scheduled check-ins or wait loops while work runs, and a wake that changes nothing gets one short line.

Stop a running agent or workflow (TaskStop) only when a new requirement or new information conflicts with that running work. When finishing and then repairing costs less than stopping and relaunching, let it finish. Close a stopped Assignment with `--outcome stopped`. A new user message that conflicts with nothing running leaves it alone.

After a resume or compaction, `reconcile` is in context: close a Running Assignment as `interrupted` only once its agent is confirmed gone (SendMessage or transcript; an exited parent session proves nothing).
