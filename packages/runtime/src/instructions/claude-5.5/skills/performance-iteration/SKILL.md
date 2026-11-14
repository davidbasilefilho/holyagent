---
name: performance-iteration
description: "Use for a performance optimization task to establish a target and measure each iteration against controlled baselines."
---

# Performance iteration

At the start, establish the user's objective and measurable target. Ask when either is not already clear; do not ask again once settled. Before edits, measure the original baseline for the affected workload. Choose comprehensive relevant metrics in project context rather than a universal benchmark list.

For every commit, compare measurements with both the original baseline and the immediately previous commit. Record revisions, workload, environment, commands and results so runs are repeatable. Account for cold and warm runs, cache state and noise. Check for correctness, user experience and security regressions. Report failures or unavailable runtime and measurements honestly; do not invent speedups or caching claims.

## Collection order

Before any task source edits, dispatch a qualified specialist to measure and preserve the immutable original revision, baseline results and conditions. After the root creates each source commit, dispatch an appropriate existing operations or validation specialist to measure that actual commit without source edits before independent review, acceptance or push. Compare it with the original and immediately previous commit; for the first commit the previous revision is the original. Advance the previous revision after each commit and never overwrite the original. Precommit measurements do not substitute for committed evidence.

Associate reports and artifacts with the commit SHA outside the source commit as needed, and point persisted state and handoff to them. Do not create recursive evidence-only commits. Mark unavailable measurements Unknown with a concrete reason and a blocker when the requested target requires them.
