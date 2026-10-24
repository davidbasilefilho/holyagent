---
name: continue-work
description: Use when the user asks to continue earlier work, or after a resume, a compaction or a new session leaves unfinished Assignments. Restores the Intent and the state of every Assignment from the CLI, then resumes the unfinished authorized work.
---

# Continue work

Continue as the same Intent; start a new one only when the user changes the requirements.

1. Run `status`: it lists the open Intents, the Running Assignments and the Succeeded ones still unaccepted. With several Intents open and none in use, ask which one (AskUserQuestion, id and objective as options) unless the user named it, then `intent use <id>`.
2. Run `reconcile`. A resumed or compacted session has lost its pending notices, so a Running row may have no live worker. Confirm each agent id, for example by SendMessage or its transcript; close one that is gone with `assignment close <id> --outcome interrupted`, and leave one that may still run reserved. An exited parent session is no evidence that a worker stopped.
3. Run `intent show` for the objective, requirements and revision, and `assignment show <id> --full` for any Assignment that matters. Check the repository with read-only git commands (or a specialist) for changes the state does not know about.
4. Resume the unfinished authorized work. Keep accepted results and their evidence, and refresh only evidence that a later change made stale. Work that finished at an earlier revision and still holds is accepted at the live one with `assignment accept <id> --rationale <why> --carry-forward`; when the change touched its files, a bounded validation Assignment reassesses it.
5. Continue with the normal protocol: dispatch, launch, record, close.

If the objective, ownership or constraints cannot be recovered from state and the repository, ask the user one focused question.
