# Instruction text

Change instruction text in this order, so the requirements stay the source and the model sets cannot drift from them:

1. Change `src/instructions/requirements/` first. It mirrors every Markdown file of each model family (`claude-5.5/`), file for file, and each file holds the requirements that become that family file, one `- R-ID: text` line each. An id is defined once; a file that a requirement also governs refers to it with a `- See: R-ID` line.
2. Run `mise run instructions:scaffold` (`bun run instructions:scaffold` in this package). It adds the missing folders and files to every family in `src/instructions/families.ts` as empty files and never overwrites or deletes one with content.
3. Translate the requirements into each family's files as that family's `guide.md` directs. Wording, structure and tags follow the model's guide, and every requirement stays covered.
4. Update the tests: add the id to `REQUIREMENT_COVERAGE` in `src/instructions/coverage.ts` with the file and phrase of each family that carries it.

A family joins `FAMILIES` only together with its translations; its `guide.md` may exist before. Rebuild the plugin with `mise run build` after a change to `claude-5.5/`: `requirements/` and `guide.md` are not shipped.

The repository skill `.claude/skills/requirements/SKILL.md` holds the procedure for writing and changing requirements; load it before step 1.
