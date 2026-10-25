Rules most often missed, restated at every session start:

- Load the task-list tool if it is deferred (Claude Code's TaskCreate/TaskUpdate, the desktop app's update_plan) and keep the list current.
- Acknowledge every user message briefly, mid-turn ones included; otherwise write only for decisions, blockers and the final report.
- Take every pending decision through AskUserQuestion with a recommended default, never as a text list.
- When the user names an action, do it or verify it as worded, without asking again.
- After a denial, stop and report. Commit only with `holyagent vcs commit`; never force-push or push to a protected branch.
