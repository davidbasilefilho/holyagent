## Version control

Version control and state records are yours alone. Commits and pull requests go through `holyagent vcs` (`commit` and `pr`; `holyagent vcs --help` has the flags); branches, pushes, merges and CI are plain Git and `gh`. Specialists share one tree, so a stray commit, checkout or state edit from one corrupts the others' work and the history. Commit only with `holyagent vcs commit`, never `git commit`. Nothing blocks a raw git or gh write or an edit under `.git/` or `.holyagent/`: the specialist text forbids them, so a report or `git status` that shows one is a defect to inspect and repair.

Commits read as the account owner wrote them, in English and the target repository's format unless its convention says otherwise, and name no agent, Claude, Assignment, review round or "the user"; they carry no attribution trailer, and PR text follows the same rule. `vcs commit` cleans and checks the message, stages exactly the paths given (name the paths of the Assignments being committed only, and keep unrelated work apart) and refuses a path under `.holyagent/` unless the state mode is work, because state rides a work commit only there. A repository's `commit-msg` hook can run `holyagent hook commit-msg` to keep attribution out of commits made by hand.

The target repository's conventions (CONTRIBUTING, AGENTS.md, CLAUDE.md, its branch and PR history) come first. With plain Git:

- Identity: commits use the configured git identity, which must be the user's own; `vcs commit` refuses an agent's identity, and its error says how to fix it.
- Branches: start each from the current stack head or the base with `git switch -c <name> <start>`, and use a git worktree for parallel branches. Read the base and the remote with `git remote -v` and `gh repo view`.
- Push: `git push -u origin <branch>…` once the reviews accept, as the stack plan sets, and in the branch mode push `holyagent/state` in the same step so the records reach the remote with the work. Never force-push, and never push to the base, default or a protected branch without the user's approval; a rewrite of published history goes to the user.
- Merge forward: `git merge <lower-branch>` on the branch above, once per batch of repairs, then push the affected branches together.
- State: once per clone, before the first Intent, set the mode with `holyagent state mode <mode>` (bare, it reads it; unset is `branch`). Take the first signal that applies:
  - The user's words.
  - `local` when the repository is not the account owner's (a fork, no push access or another owner: `git remote -v`, `gh repo view`): state stays in the work tree, excluded through `.git/info/exclude`, in no commit, PR or remote branch. When git already tracks state there, `local` refuses: ask the user through AskUserQuestion, recommending a fork (where `local` applies), and record the answer.
  - `work` when `git ls-files .holyagent ':!.holyagent/config.json'` lists files: `vcs commit` stages changed state files with the work.
  - `local`, likewise, when CONTRIBUTING, AGENTS.md or CLAUDE.md ask for independent PRs from the base.
  - `branch` otherwise: state lives on `holyagent/state` in one shared worktree, committed by every command; work branches never carry it, so keep it out of work merges and settle a diverged one with plain Git there.
