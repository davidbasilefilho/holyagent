# Prompting guide: GPT-6.2

Translate the shared `requirements/` into this family's instructions. This set applies to GPT-6.2 Sol and Astra. The [GPT-6 guide](../gpt-6/guide.md) covers GPT-6 and GPT-6.1. Keep the requirements and host contracts ahead of the guidance here.

## OpenAI sources

- C1: [Prompting GPT-6.2 in Codex](https://learn.chatgpt.com/guides/prompting-gpt-6-2-astra). The techniques apply to both Astra and Sol.
- C2: [Models in Codex](https://learn.chatgpt.com/docs/models). The model list identifies `gpt-6.2-sol` and `gpt-6.2-astra`. Availability depends on the host and account.
- A1: [Using GPT-6.2](https://developers.openai.com/api/docs/guides/latest-model). The prompting advice below applies to model-facing text. API parameters and request semantics are a separate concern.

## Writing prompts

1. **Give the result and the acceptance bar** (C1, “Match reasoning effort to the task”; A1, “Task completion”). Say what the reviewer will check, which constraints matter, and where the agent needs to be thorough. Describe the task in project terms, then leave implementation choices to the specialist unless the order or method matters.
2. **Define when to act and when to ask** (A1, “Task completion”). GPT-6.2 Astra may offer a next step and wait when intent is unclear. Have it make reasonable, reversible assumptions and finish authorized work. Name decisions the user must own. In HolyAgent, a clarification about an active task updates that task; it does not create a separate task or reopen an unrelated one. A changed action still needs authorization where the rules reserve it.
3. **Use the effort setting and parallelize independent work** (C1, “Match reasoning effort to the task” and “Use subagents for parallel work”). Raise effort when the investigation crosses several systems or must account for interacting causes, even if the report will be short. Within HolyAgent, route by task and leave effort out of Assignment prose. Dispatch independent work together when useful, keeping ownership and verification separate. Codex's Ultra and built-in subagent behavior do not describe HolyAgent's Pi or T3 hosts.
4. **Describe project conventions and compatibility** (A1, “Coding style”). Name constraints the model cannot discover, reuse existing patterns where they fit, and preserve callers' behavior outside the requested changes. Add tests when required or when an existing check would miss a specific regression; use the repository's gates.
5. **Write for the reader** (A1, “Writing style”). Astra tends to be more concise by default. Give the audience and desired shape rather than repeating generic concision reminders. Keep technical terms that make the result precise. Preserve exact evidence, repository conventions and author wording outside the editing scope. The final answer should stand on its own without progress updates, internal shorthand or Assignment labels unless a report contract calls for them.
6. **Use a visual reference and inspect the result at use size** (C1, “Give Codex a visual reference and room to iterate”; A1, “Frontend design”). Name the composition, imagery or typography that matters. Compare the actual render against the reference at the target size and exercise the requested interactions. HolyAgent also verifies spacing, alignment and states against its design checklist; those are house requirements, not model guarantees.
7. **Keep repository and skill context lean** (C1, “Keep your `AGENTS.md` lean”). Give conventions that code, tests and docs cannot supply. Load task-specific sections when relevant. On shared machines, bound concurrent resource-heavy jobs and stop only the background jobs you started, following the project's ownership and handoff rules.

## Integration notes

OpenAI documents Responses API changes in A1, “What's new”: prefix edits and certain request changes can discard prior reasoning, and top-level `instructions` are positioned after `input` on GPT-6.2. When directly integrating the documented API, keep reusable developer instructions in the stable input prefix and use the top-level field for request-specific instructions. These are API behaviors, not prompt instructions or proof that a Codex OAuth, Pi or T3 path exposes the same knobs. Verify host capabilities before changing transport or caching behavior.

Use host tools by their function without assuming a particular API feature. Keep approval, ownership, evidence and state rules from `requirements/`; the OpenAI examples do not override them.
