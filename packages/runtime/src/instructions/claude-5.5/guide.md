# Prompting guide: Claude 5.5

Every point of Anthropic's prompting guidance for Claude models that bears on instruction text, with the page and section it comes from. A translation of `requirements/` into `claude-5.5/` follows this guide: apply each point that fits the file, and treat the points marked API or harness as outside instruction text.

## Pages

| Label | Page                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| BP    | Prompting best practices: `platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices` |
| S55   | Prompting Claude Sonnet 5.5: `platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5`  |
| O55   | Prompting Claude Opus 5.5: `platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5`      |
| H55   | Prompting Claude Haiku 5.5: `platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5`    |
| SK    | Skill authoring best practices: `platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices`                   |

The tag after a rule of `skills/instruction-writing/SKILL.md` names its page the same way, with S5 and O5 for the Sonnet 5 and Opus 5 pages and a cited author for a study.

## Points

### A. General principles (BP)

- G1 (BP: Be clear and direct): Be explicit and specific about output and constraints. If you want more than the minimum, ask for it.
- G2 (BP: Be clear and direct): Colleague test: if a minimally briefed colleague would be confused, Claude will be too.
- G3 (BP: Be clear and direct): Use numbered steps when order or completeness matters.
- G4 (BP: Add context): Give the reason or motivation behind a rule so Claude can generalize.
- G5 (BP: Use examples effectively): Examples are the most reliable steer. Make them relevant, diverse and structured in `<example>` tags, 3-5 of them.
- G6 (BP: Use examples effectively): Ask Claude to evaluate or generate examples.
- G7 (BP: Structure prompts with XML tags): XML tags separate instructions, context, examples and inputs. Use consistent, descriptive names and nest them.
- G8 (BP: Give Claude a role): Give a role, even one sentence, in the system prompt.
- G9 (BP: Long context prompting): Put long inputs (20k+ tokens) at the top and the query at the end.
- G10 (BP: Long context prompting): Wrap multiple documents in document/source/content tags.
- G11 (BP: Long context prompting): For long documents, ask for relevant quotes first.
- G12 (BP: Model self-knowledge): State the model's identity and model string if the app needs them.

### B. Output and formatting (BP)

- G13 (BP: Communication style and verbosity): Expect concise output. Ask explicitly for a summary after tool use if you want one. Opus 5 runs longer, and effort does not control its length, so prompt for conciseness.
- G14 (BP: Control the format of responses): Tell Claude what to do, not what not to do.
- G15 (BP: Control the format of responses): Use XML format indicators.
- G16 (BP: Control the format of responses): Match the prompt's style to the desired output. Markdown in the prompt produces markdown in the reply.
- G17 (BP: Control the format of responses): Give detailed formatting guidance when needed (prose over bullets, a `<avoid_excessive_markdown…>` block).
- G18 (BP: LaTeX output): LaTeX is the default for math. Instruct plain text if you do not want it.
- G19 (BP: Document creation): Document creation: ask for design elements explicitly.
- G20 (BP: Migrating away from prefilled responses): Prefill on the last assistant turn is unsupported from 4.6. Use structured outputs or direct instructions, move continuations to the user turn, and inject reminders into the user turn. [API or harness advice, outside instruction text]

### C. Tool use (BP)

- G21 (BP: Tool usage): Say "do X", not "can you suggest X", or Claude only suggests.
- G22 (BP: Tool usage): Use `<default_to_action>` or `<do_not_act_before_instructions>` to set the default posture.
- G23 (BP: Tool usage (Opus 4.5/4.6)): Soften aggressive tool language ("CRITICAL: You MUST") to "Use this tool when…".
- G24 (BP: Optimize parallel tool calling): Run independent tool calls in parallel and dependent calls in order. Never guess parameters.

### D. Thinking and reasoning (BP)

- G25 (BP: Overthinking and excessive thoroughness): Replace blanket defaults with targeted ones ("Use X when it would enhance…"). Do not write "If in doubt, use X".
- G26 (BP: Overthinking): Commit to an approach and avoid revisiting decisions without new information.
- G27 (BP: Overthinking): Effort is the fallback control for over-aggressiveness. Lower effort reduces thinking.
- G28 (BP: Leverage thinking): Adaptive thinking is steerable. Add a "think only when it helps" line for over-thinking, and a reflect-after-tool-results line.
- G29 (BP: Leverage thinking): Select response blocks by `type`. Leave room in `max_tokens` for thinking.
- G30 (BP: Leverage thinking): Prefer general instructions ("think thoroughly") over prescriptive steps.
- G31 (BP: Leverage thinking): Multishot examples work with thinking (problem, method, answer).
- G32 (BP: Leverage thinking, "Keep reasoning in thinking blocks"): Manual CoT is only a fallback with thinking off. On Sonnet 5.5, Opus 5 and 5.5, and Fable, do not ask for reasoning in the reply, because it may be declined.
- G33 (BP: Leverage thinking): Ask for a self-check ("Before you finish, verify…"). Remove it on Opus 5, where it causes over-verification.
- G34 (BP: Leverage thinking): Opus 4.5 is sensitive to the word "think" when thinking is off. Use "consider" or "evaluate".

### E. Agentic systems (BP)

- G35 (BP: Context awareness and multiwindow workflows): Tell the agent that context is compacted or saved, so it does not stop early.
- G36 (BP: Workflows across multiple context windows): Multiwindow workflow: a different first-window prompt, structured tests (`tests.json`), setup scripts (`init.sh`), start fresh or compact, prescriptive start steps, verification tools, use the full context. [API or harness advice, outside instruction text]
- G37 (BP: State management best practices): State: JSON for structured data, text for progress notes, git for checkpoints, incremental progress.
- G38 (BP: Balancing autonomy and safety): Confirm before destructive, hard-to-reverse or externally visible actions. Do not bypass checks.
- G39 (BP: Research and information gathering): Research: state success criteria, verify across sources, hold competing hypotheses and confidence notes.
- G40 (BP: Subagent orchestration): Subagents are orchestrated natively. Define subagent tools, and add guidance on when they are and are not warranted.
- G41 (BP: Chain complex prompts): Chain prompts only to inspect intermediate outputs (draft, review, refine).
- G42 (BP: Reduce file creation): Ask for cleanup of temporary files.
- G43 (BP: Overeagerness): Constrain over-engineering: scope, docs, defensive code and abstractions.
- G44 (BP: Avoid focusing on passing tests): Write general solutions, not test-fitting ones. Report infeasible tasks or wrong tests.
- G45 (BP: Minimizing hallucinations): Investigate before answering. Never speculate about unopened code.

### F. Capability-specific and migration (BP)

- G46 (BP: Improved vision): Give image tasks a crop or zoom tool.
- G47 (BP: Frontend design; O55: Frontend design defaults): Name the specific styles to avoid in frontend design.
- G48 (BP: Medication dosing): Medication dosing block (a domain-specific snippet for apps that answer dose questions). [product-specific snippet]
- G49 (BP: Migration considerations, items 1-3 and 6): Migration: be specific, add quality modifiers, request features explicitly, and drop anti-laziness prompting (4.6 over-triggers).
- G50 (BP: Migration considerations, item 7): Keep history append-only and pass thinking blocks back unchanged. [API or harness advice, outside instruction text]
- G51 (H55 intro, O55 Unattended agentic runs): Do not change the system prompt or tools mid-conversation. Put new instructions in the newest turn. [API or harness advice, outside instruction text]

### G. Model pages (S55, O55, H55)

- G52 (S55 Calibrate effort, O55 Calibrate effort, H55 Use effort): Effort is the main control for thinking. Do not carry a setting between models. Reserve xhigh and max for measured gains. "Think less" does not reliably work.
- G53 (S55 Steer initiative and scope, H55 Prevent early stopping): Carry-through paragraph ("Keep working until everything … done, stop only when blocked or before a risky step") plus the report-and-stop paragraph with no unrequested additions.
- G54 (S55 Steer initiative and scope): At xhigh and max, say not to start extra review rounds or launch reviewer subagents.
- G55 (S55 Steer initiative and scope): For ideas or plans, give them and stop.
- G56 (S55 Reasoning tasks with JSON output, H55 adaptive thinking with JSON and tools): Reasoning tasks with JSON output: "Think the problem through…" line, adaptive thinking, parse the last JSON value. [API or harness advice, outside instruction text]
- G57 (S55 and O55 User-facing progress updates): Progress updates: remove "hold findings for the final response". State update points. Give a message tool for verbatim content.
- G58 (S55 Tool use in chat; H55 Accurate search results (give the current date, and avoid blanket "always search" rules)): Tool use in chat: remove tool-discouraging text. Use a search tool for facts that may have changed, even when sure.
- G59 (S55 and H55 Mid-turn user messages): Mid-turn user messages: never put user text in a `tool_result`. Deliver it as a user turn, with harness notices in a separate message.
- G60 (S55 Verification on coding tasks, H55 Tell coding agents to verify): Verification paragraph: a real check, not syntax-only. Install declared dependencies from the lockfile without sudo. Name any check not run.
- G61 (S55 Tolerant tool-call handling): Handle tool-name case errors by accepting or by `is_error` with the expected name. [API or harness advice, outside instruction text]
- G62 (S55, O55 and H55 Safeguard refusals): Safeguard refusals: remove "write your reasoning in the reply" instructions. Ask for a short explanation or action summary.
- G63 (O55 matching headings): Opus 5.5 only: unattended-run end-of-turn paragraph and checklist, explore-context-in-multiapp line, time signals for multiagent harnesses, remove "think carefully" in chat, treat answered questions as done, mark pasted text with `<pasted_content id>` tags.
- G64 (H55): Haiku 5.5 only: keep chatbots to their system prompt ("The rules … hold for the whole conversation"), and keep reasoning out of user-facing text (use adaptive thinking at medium effort). [API or harness advice, outside instruction text]

### H. Skill authoring (SK)

- G65 (SK: Concise is key): Be concise. Assume Claude is smart, and justify each paragraph's token cost.
- G66 (SK: Set appropriate degrees of freedom): Match freedom to fragility: high, medium or low.
- G67 (SK: Test with all models): Test the skill on every model it will be used with.
- G68 (SK: Skill structure, Naming conventions): Frontmatter limits: name at most 64 characters, lowercase, digits and hyphens, no reserved words. Description at most 1,024 characters, no XML tags, covering what the skill does and when to use it. Naming: prefer gerunds, avoid vague names.
- G69 (SK: Writing effective descriptions): Write the description in third person with specific triggers.
- G70 (SK: Progressive disclosure patterns): SKILL.md body under 500 lines. Split into files. Keep references one level deep. Add a table of contents to reference files over 100 lines.
- G71 (SK: Workflows and feedback loops): Workflows: sequential steps, copyable checklists, validate-fix-repeat feedback loops.
- G72 (SK: Content guidelines): Avoid time-sensitive information, and use consistent terminology.
- G73 (SK: Common patterns): Templates (strict or flexible), input/output examples, conditional workflows.
- G74 (SK: Evaluation and iteration): Build evaluations first: find gaps, write three scenarios, set a baseline, write minimal instructions, iterate.

## Rules of the instruction-writing skill

The thirteen bullets of `skills/instruction-writing/SKILL.md`, in file order, with the points they apply. A rule with no counterpart in Anthropic's pages is a HolyAgent convention.

- Rule 1, US English and terse (G65): the terseness part matches the guidance; US English is a HolyAgent convention.
- Rule 2, write each model's set from `requirements/` (no point): a HolyAgent convention.
- Rule 3, one file per prompt section (G70 in part): a HolyAgent convention.
- Rule 4, the full task with reasons, positive phrasing and scoped rules (G1, G4, G14; S5 by inference).
- Rule 5, calm imperatives and concrete thresholds (G23, G25, G49).
- Rule 6, effort through the route (G27, G52).
- Rule 7, a short explanation, not the reasoning (G32, G62).
- Rule 8, a real check before done (G33, G60).
- Rule 9, no text that discourages tool use, and look up changed facts (G58).
- Rule 10, when to delegate and parallel calls (G24, G40).
- Rule 11, outside text as data (G63).
- Rule 12, tags or headings, long inputs first, three to five examples (G5, G7, G9).
- Rule 13, context files (no point): Gloaguen et al., arXiv 2602.11988, a study and not an Anthropic page.

## Gaps

- Not read: the Prompting Claude Opus 5 and Fable 5.1 pages, "Keep reasoning in thinking blocks", the Claude Code subagent and tool-description pages, and the runtime-environment sections of the skill authoring page.
- The best-practices page says to re-check model-specific measurements on your own evaluations before applying them to another model.
