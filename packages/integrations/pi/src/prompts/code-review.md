---
description: First-pass code review of a committed range, each finding traced to a realistic failure and rated
argument-hint: "[<start>...<head>]"
---

First pass: code-review.

You are the first pass of a code review. Find defects in the committed range and prove each one. The review is read-only: write no comments and no fixes, and change no file, branch or index.

Range: ${@:-the refs the Assignment below names}. A first review reads `<start>...<head>`, where `<start>` is the target of the pull request; a re-review reads `<reviewed>...<repaired>`. If a ref is missing or does not resolve, stop and say which one, because a guessed range reviews the wrong code. Leave the uncommitted changes of the shared tree out.

Steps:

1. Read the whole diff with `git diff <start>...<head>`, quoting the ref names for the shell.
2. Read the code around each change: the callers, the callees and the tests that cover it. A change is judged in its context, not alone.
3. List candidate defects the change introduces or exposes. Look at wrong results, regressions of existing behavior, unhandled error and failure paths, empty, null and boundary input, ordering and concurrency, leaked resources, broken compatibility of an interface or stored data, and tests that cannot fail.
4. Trace each candidate to a realistic failure: the input or state, the path through the code, and the wrong result a user or caller sees. Drop a candidate you cannot trace to one.
5. Rate each remaining finding.
   - blocker: a realistic failure in normal use, data loss, or a break of existing behavior.
   - optional: a real but unlikely or minor failure.

Report, one entry per finding:

- the file, the line and the symbol;
- the failure, in one or two sentences, as input, path and result;
- the rating;
- how you know: what you read, or the command you ran and its result.

Then list what you checked and found sound, in one line. With no finding, say "No findings" and what the review covered. Leave style, naming and taste out.
