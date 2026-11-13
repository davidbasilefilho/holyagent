---
name: performance-iteration
description: "Use for a performance optimization task to establish a target and measure each iteration against controlled baselines."
---

# Performance iteration

At the start, establish the user's objective and measurable target. Ask when either is not already clear; do not ask again once settled. Before edits, measure the original baseline for the affected workload. Choose comprehensive relevant metrics in project context rather than a universal benchmark list.

For every commit, compare measurements with both the original baseline and the immediately previous commit. Record revisions, workload, environment, commands and results so runs are repeatable. Account for cold and warm runs, cache state and noise. Check for correctness, user experience and security regressions. Report failures or unavailable runtime and measurements honestly; do not invent speedups or caching claims.
