`holyagent-cli <command>` means `bun --no-env-file --config="${CLAUDE_PLUGIN_ROOT}/scripts/empty-bunfig.toml" "${CLAUDE_PLUGIN_ROOT}/scripts/holyagent-cli.js" <command>`. Read TOON help for typed flags. The CLI runs without prompts. Use AskUserQuestion for user decisions.

1. Run `assignment dispatch` with typed flags or `--id <id>` for Ready work. Use the returned agent, model and effort or warm agent. Pass the `prompt` value verbatim. Keep the brief out of context. Name plugin files by literal absolute path from the directory above `scripts/`.
2. Run it as `agent()` in an inline workflow script (one Assignment is a one-entry workflow), or in the background without Workflow. A hook records a spawn; otherwise or on SendMessage, run `assignment record <id> --agent <agentId>` (`--failed` on launch failure).
3. Run `assignment close <id> --outcome <o> --report-file <path>` with the original file. Save notice-only reports verbatim. Add `--accept "<rationale>"` when evidence holds.

Send gaps via SendMessage and close again; workflow agents need a draft with `--follow-up-of`.

After root work, respond to completion, submitted input or a supported bounded wait timeout. Use notices with no polling, steering, scheduled check-ins or wait loops. A timeout does not guarantee cache reuse. A wake changing nothing gets one short line.

Use TaskStop only for conflicting new requirements or information. Let work finish when repairing is cheaper than stopping and relaunching. Close stopped work with `--outcome stopped`.

After resume or compaction, use `reconcile`. Close as `interrupted` when the agent is confirmed gone through SendMessage or transcript. An exited parent session proves nothing.
