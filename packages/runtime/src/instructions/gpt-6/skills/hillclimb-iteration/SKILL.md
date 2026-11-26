---
name: hillclimb-iteration
description: "Use when a task asks for iterative improvement. Run comparable trials and retain improvements backed by evidence."
---

# Hillclimb iteration

State a testable hypothesis before measuring.

Define the result, one primary metric or a clear qualitative criterion, and the smallest gain worth keeping. Set applicable correctness, security and accessibility guardrails before trying changes.

1. Capture the smallest reproducible baseline. Record the starting state, method, inputs and result. Repeat noisy runs to learn their normal variation. Preserve the original baseline.
2. Test the hypothesis with the smallest reversible change. Vary one factor where that makes the cause easier to distinguish.
3. Run the same checks under the same conditions and check the guardrails. Compare with the best verified result. Keep a meaningful improvement only when the evidence supports it. Undo only the rejected trial and preserve unrelated work.

Continue useful trials within the authorized scope. Stop at the target, when plausible trials show no meaningful gain, when the evidence cannot settle the comparison, or when proceeding needs a material user decision or approval. Report the baseline, best verified result, change, uncertainty and any open decision.

For visual work, compare equivalent before and after captures at the same viewport, state and interaction input. Inspect contrast, alignment, readability and applicable accessibility or interaction. Explain the material visual judgment. A pixel difference alone does not establish improvement. For an original visual, the brief and design criteria can supply the target without a reference image.

Use `visual-judging` for acceptance and the relevant platform design skill for its checklist. Where available, use `dev-server` for the shared render target, `performance-iteration` for controlled measurement and `evidence-judging` for reviewing findings.

Scale the checks to the change. Use representative scenarios at the real entry point for both revisions, record versions and conditions, and separate installation from use. For defensive and operational improvements, use isolated, harmless fixtures and verify normal behavior, safe failure and recovery without weakening authorization or losing state. Exercise the actual user or developer flow for UI, UX or DX as well as the relevant visual and accessibility checks.

## Examples

- **Visual:** Match the keyboard-focused state of an original settings screen before and after changing one text color. Keep the trial if the contrast improves, the label is easier to read, and its alignment and focus remain intact.
- **Nonvisual:** Time a fixed compiler workload over repeatable runs. Keep a faster trial only if diagnostics and output still match the baseline.
- **Operational:** Run setup in an isolated profile with a required feature disabled. Verify that the error explains the blocker without partial writes. Restore the prerequisite in the fixture and use the capability, then repeat setup to check it does not duplicate or erase state.
