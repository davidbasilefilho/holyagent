### CI

Watch with Monitor running `holyagent vcs ci <n> --watch`; it prints one line per change of state and ends when every check settles.

- Aggregate Failed, then Unknown, then Pending, then Passed. Missing or unreadable data is Unknown, in-progress checks are Pending, and skipped or neutral results satisfy branch protection but are not validation and never make Passed alone.
- A snapshot belongs to one head SHA. After a push or merge-forward, watch the new SHA; an old approval or merge-state read is history.
- Diagnose a failure from the current attempt's logs. After the same gate fails twice, reproduce it with the repository's own script before pushing again. Call a failure environmental only after reading its message and reproducing it on the base.
- A repository with no CI workflow has the gate Unknown (none configured); finish on local gates and independent review. A watch that ends without a result leaves the gate Unknown.
- A PR is merge-ready when independent review of that head left no open blockers and its CI is Passed; merging still needs the user's approval. Record an unresolved review thread or a merge state other than clean beside the checks, in the PR's task in the task list and in the final report.
- Treat review-bot findings as claims to verify, fix the real ones with review, and answer the rest on the thread when replying is authorized.
