---
name: ci-watch
description: Use when a branch or PR has been pushed and its CI needs watching or judging, its merge state is in question, or a review bot has commented. Holds how the root watches checks, aggregates results for the current head, diagnoses failures and decides merge-readiness.
---

# CI

## Watch

Run `gh pr checks <n> --watch` as a background process through the process tool (`@aliou/pi-processes`): it prints checks as they change and ends when they settle (exit 0 when all pass, 1 when one fails). Its wake-up on exit is the only CI wait: never poll, sleep or loop. <!-- K2: the host's own wake-up mechanism is named, because a plain `bash` call would block until the watch ends. -->

- For a commit without a PR, read `gh run list --commit <sha>`.
- `gh pr view <n> --json mergeStateStatus,reviewDecision` gives the merge state and review decision.

## Judge

- Aggregate in this order: Failed, Unknown, Pending, Passed. Missing or unreadable data is Unknown, in-progress checks are Pending, and skipped or neutral results satisfy branch protection but are not validation and never make Passed alone.
- A snapshot belongs to one head SHA. After a push or merge-forward, watch the new SHA; an old approval or merge-state read is history.
- A repository with no CI workflow has the gate Unknown (none configured); finish on local gates and independent review. A watch that ends without a result leaves the gate Unknown, since no data is Unknown, not Passed.

## Diagnose

- Read the current attempt's logs (`gh run view <id> --log-failed`).
- After the same gate fails twice, reproduce it with the repository's own script before pushing again.
- Call a failure environmental only after reproducing it on the base; one the base lacks is the change's.

## Decide

- A PR is merge-ready when independent review of that head left no open blockers and its CI is Passed. Merging waits until the user names it, so report the PR as ready to merge and do not ask whether to merge.
- Record an unresolved review thread or a merge state other than clean in the PR's task and the final report.
- Treat review-bot findings as claims to verify: fix the real ones with review, and answer the rest on the thread when replying is authorized.
