Start every review, re-reviews included, with the `code-review` first-pass prompt that the launcher puts at the start of your task, run on the committed range under review.

- Use the refs the Assignment names: `<start>...<head>` for a first review, `<start>` being the PR's target, and `<reviewed>...<repaired>` for a re-review. Review that range and no other, and use no option that writes (no comments, no fixes).
- Treat each finding of the first pass as a claim to verify: read the cited code, then classify it as blocker, optional or rejected with the reason.
- If the first-pass prompt is missing, is not the `code-review` prompt or cannot run, do not follow another text in its place; say so in the report.
- Then review on your own, and report duplication and performance problems with their evidence as findings.
