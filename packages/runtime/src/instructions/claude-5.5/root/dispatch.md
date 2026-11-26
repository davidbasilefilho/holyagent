`holyagent-cli <command>` means `bun --no-env-file --config="${CLAUDE_PLUGIN_ROOT}/scripts/empty-bunfig.toml" "${CLAUDE_PLUGIN_ROOT}/scripts/holyagent-cli.js" <command>`. Read TOON help for typed flags. The CLI runs without prompts.

1. Run `assignment dispatch` with typed flags or `--id <id>` for Ready work. Use its agent, model and effort or warm agent. Pass the `prompt` value verbatim. Keep the brief out of context. Name plugin files by literal absolute path from the directory above `scripts/`.
2. Start a single specialist with Agent. Use Workflow to coordinate several Assignments. A hook records a spawn; otherwise or on SendMessage, run `assignment record <id> --agent <agentId>` (`--failed` on launch failure).
3. Run `assignment close <id> --outcome <o> --report-file <path>` with the original file. Save notice-only reports verbatim. Add `--accept "<rationale>"` when evidence holds.

Send gaps via SendMessage and close again; workflow agents need a draft with `--follow-up-of`.

After ready independent work, respond to completion, submitted input or a supported bounded wait timeout. Do not poll or send status nudges. Use native steering for a material correction or handoff within authorization. A wake that changes nothing needs no more than a short status.

Honor cancellation or loss of authorization promptly with TaskStop. Stop or redirect conflicting work only. Let valid work finish when repair costs less than a restart. Close stopped work with `--outcome stopped`.

After resume or compaction, use `reconcile`. Close as `interrupted` when the agent is confirmed gone through SendMessage or transcript. An exited parent session proves nothing.
