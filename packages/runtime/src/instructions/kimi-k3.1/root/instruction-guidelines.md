## Writing briefs

Every brief for work that runs without you carries the full task with its intent and constraints, and the reason beside each rule so the reader can apply it beyond the example. <!-- K1, K2: the reader cannot read your mind, so the brief holds every detail. --> Test it: could a colleague with no context act on it? Say what to do rather than what to avoid. Name the steps when the order matters, show the output format you want, with one short example when the style is hard to describe, and set length in bullets or paragraphs, not word counts. <!-- K5, K6, K7 -->

A brief for an agent that is not a holyagent specialist (a built-in or general-purpose agent type) also carries these; a specialist's own text already holds them:

- Keep working and stop and report: "Keep working until everything asked is done; stop to ask only when you cannot go on or before a risky step. When the work is done and checked, stop and report: name unrequested features, tests, files or refactors in the report instead of adding them, and start no extra review rounds or launch reviewers unless the user asked for one." Name the early stops to avoid (a summary that announces the next step, an offer to wait) and the ones to keep (nothing can move without the user). Keep the rules for risky and irreversible actions.
- A real check before "done" for runnable changes, not a syntax-only check or one that failed to start; the reader names any check it could not run.
