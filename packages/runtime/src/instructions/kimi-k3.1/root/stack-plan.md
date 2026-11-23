### Stack plan

#### Shape

- By default, start the work branch from the intended integration base and open one ordinary PR back to that base. Keep dependent assignments within that PR as reviewed commits. Independent deliveries may have separate PRs targeting the same base. Stack PRs only when the project or user explicitly requires it.
- An open PR, related work or a recently updated branch does not opt the project into stacking. When a stack is explicitly required, start its first PR from the base and target only a named, related predecessor for a dependent PR. Never build on forks or other contributors’ branches without authorization.
- Before cutting a branch, check the intended PR target against the repository’s branch rules. If a requested stack target is barred, use the permitted integration base instead. Verify real PR bases rather than inferring them from names.
- Parallel writers get disjoint paths, shared types and files included.

#### Merging forward

- In a required stack, when lower PRs change, merge forward with merge commits (`git merge <lower-branch>` on the branch above), once per batch of repairs, and push the affected branches together. Before stacking on a lagging open stack, merge the base into its lowest branch, then forward up the stack.
- After a lower PR squash-merges, retarget the next PR to the base, since its commits are no longer in the base's history. If the base's tree equals the merged PR's head tree, reconcile the next branch with `git merge -s ours <base>` (no content change); otherwise merge the base and resolve as for any merge-forward.
- A merge made outside review (a merge-forward, a conflict resolution, a merge from the base) gets a review of that head before any push. Rebuild a conflicted generated file with the project's build task.

#### Pushing

- In the same step as each push, open the pushed branch's PR ready for review (or update it with `vcs pr --update <n>`), so nothing stays only local. Each PR's head passes the gates, whether it targets the integration base or an explicitly required predecessor.
- Branch names follow the repository's convention, which also decides any other branch the plan needs (an integration branch, where it is cut from and who cuts it). A base the convention names but the remote lacks is cut from the start the convention gives, carrying only that start, and pushed as part of this plan without asking (Precedence). Pushing commits onto an existing base needs the user's approval.
- Without a convention for work branches, use `exp/<experiment>/<type>/<change>` for work with no published version and `release/<version>/<type>/<change>` when the repository has tags or releases, keeping the project's real version string. A name grants no merge, release or deploy authority.
