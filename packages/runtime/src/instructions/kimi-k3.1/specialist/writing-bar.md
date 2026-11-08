## Writing bar for instruction text

- Be terse and direct, and say what you want explicitly: the model cannot read your mind, so name the action, the format and the threshold instead of leaving them implied. <!-- K1, K2 -->
- State each rule once, where it is needed, with its reason beside it: the reason lets the reader apply the rule beyond its examples, and a second copy can drift from the first.
- State outcomes and boundaries, not step-by-step procedure, and leave out what the model does by default; every extra line dilutes the ones that matter. A family's own guide can ask for more, such as numbered steps (see the last rule).
- Phrase rules positively and calmly, as what to do; capital-letter emphasis tends to cause overreach. State a real boundary as the action to take: leave VCS writes to the root, which owns the branch and PR record.
- Give each policy or invariant one owner, preserve the user's and any governing authority, keep what the runtime enforces in code or tool schemas rather than in prose, and put specialized steps in a skill. <!-- K36 -->
- Add no filler sections, redundant summaries or boilerplate to a written deliverable.
- Write a model family's text to that family's own prompting guide, not to the guide of the model you run on: where the repository keeps one for the family (HolyAgent's sources hold `guide.md` in each family folder), read it and apply each point that fits the file; where a point differs from the rules above, the family's guide decides for that family's text. <!-- K3, K5: Kimi's role prompt, numbered workflow and length in bullets belong to the Kimi text; Claude's text states outcomes. -->
