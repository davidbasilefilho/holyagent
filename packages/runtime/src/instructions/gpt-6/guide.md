# Prompting guide: GPT-6

Every point of OpenAI's prompting guidance for the GPT-6 family, and of the prompts Codex ships for it, that bears on instruction text, with the page and section it comes from. A translation of `requirements/` into this family's folder follows this guide: apply each point that fits the file, and treat the points tagged PARAM or LOOP as the integration's concern unless a file's requirement names them.

Tags: PARAM is a request parameter or API-contract rule, PROMPT is prompt-writing guidance, LOOP is agent-loop, tool or harness guidance. A source is a page and a section heading, since the pages give no anchors. A point marked inference is the reader's conclusion and not OpenAI's statement.

## One family

OpenAI publishes one prompting section for the whole family, written from observations of GPT-6 Astra and offered "as a starting point across the GPT-6 model family" to be evaluated on the chosen model and workload (P1, "Prompting best practices"). The models are `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra` and `gpt-6-luna`; the one set therefore serves the root on GPT-6.1 Sol and the specialists on GPT-6.1 Terra and GPT-6 Luna. The differences the pages state concern request parameters (O25), not prompt-writing rules. The only prompting hint is that guidance written for Sol or Luna may overconstrain Astra and that smaller models may need more scaffolding (O2). No page says what changed from GPT-6 to GPT-6.1 in prompting terms.

## Pages

| Label | Page                                                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | Using the latest model, "Prompting best practices": `developers.openai.com/api/docs/guides/latest-model`                                                                   |
| P2    | Rethinking skills and prompts for GPT-6 Astra: `developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra`                                                  |
| P3    | A practical guide to building with GPT-6: `openai.com/index/practical-guide-building-gpt-6/`                                                                               |
| P4    | Codex GPT-6 prompt text, the `instructions_template` of `gpt-6-astra` and `gpt-6.1-sol`: `raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json` |
| P5    | Codex's earlier generic prompt, not a GPT-6 prompt: `raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/prompt.md`                                        |
| P6    | Model pages: `developers.openai.com/api/docs/models/gpt-6.1-sol`, `.../gpt-6.1-terra` and `.../gpt-6-luna`                                                                 |
| M1    | The maintainer's observation of pages that GPT models built, not an OpenAI page: "gpt models always mess up padding and spacing in some places"                            |

## Points

### Assignments and boundaries

- O1 (P3, PROMPT): Give the model a clear assignment: the result, who it is for, the context, the constraints and what counts as done. Overly specific guidance "can now hinder results where it previously helped". Section "Give the model a clear assignment".
- O2 (P2, PROMPT): Skills and prompts should not be elaborate itineraries or recipes. State the outcome and the boundaries. Guidance that helps Sol or Luna may overconstrain Astra, and smaller models may need more scaffolding. Section "Better skills". Keeping one step list only where the order decides the result is this family's inference from that, not a statement of the page.
- O3 (P2, P3, PROMPT): Replace "always ask" rules with explicit decision boundaries: say what the model decides, what it settles by looking, and what stays with the user and why. Section "Decision boundaries".
- O4 (P1, PROMPT): Make a bias to action the baseline: infer the intent and persist until the goal is complete. Treat "can you...", "help me..." and "I want to..." as instructions to act, and do not stop at a plan, an offer or a partial result that is merely helpful enough. Section "Initiative and follow-through".
- O5 (P1, P4, PROMPT): Proceed without asking on reversible, read-only, review and fix work. Section "Initiative and follow-through" (P1); "Autonomy and persistence" (P4).
- O6 (P1, P4, PROMPT): For deploys, PR merges, external writes and publishing, finish the authorized work first, so that approval is the last step on a concrete result. Authorization persists across turns. Leave out unsolicited warnings, disclaimers, approval flows and safety or compliance checklists written for a hypothetical risk. Section "Initiative and follow-through" (P1); "Autonomy and persistence" (P4).
- O7 (P2, P3, PROMPT): Define "done" in the prompt: implement, run, inspect and fix failures. A "stop for review after the first implementation" rule pulls the model to stop early, and the prompt says where exploration should stop. Section "Persistence" (P2).
- O8 (P1, P4, PROMPT): User instructions outrank skills. Astra "can be more sensitive" to `AGENTS.md` and skills, and conflicting guidance can make it pause, so audit the text for conflicts. When a skill causes a pause, the model names the `SKILL.md` file, quotes the line and explains. Section "Initiative and follow-through" (P1); "When to ask the user for permission" (P4).

### Output and writing

- O9 (P1, PROMPT): Astra defaults to lists, tables and Markdown. State the structure you want: clear paragraphs, with lists only for parallel or sequential items. Section "Personality and writing style".
- O10 (P1, PROMPT): Ask for plain language, the active voice and the main point first. Section "Personality and writing style".
- O11 (P1, PROMPT): Ban stock phrases ("delve", "leverage", "Bottom Line:") and contrastive "X, not Y" framing, by listing them. Section "Personality and writing style".
- O12 (P3, PROMPT): Specify the final report: what changed, what was checked and what still needs attention. Section "Define the output you need".
- O13 (P4, PROMPT): Lead with the outcome. Summarize routine verification and leave out a list of every check. Write PR descriptions for a reviewer who has not seen the conversation. Link files by absolute path and put a blank line before a list so CommonMark renders it. Sections "Writing style" and "Technical communication".

### Testing and context files

- O14 (P1, PROMPT): Astra over-tests small tasks. Do not write tests that mirror the implementation for a low-impact change; run the checks the change needs and broaden only when new changes, failures or open concerns justify it. Section "Testing and verification".
- O15 (P2, PROMPT): Earlier models needed prodding to test and Astra does not, so remove "always test" lines. In `AGENTS.md` make pointers to documents contextual and never demand "read X, Y and Z before every edit", and authorize safe routine workflows such as local tests on disposable data. Section "Up-to-date AGENTS.md".
- O16 (P2, PROMPT): Write a skill description as short as it can be while saying when to use the skill ("Use when adding or changing a migration, or reviewing its rollout"). Disclose progressively: a minimal router at the root and supporting documents loaded on demand. Section "Better skills".
- O17 (P5, LOOP): An `AGENTS.md` governs the directory tree it sits in. Obey every file whose scope covers a touched file, the nearer file wins, direct system, developer and user instructions beat it, and the files from the root to the working directory are preloaded. Section "AGENTS.md spec". This is the earlier Codex prompt; the rule is stable across Codex prompts, by inference.

### Delegation, tools and the loop

- O18 (P1, PROMPT): Astra "may delegate less often than desired", so say when and how much to delegate. OpenAI's prompt tells the model to delegate when work can run in parallel and doing so saves time or improves quality. Messages between agents need proper spacing and stay legible, since a person may read them. Section "Subagent delegation".
- O19 (P4, LOOP): Prefer `rg` and `rg --files` for search. Batch independent reads and searches in parallel and keep dependent steps in order. Do not chain shell commands with echo separators. Avoid blocking waits over 60 seconds. Treat shell text as code and quote it properly. Section "Rules for getting work done".
- O20 (P4, LOOP): Do not message third parties (Slack, email) without an explicit instruction. Section "When to ask the user for permission".
- O21 (P4, PROMPT): Questions to the user: bundle them and prefer multiple choice; wait about 60 seconds on an optional clarification and then proceed with a stated assumption; never treat elapsed time as approval for a required decision. Section "Working with the user".
- O22 (P4, LOOP): Compaction does not end the task: continue from the summary and do not redo finished work. The newest user message steers the active task and replaces it only when it clearly cancels it. Codex also keeps `notes` and `history` for the context window (the template's `token_budget` entry). The research names no section for the compaction and steering rules.
- O23 (P4, LOOP): Codex separates `commentary` from `final`: a commentary update first when tools are needed, none longer than 60 seconds apart, and a self-contained final answer. The research names no section for this point, only the template.
- O24 (P4, P6, LOOP): Codex sets `apply_patch_tool_type` to `freeform` for `gpt-6-astra` and `gpt-6.1-sol`, and `apply_patch` is a supported Responses tool for Luna. Terra's tool list was not read.

### Parameters

- O25 (P1, P6, PARAM): Effort is set per request, or mid-conversation with `configuration_update` items, which keep the cache. Astra and 6.1 Sol do not accept effort `none`; Terra and Luna do. Luna supports Chat Completions function calling only with effort `none`, and tools otherwise go through the Responses API. Terra's page advises starting at `medium` and raising effort only when the quality gain is worth the time and tokens. With any effort except `none`, omit `temperature`, `top_p` and `top_logprobs`. Codex defaults the GPT-6 models to effort `low` and no reasoning summary. Sections "What's new", "Limitations" and "Update API and model parameters" (P1); the Terra page (P6). Using `xhigh` only when evals justify it is a third-party quotation of OpenAI's reasoning guide, so treat it as inference.

### Rendered output

- O26 (M1, PROMPT): GPT-built interfaces ship cramped or misaligned spacing. The maintainer's screenshot of a page a GPT model built shows a card whose text starts at the card's own left edge, with no inner padding; the card flush against the heading rule above it and the vertical divider at its right; the card's bottom on the section edge; and an em dash wrapped to the start of a line. No OpenAI page says anything about spacing, so this rests on that observation alone. The family states the spacing rules as outcomes with their reason (one scale, padding inside every container, a gap around every block, shared column edges, no line starting with closing punctuation). It has the worker measure padding and gaps on the final captures and name the places that still touch, and the reviewer, who has no shell, compare the captures and the worker's measurements for visible contact, because a model that judges a still by its overall look passes a card that touches a rule. Carried in `design-core/core.md`, `roles/worker-visual/method.md`, `roles/reviewer-visual/captures.md` and `skills/visual-judging/SKILL.md`.

## Applying the points

- The text names the CLI as `holyagent <command>` and every host tool by its function (the structured question tool, the task list tool, the patch tool), because no source names the tools of the host that will run this set. The integration that wires the family supplies the host's names.
- A requirement outranks a point of this guide: where they differ, the requirement stands and the file carries the point as far as the requirement allows. R-ASK keeps one decision at a time against O21's bundling, and R-TASKLIST and R-ACK keep progress narration out of replies against O23's commentary updates.
- Several points correct habits of the earlier model (O14, O15, the bias to action of O4). They are carried only where a requirement leaves room, so a rule is not repeated for a habit this family lacks.

## Gaps

- The pages carry no dedicated Luna or Terra prompting guide. Only the Astra and 6.1 Sol Codex templates were read, so the Luna, Terra and 6.0 Sol templates and the change from 6.0 to 6.1 are unknown.
- The pages carry no guidance on spacing, layout or other visual craft, so O26 is a local rule from one maintainer observation and needs checking on further GPT-built pages.
- OpenAI's reasoning guide and the cookbook prompting guides for earlier Codex models were not read.
- P5 predates GPT-6 and is cited only for the `AGENTS.md` scope rule.
- Every behavior point was observed on Astra and is extended to the rest of the family by OpenAI, so each needs an evaluation on the model in use.
- The pages carry dates, which this guide leaves out so the instruction sources stay free of time-varying text.
