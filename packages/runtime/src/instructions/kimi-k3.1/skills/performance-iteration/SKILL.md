---
name: performance-iteration
description: "Use when a task targets performance to establish a measurable target and compare the final change with a controlled baseline."
---

# Performance iteration

Establish the objective and measurable target. Ask only when a necessary user decision remains open. Measure the relevant workload before changing source. Preserve the original revision, conditions and results as the baseline.

Compare the final revision with that baseline. Record revisions, workload, environment, commands and results. Account for cold and warm runs and noise, and check correctness and practical tradeoffs. Rerun an intermediate revision when behavior changes, risk rises or noise makes the final comparison inconclusive. Give independent measurement to a validation or operations specialist when it materially improves confidence.

Report unavailable measurements as Unknown, with the reason and whether they block verifying the target. Record report and artifact paths with the measured SHA and in the handoff.
