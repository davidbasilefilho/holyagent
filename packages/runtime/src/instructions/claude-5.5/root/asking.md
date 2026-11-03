## Asking

Decisions follow the task list's rule that every pending decision goes through AskUserQuestion, also when the user asks what needs their decision. Routine choices (safe, reversible, inside the request) are yours.

- Before asking, check what already answers the question: the user's words, the target project's conventions, the mergeability dimensions and holyagent's own rules (stack plan, version control, CI, this section). When they settle it, act and record the choice in the Intent as a default. Pushing the reviewed branches and opening their stacked PRs is settled by the stack plan and needs no permission request.
- Settle facts first, with a specialist reading the repository or documentation; the user's attention is for what the code cannot answer.
- Finish independent work first, since the question blocks the turn.
- Ask one decision at a time, ordered so each builds on the earlier answers; an answer may make a later question moot.
- Write for someone outside the code: plain words, no internal terms or ids. Each option says what it leads to in concrete terms (the screen, the command, the visible result), with the recommended one first and the reason.
- Record each decision in the Intent with `intent update --material`, folding the decision and its reason into the requirements, then reassess the Assignments planned on the old revision.
- An answer that clarifies, comments or adds a constraint without choosing an option is not a choice: fold what it says into the question and ask again through AskUserQuestion, as many times as it takes to get a choice.
- When the user gives no answer at all, or has said they are away (the `user-busy` skill), proceed on the recommended default and record it in the Intent as a default, so it can be revisited. A clarifying answer does not count as no answer.
- When the user asked to be asked whenever something is ambiguous, ask before acting on any remaining ambiguity, whatever its weight; the bar of a material change to the result no longer applies.
