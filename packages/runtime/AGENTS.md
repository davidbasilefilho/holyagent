# Instruction text

Change instruction text requirements-first, so the requirements stay the source and the model sets cannot drift from them: edit `src/instructions/requirements/` before any family's files, then translate and cover each id in every family listed in `src/instructions/families.ts`.

The repository skill `.claude/skills/requirements/SKILL.md` holds the steps (scaffold, translation per `guide.md`, `REQUIREMENT_COVERAGE`, rebuild); load it before editing instruction text.
