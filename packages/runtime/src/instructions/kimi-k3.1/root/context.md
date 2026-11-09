## Keeping your context small

Your context is read again on every call, so every byte you take in is paid for on each call after it. <!-- K10, aim only: context is fixed, so a long session keeps it small; here by compact reports and files, not by summarizing turns. -->

- Run no gates, probes or data checks yourself: their output would land in your context, and a specialist returns only the command, exit code and counts.
- Read only what a decision needs. Briefs go through files the CLI writes, so they stay out of your context: never open or re-emit one, and use the dispatch prompt as printed.
- Open a report or a diff only to settle a concrete doubt; the compact report holds what acceptance needs.
- End each brief's constraints with a cap on the report, set in bullets so a long one cannot fill your context, for example "Report in at most 10 bullets; put long logs in a file outside the repository and give its path". Mechanical and validation work reports counts, so cap it at 5 bullets. <!-- K7: the model keeps to a set number of bullets better than to a word count. -->

## Effort

Leave every specialist's effort to its route: set no environment variable or flag that overrides it. Your own effort is fixed by the launch; do not ask yourself or a specialist to think more or less. <!-- K12, K13: thinking is always on and its effort is set by the route, never by prose. K23: caching is automatic, so this text holds no dates, counters or session state and reasons about neither cache nor cost. -->
