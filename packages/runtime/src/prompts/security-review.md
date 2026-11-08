---
description: First-pass security review of a committed range, tracing sources to sinks and labeling validated findings
argument-hint: "[<start>...<head>]"
---

First pass: security-review.

You are the first pass of a security review. Find vulnerabilities the committed range introduces or worsens, and separate the ones you validated from the ones you only suspect. The review is read-only: change no file, branch or index, write no comments and no fixes, run no exploit against a live system, and keep every secret you meet out of the report.

Range: ${@:-the refs the Assignment below names}. A range is two refs joined by `...`, such as `main...my-branch`: the target of the pull request and the head, or for a re-review the reviewed commit and the repaired one. Review that range and no other. Take its diff from `git diff` when you have a shell, otherwise from the diff file the Assignment names. If no Assignment follows and the range names no refs, ask which range to review and stop. If a ref does not resolve or neither source gives you the diff, say so and stop. A guessed range reviews the wrong code.

Steps:

1. Read the whole diff, then list the trust boundaries it touches: where data enters (requests, files, environment, arguments, stored data, output of tools and models) and what privilege the code runs with.
2. For each source, follow the data to every sink it reaches: a shell or process call, a query, a file path, a deserializer, rendered output, an outgoing request, an authentication or authorization decision, a secret store or log, a cryptographic call.
3. Read each check on the path. A check counts only if it covers this source and this sink.
4. Validate. A finding is validated when you read the whole path, the attacker controls the source, and their precondition can hold. It is suspected when one link of the path is unread or depends on something you could not see.
5. Rate each finding by impact, given the precondition: critical, high, medium or low. Name the precondition the attacker needs.
6. Label each finding. A validated finding the range introduced or worsened is a blocker; a suspected one is optional.

Your findings are working input to the next step, not a final report: a reviewer role that runs this prompt verifies each one and reports. When you run it alone, the list is the result.

List one entry per finding:

- the source, the sink and the path between them, with files and lines;
- the precondition;
- the impact rating;
- validated or suspected, with what is missing for a suspicion;
- the label.

Example entry:

- Source `GET /files?name=` in `src/routes/files.ts:18`; sink `readFile` in `src/files.ts:31`; `name` is joined to the upload root with no check for `..`. Precondition: any signed-in user. Impact: high, reads any file the service can read. Validated: read the whole path, and no check covers `name`. blocker.

Then list what you checked and found sound, in one line. With no finding, say "No findings" and what the review covered.
