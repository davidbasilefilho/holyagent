# Repository pitfalls

Rules for working in this repository, each with the reason it exists. The contributing rules are in `.claude/CLAUDE.md`.

## Branches and worktrees

- Keep the main checkout on `main` and do other branches in git worktrees, for example `../holyagent-<branch-slug>`. Sessions here load the holyagent plugin from this checkout through the directory marketplace in `.claude/settings.json`, so checking out a branch that moves or deletes the plugin folder breaks the running session: every Bash call blocks and workflows fail.
- Treat `.holyagent/` as versioned state. A branch that tracks older copies blocks a checkout while newer untracked copies exist, so when working in a worktree, copy the newer state into it before running `holyagent vcs commit` there.

## Commits and pull requests

- `holyagent vcs` has two commands, `commit` and `pr`; branches, pushes, merges and CI use plain Git and `gh`. The `commit-msg` hook (`holyagent hook commit-msg`, wired in `lefthook.yml`) keeps agent attribution out of commits made with plain Git too.
- Pass `holyagent vcs pr --body-file` an unignored file inside the project. Files outside the project or ignored by git are rejected, so a scratch file will not work.
- `holyagent vcs` refuses process words such as "Claude Code" in commit and PR text. Rephrase, or list a genuine domain word in `vcs.allowWords` of `.holyagent/config.json`.
- Start each evidence line of a specialist report with the criterion text or the evidence label, then a colon and the support. `assignment close --accept` matches the text before the colon after normalizing case, spacing, trailing punctuation, a leading `[blocking]` and a trailing `(dimension)`, so those differences are fine; a paraphrase or another criterion's text matches nothing. A support may continue on indented lines below its entry.

## Version-control rules

- The root commits only with `holyagent vcs commit`, uses plain Git and `gh` for branches, pushes, merges and CI, and never force-pushes or pushes to a protected branch without the user's approval. After a denial it stops that line of work and reports a blocker, and does not reach the same result through another tool, because a workaround defeats the boundary the user set. A specialist makes no version-control writes and no edits under `.git/` or `.holyagent/`, and reports its changed paths for the root to record. Nothing blocks these writes: the rules are instruction text, restated by hooks that only add context (`docs/hooks.md`).
