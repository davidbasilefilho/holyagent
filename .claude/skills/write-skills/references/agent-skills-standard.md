# The Agent Skills standard, as it applies to distributed skills

Sources (fetched 2026-11-07; re-check them for limits, which change):

- S1 Specification: https://agentskills.io/specification
- S2 What are skills: https://agentskills.io/what-are-skills
- S3 Integrate skills (client behavior): https://agentskills.io/integrate-skills
- S4 Reference validator: https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py and its README (`skills-ref`, "for demonstration purposes only")
- S5 Anthropic skill authoring best practices (stricter than the standard): https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices

The S5 fetch was truncated after its "Advanced: executable code" section, so its "Checklist for effective Skills" and runtime-environment sections were not read; check them before relying on this list as complete.

Contents: layout, frontmatter, Anthropic constraints, body, progressive disclosure, optional directories, file references, validation, portability.

## Layout (S1, S2, S3)

- A skill is a directory with at least `SKILL.md`, named exactly that.
- Optional: `scripts/`, `references/`, `assets/` and other files or directories.
- The standard mandates no install location. `.agents/skills/` is the widely used cross-client convention (S3).

## Frontmatter (S1)

YAML between `---` lines, then Markdown.

| Field           | Required | Constraint                                                                                                                  |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`          | yes      | 1-64 characters; lower-case alphanumerics and `-`; no leading or trailing hyphen; no `--`; equals the parent directory name |
| `description`   | yes      | 1-1024 characters, non-empty; says what the skill does and when to use it, with specific keywords                           |
| `license`       | no       | A license name or a bundled license file name; short                                                                        |
| `compatibility` | no       | 1-500 characters; only for real environment requirements (product, system packages, network); most skills need none         |
| `metadata`      | no       | Map of string keys to string values; use distinctive key names                                                              |
| `allowed-tools` | no       | Space-separated pre-approved tools, for example `Bash(git:*) Read`; experimental, support varies by client                  |

- Good description (S1): "Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction." Poor: "Helps with PDFs."
- Quote a value that holds a colon (`description: "Use when: ..."`); an unquoted colon is invalid YAML and a client may skip the skill (S3).
- Any other key is an error in the reference validator (S4); a portable skill uses only these six.

## Anthropic constraints beyond the standard (S5)

- `name` and `description` hold no XML tags; `name` holds neither `anthropic` nor `claude`.
- Write the description in third person: it is injected into the system prompt, and "I can help" or "You can use this" harm discovery.
- Prefer gerund names (`processing-pdfs`); noun phrases and verb phrases are acceptable; avoid `helper`, `utils`, `documents`, `data`.

Following these costs nothing on other clients, so a distributed skill follows them.

## Body (S1, S5)

- No format restriction. Recommended: step-by-step instructions, input and output examples, common edge cases.
- The whole body loads on activation. Keep it under 500 lines (S1, S5) and under 5000 tokens (S1; S3 calls it recommended).
- Be concise and add only context the model lacks; match freedom to fragility (high, medium or low); offer a default instead of many options; avoid time-sensitive information; use one terminology; use checklists and validate-then-fix loops for complex work; include input and output examples; build evaluations first and iterate on observed behavior (S5).

## Progressive disclosure (S1, S2, S3)

1. Metadata (`name`, `description`) loads at startup, about 50-100 tokens per skill.
2. The `SKILL.md` body loads on activation.
3. Files in `scripts/`, `references/` and `assets/` load only when needed.

Every description therefore costs context in every session; keep it as short as the trigger allows.

## Optional directories (S1, S5)

- `scripts/`: self-contained or dependency-documenting executable code with helpful errors that handles edge cases itself instead of leaving them to the model; document constants rather than leave unexplained values.
- `references/`: focused files (for example `REFERENCE.md`, or a domain file); smaller files use less context.
- `assets/`: templates, images, data files.

## File references (S1, S5)

- Use relative paths from the skill root, with forward slashes: `[guide](references/REFERENCE.md)`, `scripts/extract.py`.
- Keep references one level deep from `SKILL.md`; a model that previews a nested file with `head -100` reads it incompletely (S5).
- Give a reference over 100 lines a contents list (S5).

## Validation (S1, S4)

- `skills-ref validate ./my-skill` checks: the directory and `SKILL.md` exist, the frontmatter parses, only the six keys appear, `name` and `description` are present, `name` is at most 64 characters with the allowed shape and equals the directory name, `description` is at most 1024 characters, `compatibility` is at most 500.
- It does not check body length, XML tags, reserved words, `metadata` value types or the `allowed-tools` format; check those by hand.

## Portability (S3, S5)

- Clients may be lenient on a name mismatch or an over-long name, but skip a skill with no description or unparseable YAML. Write to the strict rules.
- A project skill overrides a user skill of the same name, and a client may gate project skills from an untrusted repository behind a trust check.
- Test a skill on every model that will load it: a smaller model may need more detail, a larger one less (S5).
