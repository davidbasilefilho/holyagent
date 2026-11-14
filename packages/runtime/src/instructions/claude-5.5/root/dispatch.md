`holyagent <command>` means `bun --no-env-file --config="${CLAUDE_PLUGIN_ROOT}/scripts/empty-bunfig.toml" "${CLAUDE_PLUGIN_ROOT}/scripts/holyagent.js" <command>`, the CLI for Intents and Assignments (`holyagent help [command]`):

1. `assignment dispatch --input '<json>'` (or stdin) writes the brief and prints agent, model, effort (or warm agent) and its two-line prompt. Use it as printed; never open or re-emit the brief. A brief that names a plugin file gives its literal absolute path under the plugin folder, the directory above `scripts/` in the CLI path above; plugin-path variables resolve only in agent and skill text.
2. Run it as `agent()` in an inline workflow script (one Assignment is a one-entry workflow), or in the background without Workflow. A hook records a spawn; otherwise or on SendMessage, run `assignment record <id> --agent <agentId>` (`--failed` on launch failure).
3. On notice, pass the report verbatim, never retyped or summarized: `assignment close <id> --outcome <o> < <report-file>`; add `--accept "<rationale>"` when its evidence holds.

Send gaps via SendMessage and close again; workflow agents need a `followUpOf` draft.

Start work together. After root work, respond to completion, submitted input or a supported bounded wait timeout. Use workflow notices; no polling, steering, scheduled check-ins or wait loops. A timeout does not guarantee cache reuse; a wake changing nothing gets one short line.

Stop a running agent or workflow (TaskStop) only for conflicting new requirements or information; let it finish if finishing and repairing costs less than stopping and relaunching. Close the stopped Assignment with `--outcome stopped`.

After resume or compaction, `reconcile` is in context: close a Running Assignment as `interrupted` only when its agent is confirmed gone (SendMessage or transcript; an exited parent session proves nothing).
