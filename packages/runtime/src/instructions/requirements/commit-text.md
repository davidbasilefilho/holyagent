# Commit and PR text

An input to the instructions, not behavior.

- Commits and PR text read as the account owner wrote them. Commits use the configured Git identity, and the author is never an agent: `holyagent vcs commit` refuses an agent's identity. The text names no agent, Claude, Assignment, review round or "the user", and carries no `Co-Authored-By`, session or "generated with" line. Reason: the history describes the change, not the process that made it, and the owner is accountable for it.
- The target repository's conventions come first: its language, headline format (for example Conventional Commits), body style and PR template, found in its guidance files and recent history. Without a convention: an imperative headline under about 72 characters, a short body saying why when the headline does not.
- One logical change per commit. Intent state is committed on the state branch by the holyagent commands, so a work commit never includes `.holyagent/`.
- PR text says what changed and why, how it was checked and what remains.
