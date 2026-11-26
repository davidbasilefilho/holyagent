---
name: holyagent-workflow
description: Use when work has independent parts, shared files or a material risk that needs separate verification. Scope the work and judge the result against concrete evidence.
---

# HolyAgent workflow

Handle a straightforward change or answer directly. Define the expected result and run the checks that exercise it.

For substantial work, give each specialist a complete Assignment with the outcome, acceptance evidence, relevant inputs, constraints and writable paths or resources. Start work together only when it is independent. The root sequences dependencies, resolves ownership conflicts and integrates the results. Keep reviews independent of the work under review.

When a decision belongs to the user, use the host's native question tool if it is available. Use a synchronous question when the answer blocks the next action, or an asynchronous question when independent work can continue. If the required question tool is missing, report the limitation. Keep questions separate from approvals. Use the native wait tool when only specialist work remains. For V1 on the supported 0.172.0 runtime, pass `timeout_ms: 1200000` when the tool schema allows it. Treat an activity notification as progress, not a finished result.

When new input changes a task, update only the affected scope. Steer through the host's supported control when it changes what the worker does. Stop work whose authorization was withdrawn. Preserve valid results and continue independent work while a decision is pending.

Use the repository's gates. Verify each material claim at its real entry point when it matters. For a performance claim compare the accepted baseline and candidate under comparable conditions. Review trust-boundary changes independently and leave enforcement with the native host. A change with a regression, a missing required check or an unresolved review is not merge-ready. Recheck the exact head and applicable protections before any authorized merge. Report verified results and what remains blocked.
