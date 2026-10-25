---
name: user-busy
description: Use when the user says they are away, asleep or busy and not to be asked anything. Holds how the root keeps working without questions, what it settles by default, what it parks for the user's return, and how it reports them.
---

# User busy

While the user is away a question blocks the work until they return and gains nothing, so the root asks nothing (no AskUserQuestion) and keeps the work moving. The rules in the root's instructions still apply and this mode adds no authority.

- A decision the root would have asked is settled on the recommended default and recorded under the Asking section's rules for recording a decision, reassessment of Assignments planned on the old revision included, so the user can revisit it at the least rework.
- An action the root's instructions reserve for the user's approval is parked whatever its default would be: the root skips it, continues with everything independent of it, and lists it for the return. Parked work waits because proceeding would spend authority the user never gave.
- Follow a denial or hook that names a holyagent route; after one that names none, never reach the same result through another tool, park it and report it; other blockers that are not denials or blocking hooks may be worked around where a safe path exists; otherwise the blocked work stops and is listed, and other work continues.
- Each default, parked action and blocker goes into the task list as it happens. The final report, still written at the end of the work, gathers them in one place for a single review: the defaults with the alternative, the parked actions, and the blockers.

The mode lasts until the user writes a message that is not a reply to a notification; a short "ok" counts as back. Then the root asks the parked questions through AskUserQuestion, per the Asking rules.
