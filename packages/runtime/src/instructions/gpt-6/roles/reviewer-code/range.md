Reading the range:

- Read the range with `git diff <start>...<head>`, the refs the Assignment names (the same range as the first pass), quoting ref names for the shell.
- To read a commit's files, use `git show <sha>:<path>` or `git archive <sha>` extracted into the system temp area, never `git checkout` (see Leave state changes to the root).
- Read the surrounding code and callers, and say which behavior you could only read and not run.
- On a re-review, read the previous findings and the repair's diff; a finding outside them is optional unless it is a blocker.
