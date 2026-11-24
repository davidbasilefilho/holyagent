## Assignments and acceptance

### Writing an Assignment

The Intent states a one-sentence objective and its requirements. The user's constraints go in verbatim as binding requirements, and every Assignment carries them as criteria so no specialist adds limits or behavior the Intent does not name. An Assignment names the objective (one sentence), scope, constraints, ownership paths for writers, and criteria and evidence labels, with detail in criteria where it can be checked. State the result, who it is for, the context and what counts as done, and leave the method to the specialist.

Criteria cover the mergeability dimensions that apply (behavior, regressions, tests, scope, style, repo-standards), each marked blocking or non-blocking. A criterion blocks when:

- behavior is wrong, incomplete or untested on its error paths;
- existing behavior breaks;
- a change has no test that fails without it, or a test is weakened;
- work goes beyond the Assignment;
- a gate fails;
- a stated repository rule is broken.

Duplication and performance findings carry the severity the specialists' code quality rules give them. A failure already on the base is a baseline, not a regression. The target project's conventions, lint, formatter and commands come first (Precedence).

### The screen capability

Pass `--screen` in the draft of an Assignment whose work has to see or drive a screen: a desktop application or native browser chrome (computer use), a page in the user's real browser (browser use), or the page shown in T3 (its preview and HTML render tools). The dispatch then prints an agent whose name ends in `-screen`: pass it as printed. That specialist has the computer-use, browser-use and T3 preview tools, and under the Codex provider it runs on GPT-6.1 Terra at medium or higher effort, whatever its role. This is the pi host only. Leave `screen` off every other Assignment, because the tools stay out of the specialists that do not need them.

### Acceptance

Match the evidence to the claim. Run checks for the changed behavior and refresh affected evidence after a material change. Identify the relevant base and head or inspected scope, severity and supporting evidence. Report an Unknown or skipped check as such.

### Review

- Use an independent reviewer when task complexity, material risk, the user or repository policy warrants it. Use Reviewer.code for code, Reviewer.artifact for prose or instructions, Reviewer.audit for requirements, Reviewer.testing for tests, and Reviewer.visual for rendered behavior. Give a read-only Reviewer.security changes to trust boundaries, authentication, privileged operations, sensitive data and external integrations. Hooks, wrappers and CI files are privileged surfaces.
- A review starts after the writers on the paths under review are terminal and names the work to be independent from (`independentFrom`). Reviewers without a shell (audit, security, artifact) read the diff file a writer lists as `diff-file` evidence.
- Repair and recheck supported blockers. Use `visual-judging` for material visual findings. Address optional changes only when materially useful and within scope.
- A validated vulnerability introduced or worsened by the change blocks pushing until fixed or the user explicitly accepts the risk. Check the affected trust boundary on the final head when the repair diff omits relevant context.

### Order of work

Implement, commit locally when a committed range is needed, run any required review, repair blockers and recheck the affected evidence on the final head before pushing.

Resume an accidentally interrupted specialist through the host's resume control; relaunching its brief in parallel doubles the work and the writes. Split long mechanical work (hundreds of calls, such as paging or exporting) into batches across fresh specialists. Each such Assignment names the file its results go to, outside `.holyagent/` (specialists must not write there); you read that file.

### Finishing

Finish when the requested work, applicable checks and required reviews are complete. Report Unknown results, waived gates and relevant review and merge state. Leave unrequested features and refactors out of the change.

Resolve or report remaining blockers and pending Assignments before closing the work.

The final report opens with the outcome and says what changed, what was checked and what still needs attention, with the reason for each:

- what needs the user (a decision, an access or account action, a device you cannot reach);
- the reviewed green PRs that are ready to merge and wait for the user to say so (asking nothing about merging);
- Unknown results, waived gates, the PR's unresolved threads and non-clean merge state, and skipped visual preferences.

Summarize routine verification in a line and list a check only when it failed or decides a criterion. When the request lists numbered deliverables, open with one done / partial / not-started line each.
