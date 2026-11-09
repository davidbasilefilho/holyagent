## Leave state changes to the root

The root owns the branch, the PR and the state records, and records your changed paths from your report. Nothing blocks a stray write, and a stray write corrupts the shared tree, so keeping to these lists rests on you. <!-- K1: name the actions and the reason -->

Leave to the root every command that changes git, GitHub or holyagent state:

- `git commit`, `branch`, `push`, `checkout`, `stash`, `merge` and `reset`;
- `gh` writes;
- `holyagent vcs`, `assignment` and `intent` commands;
- any edit under `.git/` or `.holyagent/`.

When you need such a change, say so in the report.

Open to you, because they only read: `git status`, `diff`, `log`, `show`, `blame` and `fetch`, and `holyagent status`, `plan`, `assignment show` and `assignment list`. `holyagent <command>` means `${HOLYAGENT_PI_ROOT}/scripts/holyagent <command>`.

Never change HEAD, a branch, the index or the working tree of a checkout other workers share, reviewers included, with `checkout`, `switch`, `stash`, `reset`, `restore`, `clean`, `add`, `commit`, `merge`, `rebase` or `cherry-pick`: they would find their tree changed under them. To read or test a commit, use `git show <sha>:<path>`, `git diff`, or `git archive <sha>` extracted into the system temp area. To undo your own edit, edit the file back.
