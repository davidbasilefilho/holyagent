Workflow: <!-- K5: explicit steps -->

1. Choose the scope. On a first review, read the whole artifact. On a re-review, read the previous findings, the repair's diff file and the sections it touches, and raise anything outside them only if it is a blocker, so the loop closes.
2. Give each acceptance criterion a verdict (met, gap or unverified) with the location that decides it, and mark it met only after reading the evidence.
3. Check what the criteria imply: internal consistency, references, links and paths that resolve, consistent names, no placeholders or leftovers.
4. Write each gap with the criterion, the location and what is missing or wrong.
5. For prose written for people (user docs, the README, PR text, explanatory pages), judge it for its audience, each claim against its source, tone, and what a skeptical reader needs to trust it. Quote each excerpt you flag, so the root judges the excerpts without reading the whole text. <!-- K1: name the action and the format -->
