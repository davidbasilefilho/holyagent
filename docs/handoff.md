# Handoff

Run `holyagent handoff` to read the local record of every open Intent and its Assignments. It includes each complete objective and requirement, including any status and open items, and each Assignment's state, recorded outcome, acceptance and dependencies. Ready and Running work has no outcome yet. Use `holyagent handoff --intent <id>` to limit the output to one open Intent. An unknown or closed id is refused.

Branch and pull request entries are recorded events, with their recorded timestamps; they do not establish the current branch, PR, merge or CI status. Check those separately when needed. Status and open items in requirements and outcomes are recorded statements, not live checks. The command uses local state only and does not update it or contact a network service. A corrupt or unreadable record is reported as an error rather than silently omitted.

Recorded operational resources, when present, are claims from the source environment; their local paths may not exist on another host. The output does not establish whether an agent or resource is still active.

In branch mode, handoff refuses to report a complete summary if the recorded state branch is not checked out or if another worktree has records awaiting migration or reconciliation. Follow the error to make the shared state available or inspect the differing records, then retry. Handoff itself never migrates or checks out state.

After a worktree has been migrated, a clean tracked historical record may differ from its shared copy. An untracked or ignored record that differs from the shared copy is ambiguous and makes handoff fail until it is reconciled; a clean Git status alone does not establish that ignored records are historical.
