---
name: visual-judging
description: "Use before the first Worker.visual or Reviewer.visual dispatch, and when rendered work (a web page, terminal UI, desktop or mobile screen) is accepted, repaired or explained visually."
---

# Judging visual work

Judge rendered work from what renders, not from a passing build or a report's claims.

## Pick the platform skill

- Pick the platform design skill for the work before the first Worker.visual or Reviewer.visual dispatch: `web-design`, `mobile-design`, `desktop-design` or `tui-design`, one for each platform of a multi-platform project.
- Name each skill's file in the criteria of both specialists by its literal absolute path, `guidance/<family>/<name>/SKILL.md` under the package folder, with a blocking criterion to read it and to build and inspect (Worker.visual) or judge (Reviewer.visual) against its checklist and capture list. A specialist starts with no context, so the brief carries the path and the criterion.
- Start the render target first, per platform (the `dev-server` skill).

The platform skill is the only design guidance the two specialists get: the shared core (direction before code, the plan, copy, the quality floor), the platform rules, the refuse list and the capture checklist.

## Accept

Your own final pass, after Worker.visual and Reviewer.visual, decides acceptance:

- Read the final captures Reviewer.visual lists, at each size and variant the criteria and the skill's capture checklist name, against that skill's checklist (read its file), and accept only when they pass.
- Check the spacing rules of the design core on those captures as well: padding inside every container, a gap around every block, shared column edges and no line starting with closing punctuation. Accept only when neither the worker's report of places that still touch nor the reviewer's observations name a place where content touches a rule, border or edge, and treat a worker report that neither names such places nor says none remain, or a reviewer report without the comparison, as incomplete. <!-- O26 -->
- Treat Reviewer.visual's observations (viewport, interaction and visible result for each) as input to the decision, not as the decision. A Worker.visual report alone, or an inspection reported as blocked, accepts nothing.
- Keep the pass to those final captures: open none from an earlier round and take none yourself. For a missing size or variant, or a web page that Reviewer.visual inspected live and for which Worker.visual saved no captures, have Worker.visual or Worker.operations save the final captures at the listed sizes and variants, which Reviewer.visual then lists. Judge nothing you cannot see.
- A material finding of your pass starts a repair like any other, whether or not the reviewer reported it; say in the final report when your pass overruled the reviewer.

Read an image in the main thread only to show it to the user (a path is not delivery) or to settle a concrete doubt about that evidence, besides the final pass; Reviewer.visual and Worker.visual hand over captures and paths so that you do not have to.

## Material discrepancies

<!-- materiality -->

A departure from the platform skill's direction rules that has none of these effects is preference too. The project's design system and the user's explicit requirements outrank taste.

## Repair

Repair a material finding without asking when the repair keeps the user's requirements and needs no choice between fixes; otherwise ask through the structured question tool with a recommended default. Run the repair to a clean inspection: <!-- O3, O7 -->

- Dispatch Worker.visual with the findings as criteria and say "round N of 3" in the brief, then Reviewer.visual to re-inspect only what the repair touched, until the inspection is clean; then repeat your final pass on the captures that changed.
- Allow at most three rounds per finding, counted across Worker.visual dispatches; after three, report the finding as a blocker.
- Name each skipped preference in the final report, without a fix.

## Explanatory pages

When a visual explanation or chart carries what prose cannot, build one self-contained HTML page. Such a page illustrates and does not validate a software interface. If the host offers an HTML preview or render tool, use it to check the page as an image with its console output and to show the finished page inline. Without one, save the page as a file, check it as far as the environment allows and give the user its path, naming what you could not check.
