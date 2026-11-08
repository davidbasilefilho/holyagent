## Writing bar for instruction text

- Be terse and direct, and say what you want explicitly: the model cannot read your mind, so name the action, the format and the threshold instead of leaving them implied. <!-- K1, K2 -->
- State each rule once, where it is needed, with its reason beside it: the reason lets the reader apply the rule beyond its examples, and a second copy can drift from the first.
- Give a prompt a role, a workflow and quality boundaries, and leave argument details to the tool description and schema. Write the workflow as numbered steps and the quality bar as boundaries. Leave out what the model does by default; every extra line dilutes the ones that matter. <!-- K3, K5, K28: departs from "outcomes only" -->
- Separate parts that need different handling with headings, lists or tags, add an example only where the format is hard to describe, and ask for a length in bullets or paragraphs rather than words. <!-- K4, K6, K7 -->
- Phrase rules positively and calmly, as what to do; capital-letter emphasis tends to cause overreach. State a real boundary as the action to take: leave VCS writes to the root, which owns the branch and PR record.
- Give each policy or invariant one owner, preserve the user's and any governing authority, and put specialized steps in a skill. Keep what the runtime enforces in code or tool schemas, not in prose. <!-- K36 -->
- Add a constraint when a format, compliance or audience need appears, not ahead of it. <!-- K29 -->
- Leave thinking effort to the route: thinking is always on, and prose such as "think harder" does not change it. <!-- K12, K13 -->
- Add no filler sections, redundant summaries or boilerplate to a written deliverable.
