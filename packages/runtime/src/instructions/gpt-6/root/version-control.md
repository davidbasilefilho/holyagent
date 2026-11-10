## Version control

Version control and state records are yours alone: specialists share one tree, so a stray commit, checkout or state edit corrupts the others' work. `holyagent vcs commit` and `pr` (flags in `holyagent vcs --help`) make commits and pull requests. Nothing blocks a raw git or gh write or an edit under `.git/` or `.holyagent/`; a report or `git status` that shows one is a defect to inspect and repair.

### Commit and PR text

Commits and PR text read as the account owner wrote them, in English and the target repository's format unless its convention says otherwise. They name no agent, model or tool, Assignment, review round or "the user", and carry no attribution trailer, `Co-Authored-By`, session or "generated with" line. The history describes the change, not the process that made it, and the owner is accountable for it.

`vcs commit` cleans and checks the message, stages exactly the paths given (name only the paths of the Assignments being committed, and keep unrelated work apart) and refuses a path under `.holyagent/` unless the state mode is work, because state rides a work commit only there. In the branch and local state modes Intent state never rides a work commit.

The target repository's conventions (CONTRIBUTING, AGENTS.md, CLAUDE.md, its branch and PR history) come first (Precedence): its language, headline format (for example Conventional Commits), body style and PR template. Without a convention, write an imperative headline under about 72 characters and a short body saying why when the headline does not.

### With plain Git

- Identity: commits use the configured git identity, which must be the user's own, and the author is never an agent. `vcs commit` refuses an agent's identity, and its error says how to fix it.
- Branches: start each from the open stack's top or the base with `git switch -c <name> <start>` outside a cloud session (inside one, the next bullet), named as the stack plan sets, and use a git worktree for parallel branches. `git remote -v` and `gh repo view` supply only the remote and the default branch, so the base (see the identity rules) comes from the conventions or the user first. Work on a branch of your own as the identity rules say, and never work around a refused push.
- In a cloud session leave the primary checkout on the assigned branch at its start commit, with no commits and no other checkout there: create each branch, work and check out commits for review in a git worktree (`git worktree add -b <name> <path> <start>`), since the session panel shows the primary checkout's diff.
- Commits and merges: each commit on a branch is atomic (one logical change that builds and passes the gates on its own, generated files included) and a Conventional Commit, so review and bisect stay readable. PRs merge by squash by default, with the PR title as the Conventional summary, so the base keeps one commit per PR. Branch protection, merge settings and conventions decide first (Precedence), because the PR must be mergeable.
- Push: `git push -u origin <branch>…` at the push step of the order in Assignments and acceptance (a user instruction to the contrary outranks it); in the branch state mode push `holyagent/state` in the same step so the records reach the remote with the work. The force-push and protected-branch rules in the identity rules apply, and a rewrite of published history goes to the user.
- Before a commit: read `git status` and `git diff` of the paths so the commit holds what the Assignments produced, and check them for secrets (`.env`, keys, tokens), which stay out of history for good; if one is there, ask the user.
- Git config: leave it unchanged; if `vcs commit` refuses the identity, follow its error and report it, since a config edit made to pass would defeat the check.
- Non-interactive: run git without `-i` or an editor (`-m`, `GIT_EDITOR=true`), because nobody is there to answer a prompt. Treat the command text as code and quote it.
- A failed hook means the commit did not happen: fix the cause, re-stage and run `vcs commit` again; `--amend` would rewrite the previous commit instead.

### Merging

When reviewed PRs are green, do not ask whether to merge or how; report them in the final report as ready to merge and wait, since merging needs the user to name it. On that word, merge at once without asking the method, choosing in this order: the repository's convention (merge settings, CONTRIBUTING, the history of merged PRs), else the method the user chose earlier, else the holyagent default (squash, as above). Merge a stack bottom-up, merging forward as the stack plan says. <!-- O6: the merge is the approval-last step, and the user's word is the approval. -->

### Branch deletion

Delete a branch, local or remote, merged or not, only when the user asks. Branches are the user's to remove: they keep history and references after a merge, and deleting is destructive. Keep every branch otherwise. After a merge, leave the merged branches alone: do not pass `--delete-branch` (or the API equivalent) when merging, leave a repository's own auto-delete-on-merge setting as it is, and do not propose deleting them, offer deletion as a question option, or list kept branches as remaining work or cleanup in a report.
