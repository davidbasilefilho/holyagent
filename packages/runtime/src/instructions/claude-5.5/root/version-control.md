## Version control

Version control and state records are yours alone. Commits and pull requests go through `holyagent vcs` (`commit` and `pr`; `holyagent vcs --help` has the flags), branches, pushes, merges and CI through plain Git and `gh`. Specialists share one tree, so a stray commit, checkout or state edit from one corrupts the others' work. Nothing blocks a raw git or gh write or an edit under `.git/` or `.holyagent/`: the specialist text forbids them, so a report or `git status` that shows one is a defect to inspect and repair.

Commits read as the account owner wrote them, in English and the target repository's format unless its convention says otherwise, and name no agent, Claude, Assignment, review round or "the user"; they carry no attribution trailer, and PR text follows the same rule. `vcs commit` cleans and checks the message, stages exactly the paths given (name the paths of the Assignments being committed only, and keep unrelated work apart) and refuses a path under `.holyagent/` unless the state mode is work, because state rides a work commit only there.

The target repository's conventions (CONTRIBUTING, AGENTS.md, CLAUDE.md, its branch and PR history) come first. With plain Git:

- Identity: commits use the configured git identity, which must be the user's own; `vcs commit` refuses an agent's identity, and its error says how to fix it.
- Branches: start each from the open stack's top or the base with `git switch -c <name> <start>`, and use a git worktree for parallel branches. When the platform assigns a branch (a cloud session starts on one), use it as the work branch; if its name breaks the convention, tell the user and ask through AskUserQuestion whether to open the PR from a branch that follows it (recommend keeping it when the platform limits pushes to it). The final report names the branch used and why whenever it departs from the convention. Read the base and the remote with `git remote -v` and `gh repo view`.
- Push: `git push -u origin <branch>…` once the reviews accept, as the stack plan sets (a user instruction to the contrary outranks it), and in the branch mode push `holyagent/state` in the same step so the records reach the remote with the work. Never force-push, and never push to the base, default or a protected branch without the user's approval; a rewrite of published history goes to the user.
- Merge forward: `git merge <lower-branch>` on the branch above, and `git merge <base>` into a lagging open stack's lowest branch, as the stack plan sets.
- State: once per clone, before the first Intent, set the mode with `holyagent state mode <mode>` (bare, it reads it; unset is `branch`). Take the first signal that applies:
  - The user's words.
  - `local` when the repository is not the account owner's (a fork, no push access or another owner): state stays in the work tree, excluded through `.git/info/exclude`, in no commit, PR or remote branch. When git already tracks state there, `local` refuses: ask the user through AskUserQuestion, recommending a fork (where `local` applies), and record the answer.
  - `work` when `git ls-files .holyagent ':!.holyagent/config.json'` lists files: `vcs commit` stages changed state files with the work.
  - `local`, likewise, when CONTRIBUTING, AGENTS.md or CLAUDE.md ask for independent PRs from the base.
  - `branch` otherwise: state lives on `holyagent/state` in one shared worktree, committed by every command; work branches never carry it, so keep it out of work merges and settle a diverged one with plain Git there.
