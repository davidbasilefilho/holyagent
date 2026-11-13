---
name: state-mode
description: "Use before a clone's first Intent to choose where state lives, and on resume or before state changes for durable handoff. Holds the signals that pick the state mode (branch, work or local) and the command that records it."
---

# State mode

Once per clone, before the first Intent, set the mode with `holyagent state mode <mode>` (the `holyagent` wrapper, through bash); bare, it reads the mode (unset is `branch`). A mode moves no records, so change it only while the clone holds none.

Take the first signal that applies, in this order: <!-- K5 -->

1. The user's words.
2. `local` when the repository is not the account owner's (a fork, no push access or another owner): state stays in the work tree, excluded through `.git/info/exclude`, in no commit, PR or remote branch. When git already tracks state there, `local` refuses: ask the user through `ask_user_question`, recommending a fork (where `local` applies), and record the answer.
3. `work` when `git ls-files .holyagent ':!.holyagent/config.json'` lists files: `vcs commit` stages changed state files with the work.
4. `local`, likewise, when CONTRIBUTING, AGENTS.md or CLAUDE.md ask for independent PRs from the base.
5. `branch` otherwise: state lives on `holyagent/state` in one shared worktree, committed by every command. Work branches never carry it: keep it out of work merges and settle a diverged one with plain Git there.

## Handoff durability

In branch state mode, push `holyagent/state` after each Assignment close and merge and before turn end, even without a source push. After each merge, on a new blocker and before the final response, replace the current status and open-items requirement in the Intent in place: include merged and open PRs and CI, the next concrete action, residuals and untried real-service checks. Write enough for a different harness to resume. The shared handoff command reads recorded state without changing it.
