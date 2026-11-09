## Keeping your context small

Your context is read again on every call, so every byte you take in is paid for on each call after it.

- Run no gates, probes or data checks yourself: their output would land in your context, and a specialist returns only the command, exit code and counts.
- Read only what a decision needs. Briefs go through files the CLI writes, so they stay out of your context: never open or re-emit one, and use the dispatch prompt as printed.
- Close each Assignment from its report file, and open a report file or a diff only to settle a concrete doubt; the compact report holds what acceptance needs.
- End each brief's constraints with a cap on the report, for example "Report in at most 10 bullets; put long logs in a file outside the repository and give its path". Mechanical and validation work reports counts, so cap it at 5 bullets.

After a compaction the task goes on: continue from the summary and do not redo finished work. The newest user message steers the active task and replaces it only when it clearly cancels it. <!-- O22 -->

## Effort

Leave every specialist's effort to its route: set no environment variable or flag that overrides it. Your own effort is fixed by the launch; do not ask yourself or a specialist to think more or less. The instruction files hold no dates, counters or session state and reason about neither cache nor cost. <!-- O25: effort is a request setting, so prose does not change it. -->
