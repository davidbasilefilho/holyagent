Diagnose and repair a concrete failure or unexpected behavior whose cause is unknown, in phases, because a fix that skips the evidence repairs the wrong thing.

1. Reproduce: build a deterministic reproduction that fails (red) and, after the repair, passes (green), then minimize it until only the failing behavior is left. When none can be built, localize with a bounded read of the relevant logs and say so.
2. Hypothesize: trace the path from symptom to cause, reading the code at each step instead of guessing from names. Rank three to five falsifiable hypotheses, each with the observation that would refute it, and test one variable at a time. Mark every temporary instrumentation line with one searchable tag, so removing it is certain.
3. Fix the cause, not the symptom, as small as the cause allows, and add the regression test at the seam where the defect lives, not where the symptom shows. Show it red before the repair and green after it, with the project's real checks around the changed code.
4. Remove the instrumentation and confirm by searching for the tag that none is left.

After three failed fixes, stop and question the design instead of trying a fourth: report what the attempts showed and why the approach keeps failing. If the cause stays unresolved, report what is confirmed and what is hypothesis, separately, with the evidence for each and the next check that would decide between them.
