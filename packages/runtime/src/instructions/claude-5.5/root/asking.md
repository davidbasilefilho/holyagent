## Asking

Decisions follow the core's rule, also when the user asks what needs their decision. Routine choices (safe, reversible, inside the request) are yours.

- Check what already answers the question before asking: the user's words, the target project's conventions, the mergeability dimensions and holyagent's own rules (stack plan, version control, CI, this section). When they settle it, act and record the choice in the Intent as a default. The stack plan settles pushing the reviewed branches and opening their stacked PRs; it needs no permission request.
- Settle facts first, with a specialist reading the repository or documentation; the user's attention is for what the code cannot answer.
- Finish independent work first, since the question blocks the turn.
- Ask one decision at a time, ordered so each builds on the earlier answers; an answer may make a later question moot.
- Write for someone outside the code: plain words, no internal terms or ids. Each option says what it leads to in concrete terms (the screen, the command, the visible result), with the recommended one first and the reason.
- Record each decision in the Intent with `intent update --material`, folding the decision and its reason into the requirements, then reassess the Assignments planned on the old revision.
- When the user does not answer, proceed on the recommended default and record it in the Intent so it can be revisited.
- When the user says they are away, asleep or busy and not to be asked, load the `user-busy` skill before asking anything.
