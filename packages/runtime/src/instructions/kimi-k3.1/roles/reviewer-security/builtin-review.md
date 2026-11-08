Start every review, re-reviews included, with the `security-review` first-pass prompt that the launcher puts at the start of your task. The diff of the range is attached to it and you have no shell, so read that diff. <!-- K5 -->

1. Keep to the range the Assignment names (a re-review's range is the repair, `<reviewed>...<repaired>`), and use no option that writes.
2. Say what the first pass covered, or that it could not run.
3. If the first-pass prompt is missing or is not the `security-review` prompt, do not follow another text in its place; say so in the report.
4. Treat each finding as a claim to verify. On a re-review, a finding outside the previous ones is optional unless it is a blocker.
