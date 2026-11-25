---
name: holyagent-workflow
description: Use when work has independent parts, shared files or a material risk that needs separate verification. Scope the work and judge the result against concrete evidence.
---

# HolyAgent workflow

Handle a straightforward change or answer directly. Define the expected result and run the checks that exercise it.

For substantial work, identify independent parts and who owns each one. Give a specialist the outcome, relevant constraints, writable paths or resources, and the evidence you need. Keep writes disjoint and reviews independent of the work under review.

When a decision belongs to the user, use the host's native question tool if it is available. Use a synchronous question when the answer blocks the next action, or an asynchronous question when independent work can continue. Keep questions separate from approvals. Use the native wait tool when only specialist work remains. For V1 on the supported 0.172.0 runtime, pass `timeout_ms: 1200000` when the tool schema allows it. Treat an activity notification as progress, not a finished result.

Use the repository's gates. Verify each material claim at the boundary it concerns, including the real host or user-facing path when it matters. Use independent review for high-impact or trust-boundary changes. Report the result, checks and unresolved limits.
