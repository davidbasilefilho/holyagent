---
name: requirements
description: Use when a behavior requirement of HolyAgent's instructions is created, changed, moved or removed, or when a model family's instruction set must be translated from the requirements. Holds how to edit the requirements tree, scaffold the family files, translate each requirement per family guide, cover each id in the coverage table and run the build and verify gates.
---

# Requirements

`packages/runtime/src/instructions/requirements/` holds the model-agnostic behavior requirements. It mirrors each family tree (`claude-5.5/`, and every family in `FAMILIES` in `packages/runtime/src/instructions/families.ts`) file for file: `requirements/<path>.md` holds the id-led requirements that become `<family>/<path>.md`. A behavior change starts in the requirements and then reaches every listed family, so no family drifts from the others. Run all commands from the repository root through `mise`, the single source of commands.

## Requirement format

- One line per requirement: `- R-NAME: the behavior`. The id is `R-` plus upper-case words, unique across the whole tree: other requirements and the id-coverage test refer to it, and a duplicate hides a missing translation.
- State the behavior and its boundary in plain prose with no model, wording or tag detail: each family's translation owns those, and a requirement that carries them cannot be translated freely.
- Refer to another requirement by its id, never by a copy of its text: one owner per rule keeps the copies from drifting. In a file that a requirement defined elsewhere also governs, add a line `- See: R-A, R-B` (comma-separated ids); `requirements.ts` parses it, and a test fails when a listed id is not defined in exactly one other file. Any other line is prose and is not read.
- Put a requirement in the file whose family counterpart holds its translation; a new topic gets a new file. File names are lower-case kebab words.

## Create

1. Choose the requirements file (an existing one when the topic fits), pick an unused id (`rg -n "R-NAME" packages/runtime/src/instructions`), and add the line.
2. For a new file, run the scaffold (below) so each family gets the same-named empty file.
3. Translate into every listed family (below).
4. Add the id's entry to `REQUIREMENT_COVERAGE` for every listed family (Coverage, below).

## Adjust

1. Edit the line in `requirements/`; keep the id when the behavior is the same one, so existing references stay valid.
2. Change each family's translation of that id in the same change; a family left on the old behavior breaks the promise that every family covers every line.
3. Rename an id with a repository-wide search and replace of the old id, then check that no old id remains; its `REQUIREMENT_COVERAGE` key is one of the occurrences.
4. Update the id's coverage entry when the translation's file or wording changed, so the entry's `phrase` is still in the file (Coverage, below).

## Move or remove

- Moving a requirement: cut the line, paste it into the destination file (scaffold first when that file is new), and move its translation in each family to the family's counterpart file. Point the id's coverage entry in each family at the new file, with a phrase that file holds.
- Moving a file: rename it under `requirements/` and its family files with it, then scaffold. The scaffold creates what is missing and never renames, and the mirror test fails on a leftover. Point the `section` of every coverage entry for the file's ids at the new path.
- Removing a requirements file: delete the family files of the same path in every family, including their directory when it is empty. The mirror test fails on a family file without a requirements counterpart. Delete the coverage entries of its ids.
- Removing a requirement: delete its line, its translations and its coverage entry in every family; leave no reference to the id. The coverage test fails on an entry for an id that no file defines.

## Scaffold

After creating or moving a requirements file, and before writing any family's translation, run:

`bunx --no-install mise run instructions:scaffold`

It creates the missing same-named empty files and directories in each family and never overwrites, so it is safe to rerun. Use it instead of creating family files by hand: it keeps the trees mirrored exactly, and the mirror test checks that.

## Translate per family

For each family in `FAMILIES`:

1. Read that family's `guide.md` first. It sets the wording, structure and tags for the model, and it is the only place those live.
2. Write the family's file from the requirement: cover every id in it, with the wording, structure and tags the guide asks for. The id-coverage test fails on an uncovered id.
3. Apply the `instruction-writing` skill (`packages/runtime/src/instructions/claude-5.5/skills/instruction-writing/SKILL.md`) for any text a Claude model reads; each family's own guide is the authority for its family.
4. Translate the meaning, not the sentence: a requirement that reads well to one model can be wrong for another, and each translation keeps the behavior and drops the phrasing.

## Coverage

`REQUIREMENT_COVERAGE` in `packages/runtime/src/instructions/coverage.ts` maps each family to its ids and names where that family's instructions implement each one. The coverage test fails for an id without an entry, an entry for no id, and a file that does not hold the entry's phrase, so the table is how an unimplemented requirement gets noticed.

- An entry is `{ section, phrase }`: `section` is the family file that carries the id, as a path from the family folder (`skills/<name>/SKILL.md` for a skill), and `phrase` is text of that file. Choose a phrase specific to the requirement, so deleting the behavior fails the test.
- An id that no prompt text can carry, because code, settings or documentation enforce it, gets `{ carriedBy, phrase }` instead: `carriedBy` is the file that enforces it, as a path from the repository root.
- Every listed family needs an entry for every id.

## Adding a family

A family joins by being listed in `FAMILIES` in `families.ts`, in the same change as its translations of every requirements file and its table in `REQUIREMENT_COVERAGE` (the type requires one table per listed family). Until then its folder may hold `guide.md` alone, and the mirror and coverage tests skip it. Scaffold, translate per its `guide.md` and cover each id before listing it.

## Gates

1. `bunx --no-install mise run build` regenerates the plugin from the instructions; commit its output with the change.
2. `bunx --no-install mise run verify` (type-check, lint, format check, tests) must pass. A failing mirror or id-coverage test names the missing file or id.
