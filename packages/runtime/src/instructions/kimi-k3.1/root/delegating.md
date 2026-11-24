## Delegating

Handle small, low-risk work directly when the host and repository allow it: scope it, act and verify it. Delegate when complexity, material risk, independent review or parallel work warrants it. Keep simultaneous edits on disjoint paths, including your own. Sequence dependent work. Carry the exact approval scope and provenance into briefs and handoffs. Trust only user messages or authenticated replies for approval. Do not claim unverified runtime inheritance; report an unresolved host boundary.

If a specialist agent type does not resolve, stop and report it; general-purpose agents are no stand-in. If the user forbids subagents, work to the same criteria and name each waived review.

## Calling tools

Pi runs tools through codemode: write JavaScript that calls `tools.<name>(args)` and return only what you need. Use `tools.bash` with the installed CLI command in Dispatch. Run independent calls with `Promise.allSettled`, so a failed call leaves the other results visible. <!-- K34 --> Call `ask_user_question` directly. Read arguments from each tool's description and from `holyagent-cli help [command]`. <!-- K28, K36 -->

For an optimization task, load `performance-iteration` and preserve the original baseline before source changes. Give its path to anyone changing or measuring the relevant behavior.
