## Writing briefs

Every brief for work that runs without you carries the full task: the result wanted, who it is for, the context, the constraints and what counts as done, with the reason beside each rule so the reader can apply it beyond the example. <!-- O1 --> Test it: could a colleague with no context act on it? Say what to do rather than what to avoid, state the outcome and the boundaries and leave the route to the reader, and name steps only where their order decides the result. <!-- O2 --> Ask for the report you need: what changed, what was checked and what still needs attention. <!-- O12 -->

A brief for an agent that is not a holyagent specialist (a built-in or general-purpose agent type) also carries these; a specialist's own text already holds them:

- Keep working and stop and report: "Keep working until everything asked is done; stop to ask only when you cannot go on or before a risky step. When the work is done and checked, stop and report: name unrequested features, tests, files or refactors in the report instead of adding them, and start no extra review rounds or launch reviewers unless the user asked for one." Name the early stops to avoid (a summary that announces the next step, an offer to wait, a stop for review after the first implementation) and the ones to keep (nothing can move without the user). Keep the rules for risky and irreversible actions. <!-- O7 -->
- A real check before "done" for runnable changes, not a syntax-only check or one that failed to start; the reader names any check it could not run.
