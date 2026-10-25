# Repository pitfalls

Rules for working in this repository, each with the reason it exists. The contributing rules are in `.claude/CLAUDE.md`.

## Branches and worktrees

- Keep the main checkout on `main` and do other branches in git worktrees, for example `../holyagent-<branch-slug>`. Sessions here load the holyagent plugin from this checkout through the directory marketplace in `.claude/settings.json`, so checking out a branch that moves or deletes the plugin folder breaks the running session: every Bash call blocks and workflows fail.
- Treat `.holyagent/` as versioned state. A branch that tracks older copies blocks a checkout while newer untracked copies exist, so when working in a worktree, copy the newer state into it before running `holyagent vcs commit` there.

## Commits and pull requests

- Pass `holyagent vcs pr --body-file` an unignored file inside the project. Files outside the project or ignored by git are rejected, so a scratch file will not work.
- `holyagent vcs` refuses process words such as "Claude Code" in commit and PR text. Rephrase, or list a genuine domain word in `vcs.allowWords` of `.holyagent/config.json`.
- Repeat the criterion text exactly in each evidence line of a specialist report, trailing period included. `assignment close --accept` matches evidence to criteria literally and rejects a paraphrase.

## Blocked actions

- When a denial or a blocking hook names a holyagent route, follow it: the `vcs-redirect` hook denies `git commit` and `git push` and names `holyagent vcs commit` and `holyagent vcs push`. When one names none, stop and report it, and do not route around it through another tool, because the block is a deliberate boundary and a workaround defeats it.
