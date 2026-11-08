---
name: write-skills
description: Use when a skill that HolyAgent distributes is written, changed or reviewed. Holds how to write it to the Agent Skills standard so it works on every supported model family, with the standard and the shared model-guide points in reference files.
---

# Writing distributed skills

HolyAgent ships each skill once per model family, from `packages/runtime/src/instructions/<family>/skills/<skill>/`. A skill follows the Agent Skills standard so any compliant client loads it, and its text follows the guidance the families share so each model acts on it the same way. Read the references when you need the detail:

- [references/agent-skills-standard.md](references/agent-skills-standard.md): frontmatter fields and limits, layout, progressive disclosure, file references, validation, with sources.
- [references/model-guides.md](references/model-guides.md): the Claude and Kimi guide points, which ones are shared, and how to write text that satisfies both when they differ.

Each family's `guide.md` is the authority for its own translation; the `requirements` skill covers translating requirements, this one covers skills.

## Rules

- Name the directory and the `name` field alike: 1-64 characters of lower-case letters, digits and single hyphens, no leading or trailing hyphen, and no `anthropic` or `claude` (a client may reject them). Prefer a gerund or noun phrase that says what the skill covers (`processing-pdfs`), never `helper` or `utils`.
- Start the `description` with the situation that should load the skill, then say what it holds or does, in third person and under 1024 characters. The description is the only text a model sees before it loads the skill, so it carries the trigger words. Leave out XML tags and quote any value that contains a colon.
- Use only `name` and `description` unless a field earns its place: `license`, `compatibility`, `metadata` and `allowed-tools` are the other spec fields, and `allowed-tools` is experimental and varies by client.
- Keep `SKILL.md` under 500 lines and about 5000 tokens, as a body that works alone: the situation, the rules with the reason beside each, one default rather than a menu of options. Move material needed only sometimes into `references/`.
- Link each reference from `SKILL.md` with a relative path and say when to read it. Keep references one level deep, because a model that reads a nested file partially misses its content. Give a reference over 100 lines a contents list.
- Put executable helpers in `scripts/` (self-contained, with clear error messages) and templates or data in `assets/`; refer to them by relative path with forward slashes. A script does the deterministic work, so the model does not redo it in prose.
- Match freedom to fragility: a fixed command or step order where an error is costly, a stated goal and boundary where several routes work.
- Number steps when order or completeness matters; give a check for any step that can fail silently, and a fix-and-recheck loop for long workflows.
- Write terse English with the reason beside each rule, calmly and positively (what to do, with a concrete threshold instead of "important"), and follow the `instruction-writing` skill (`packages/runtime/src/instructions/claude-5.5/skills/instruction-writing/SKILL.md`).
- Give the skill one terminology, keep dates, versions and other facts that change out of the body, and tell the reader to look such facts up instead.
- Leave model parameters (reasoning effort, temperature, `tool_choice`) and API contracts out of skill text: the harness owns them, and they differ per family.
- Do not name a family or model in a skill meant for all; a family-specific rule belongs in that family's copy.

## Check before done

1. Run `skills-ref validate <skill directory>` when the tool is available; otherwise check each rule above by hand (name equals directory, description length, only spec fields).
2. Read the description alone and confirm it says when to load the skill without the body.
3. Confirm the body is under the limits and every reference is linked once, one level deep.
4. Reread the text against [references/model-guides.md](references/model-guides.md): no emphasis in capitals, no reasoning requested in the reply, delimited inputs, examples that vary, no duplicated rule.
5. Run `bunx --no-install mise run build` and `bunx --no-install mise run verify`; the build copies the skill's files into the plugin.
