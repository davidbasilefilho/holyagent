# Writing skill text that works on every supported family

The supported families each have a `guide.md` (`packages/runtime/src/instructions/<family>/guide.md`) drawn from the vendor's prompting pages: Claude 5.5 and Kimi K3.1. A distributed skill is read by each family's model, so its text follows the points both guides share and, where they differ, a form that satisfies both. A point below applies to skill text only; API parameters and harness contracts stay out of skills.

Sources (fetched 2026-11-07):

- Claude: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices, and under the same path `prompting-claude-sonnet-5-5`, `prompting-claude-opus-5-5`, `prompting-claude-haiku-5-5`
- Claude skills: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Kimi: https://platform.kimi.ai/docs/guide/prompt-best-practice, https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart, https://platform.kimi.ai/docs/guide/use-kimi-k3-to-setup-agent, https://platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice

Contents: shared points, where the guides differ, what stays out of skill text.

## Shared points (both guides)

- Be explicit and complete. State the task, constraints and context a colleague with no background would need; the less the model guesses, the better the result. (Claude: G1, G2; Kimi: K1, K2)
- Give the reason beside each rule so the model can apply it beyond the example. (Claude: G4)
- Separate parts with delimiters: headings for sections, XML tags (`<example>`, `<input>`) for inputs and examples, consistent names. (Claude: G7; Kimi: K4)
- Use numbered steps when order or completeness matters. (Claude: G3; Kimi: K5)
- Show examples of the output you want, relevant and varied, usually three to five; give general guidance first, because it is more efficient than listing every permutation. (Claude: G5; Kimi: K6)
- Give a role in one sentence only when the skill needs one. (Claude: G8; Kimi: K3)
- Ground answers in supplied material and give the fallback when it is absent: tell the model to read the named file or source first, to say what is missing, and not to guess about content it has not opened. (Claude: G45; Kimi: K8)
- Break a large task into stages, and load only the instructions the current case needs: one skill per task class, details in references. (Kimi: K9, K25; Claude and the standard: G70)
- Keep prose on role, workflow and boundaries; leave argument details to the tool's own schema and do not restate tool behavior. Where a rule is a hard constraint, say it once, as a boundary. (Kimi: K28, K36; Claude: G23)
- Add constraints in small steps as format, compliance or audience change, instead of one long list written up front. (Kimi: K29; Claude: G74)
- Name independent calls to run together and dependent ones in order; return a failed call's error and continue the others. (Claude: G24; Kimi: K34)
- Keep the tool set the skill needs small and non-overlapping: name the one tool or command for a job. (Kimi: K37)
- Set thinking effort through the route or harness, never through prose such as "think harder" or "think less". (Claude: G27, G52; Kimi: K13)
- Ask for a short explanation or summary of actions in the reply, never the step-by-step reasoning: both models think separately, and Claude may decline to restate it. (Claude: G32, G62; Kimi: K17)
- Require a real check before "done" and have the reader report any check it did not run; treat a truncated or failed result as failure, not as the answer. (Claude: G33, G60; Kimi: K33)
- Keep prose terse and calm. (Claude: G13, G23, G65; Kimi: K1)

## Where the guides differ, and the text that satisfies both

| Topic             | Claude                                                                             | Kimi                                                                 | Write                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Length            | Concise by default; ask explicitly for a summary (G13)                             | A word count is imprecise; counts of paragraphs or bullets work (K7) | State length as a number of bullets or paragraphs, or as "one line per item"       |
| Tone              | Calm imperative; capitals and "if in doubt" push the model to overreach (G23, G25) | Silent                                                               | Calm imperative, a concrete threshold in place of "important"                      |
| Positive phrasing | Say what to do, not what to avoid (G14)                                            | Silent                                                               | State the action; keep a real boundary as the action to take                       |
| Delimiters        | XML tags, nested, descriptive names (G7, G15)                                      | Triple quotes, XML tags or headings (K4)                             | Headings for sections, XML tags for inputs and examples; no triple-quote fences    |
| Role              | A system-prompt sentence (G8)                                                      | A system-message role (K3)                                           | One sentence inside the skill's first paragraph, and only when it changes behavior |
| Style match       | Markdown in the prompt produces markdown in the reply (G16)                        | Show the format you want (K1)                                        | Write the skill in the style of the output wanted, and show one sample             |
| Forcing a lookup  | Ask directly ("search for X") (G21)                                                | `tool_choice: required` on the first turn (K21, K42)                 | Make the lookup the first numbered step, with its reason                           |
| Long input        | Long inputs first, the question last (G9)                                          | Chunk, summarize, then summarize the summaries (K11)                 | Put the long material in a reference file and name what to extract from it         |
| Checking          | A self-check line helps; one model over-verifies if it is repeated (G33)           | Cap tool rounds; check results (K32, K33)                            | Name the single check that proves done, once                                       |

## Stays out of skill text

- Request parameters, `tool_choice` values, prefill, caching and message-history contracts: the harness owns them per family.
- Words that tie a skill to one family's quirks (a model name, a thinking-mode name). A rule that holds for one family only goes into that family's copy of the skill, written from the requirements.
- Instructions for the model to restate its reasoning, or to hold findings until the end.
