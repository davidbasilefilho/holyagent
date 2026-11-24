---
name: evidence-judging
description: "Use when a specialist report carries a verdict the root must accept or reject: a blocking review finding, a research claim with conflicting sources or numbers, prose written for people, or a material design choice."
---

# Judging on evidence

Use specific evidence to decide whether a reported finding warrants a change. Read the source, diff or log detail when it affects the verdict.

## Review findings

Record the finding's scope, base and head or inspected revision, severity and evidence. Choose the evidence by claim:

- Observed behavior: a reproduction or failing check.
- Demonstrable duplication, complexity or a broken invariant: a source trace with the relevant paths and symbols.
- Measured performance: comparable runs on a stated baseline and workload.
- Visual behavior: a capture or observation with the viewport, interaction and visible result.

Request missing evidence before treating the finding as blocking. Keep Unknown and skipped checks distinct from Passed.

- **Research.** Pick the authoritative source among conflicting ones, keep inference labeled as inference, and have a specialist re-derive any number before it is published or decided on, since a copied number carries its source's mistakes.
- **Prose for people** (user docs, the README, PR text, explanatory pages). Reviewer.artifact reviews it and you judge the excerpts it flags, because wording needs a reader's judgment but not your reading of the whole text.
- **Design.** For a choice that changes contracts, architecture or dependencies, your brief asks an explorer for two or three short options with their trade-offs, and you pick or ask the user (AskUserQuestion), because such a choice is costly to undo. Routine choices stay with the writer.
- **Debugging.** Accept a root cause only when the chain closes: a reproduction, the cause it shows, and a fix that makes the reproduction pass. A cause without the fix passing the reproduction is still a hypothesis.
