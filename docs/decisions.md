# Decisions

Standing decisions and their reasons. Many come from an audit of one long session of the predecessor plugin (HolyClaude): 299 specialist spawns, 326 Assignments and about 397 commits. Finding ids in parentheses are the audit's. Audit figures marked "estimate" were not measured exactly.

## Changed by the audit

**Warm specialist reuse, not always-fresh workers.** The predecessor gave every repair and follow-up a new worker and never used its `select` step: 299 spawns against about 10 genuine resumes, 87 agents on Repair/Fix descriptions, and a re-orientation cost of roughly 8 to 40 thousand tokens each (estimate). Now `assignment dispatch` makes the decision from role, model and effort, the cache window, independence and relevance of context, and prints the exact continuation ([cache-and-workflows.md](cache-and-workflows.md)). Reviewers stay fresh: never the writer or an earlier reviewer of the change. (`cache-reuse-1`, `mechanisms-2`)

**State rides the work commits.** In the predecessor 328 of 397 commits were state transitions and 335 pushes carried them, about a thousand Bash writes. State is still versioned in `.holyagent/`, but `vcs commit` adds the Intent's folder to the commit of the work it records, so state never has a commit of its own. Per-clone data lives in the ignored `.holyagent/local/`. (`stacks-vcs-1`)

**No write guard.** The predecessor's `PreToolUse` guard on Bash, PowerShell, Monitor, Write and Edit started a process for each of 11,949 Bash calls (1,456 seconds of hook latency in all) and denied 114 calls. An estimated 78 percent of those denials were false positives, classified from the denial reasons: `.git` named inside `tar` excludes, `git apply` to a scratch copy, computed program names. 18 follow-ups were denied or failed again. It also failed open when Bun was missing or crashed, and any interpreter bypassed it. The rules (the specialists leave VCS and state to the root; undo your own edit by editing it back) are now instructions, and only a narrow redirect of `git commit` and `git push` remains ([hooks.md](hooks.md)). The maintainer chose this trade: no false denials in exchange for enforcement that rests on the text. (`mechanisms-3`)

**`/code-review` is optional.** The predecessor made Claude Code's built-in review the mandatory first pass, so code was reviewed twice per change and reviewers were 41 percent of all spawns. Its yield over the manual pass was never measured. Reviewer.code is the single pass and may run `/code-review` for a large diff. (`mechanisms-1`)

**Three calls per Assignment.** The predecessor needed four or more commands per Assignment and built JSON through python one-liners; its `select`, `verify` and `accept` steps ran zero times in 326 Assignments, so the independence and evidence checks never ran. Now `assignment dispatch` creates, reserves and selects in one step, `assignment record` binds, and `assignment close` finishes and optionally accepts. Acceptance reads the report's `evidence:` block and the CLI refuses when a blocking criterion or a required label has no support, so there is no restated map for the root to write. (`tool-use-8`, `mechanisms-5`, `mechanisms-6`)

**No `autoCompactWindow`.** HolyAgent does not set it, because Billion Context owns compression (the maintainer's decision). The predecessor's root grew to about 784 thousand tokens and was auto-compacted four times, discarding about 2.9 million cache tokens. Compression is Billion Context's job in native mode, which sets `DISABLE_AUTO_COMPACT=1` ([components.md](components.md)), so a window for Claude Code's auto-compact would configure something that is off. Where Billion Context is bypassed that setting still applies. A host that sets its own window, such as T3 Code, keeps it. (`cache-reuse-3`)

**Prebuilt workflows.** The predecessor used workflows zero times and launched parallel work call by call. Three prebuilt workflows now cover the common shapes, with a direct-subagent fallback when the session has no opt-in ([cache-and-workflows.md](cache-and-workflows.md)). (`cache-reuse-7`)

**Commits are built by the CLI.** Trailers and "Generated with" lines were on nearly every commit and PR body. `vcs commit` sets the author, cleans the text and refuses text that talks about the user or the agent ([commit-authorship.md](commit-authorship.md)). (`stacks-vcs-4`)

**CI is read through one command.** `vcs ci <n> --watch` prints one line per change of state and exits 0, 1 or 124, instead of ad hoc polling loops. (`stacks-vcs-6`)

**Specialists with Bash also get Monitor.** The predecessor's specialists were told to use Monitor and did not have it: 19 failed calls and polling loops. (`tool-use-3`)

**Cache and TTL reasoning left the prompts.** The predecessor's root prompt told the model to reason about cache lifetimes and model switches. Now the CLI embeds the window and the prompts carry none. (`mechanisms-9`)

**No observation hooks.** `SubagentStart`, `SubagentStop`, `PostToolUse` on Agent and effort recording on `PreToolUse` cost about 1,281 process starts and 326 seconds to feed `assignment verify`, which ran zero times in 326 Assignments. `assignment record` now stores the agent id with the route's model and effort, with no hook. What is gone is the check of the model that actually ran against the one requested. (`mechanisms-4`)

**No dispatch guard.** The root's tool list already restricts which agents it may start: `Agent(holyagent:explorer-map, …)` names the eighteen specialists, so the hook was redundant. (`mechanisms-11`)

**A small, bounded session-start hook.** The predecessor loaded every record on every start. With 326 Assignments its resume hook took 11.6 and 11.9 seconds against a 10-second budget and twice injected a 77-character message instead of state (that the load time grew with state size is an inference), and it re-injected 8.4 to 9.9 thousand characters of rules at each of four compactions. The hook now reads only open Intents, caps its context and adds the rules only when the root is not the main agent ([hooks.md](hooks.md)). (`mechanisms-7`)

## Kept

- **Static-first prompts and a session-start status.** The layout and the re-injection after compaction cost nothing measurable; HolyAgent adds nothing dynamic to the system prompt, tools, skills or roster mid-session. (`cache-reuse-9`)
- **Models do not reason about cache, TTL or cost.** The predecessor's root text did not either, apart from the prompt lines removed above. (`root-conduct-11`)
- **Narrow, matcher-scoped hooks.** The cheap ones were worth keeping; the broad one was not. (`mechanisms-11`)
- **Warm continuation where it worked.** One agent carried five or six merge-conflict resolutions at about a 0.98 cache ratio. (`cache-reuse-10`)
- **The root plans and judges; specialists do the work.** The root owns the user relationship, acceptance and version control, and does not poll: completion notices are its only wake-ups.
- **Eighteen specialists with pinned model and effort**, writers confined to disjoint ownership paths, and independent review of every change to code or artifacts, with a security review for trust boundaries.
- **Mergeability as the bar**, in six dimensions with blocking and non-blocking criteria, the repository's own conventions first.
- **One PR per reviewable change**, independent changes branched from the base, merge-forward with merge commits, no force-push without your approval.
- **Compact interfaces.** JSON in, TOON out, long logs in files, fixed report shape.
- **Effect and Bun.** Failures are tagged errors and the toolchain is Bun's own ([development.md](development.md)).
- **State in the repository.** Versioned state in `.holyagent/` is inherited from the predecessor; the audit changed how it is committed (see above). Moving it outside the project tree was proposed (`mechanisms-8`). It stays versioned in `.holyagent/`; the costs behind the proposal are met differently: `status`, `plan`, `reconcile` and the session-start hook read only open Intents, and state travels in the work commits rather than in commits of its own.
