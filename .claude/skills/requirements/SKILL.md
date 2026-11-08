---
name: requirements
description: Use when a behavior requirement of HolyAgent's instructions is created, changed, moved or removed, or when a model family's instruction set must be translated from the requirements. Holds how to edit the requirements tree, scaffold the family files, translate each requirement per family guide and run the build and verify gates.
---

# Requirements

`packages/runtime/src/instructions/requirements/` holds the model-agnostic behavior requirements. It mirrors each family tree (`claude-5.5/`, and every family in the supported-families list in code) file for file: `requirements/<path>.md` holds the id-led requirements that become `<family>/<path>.md`. A behavior change starts in the requirements and then reaches every listed family, so no family drifts from the others. Run all commands from the repository root.

## Requirement format

- One line per requirement: `- R-NAME: the behavior`. The id is `R-` plus upper-case words, unique across the whole tree: other requirements and the id-coverage test refer to it, and a duplicate hides a missing translation.
- State the behavior and its boundary in plain prose with no model, wording or tag detail: each family's translation owns those, and a requirement that carries them cannot be translated freely.
- Refer to another requirement by its id, never by a copy of its text: one owner per rule keeps the copies from drifting.
- Put a requirement in the file whose family counterpart holds its translation; a new topic gets a new file. File names are lower-case kebab words.

## Create

1. Choose the requirements file (an existing one when the topic fits), pick an unused id (`rg -n "R-NAME" packages/runtime/src/instructions`), and add the line.
2. For a new file, run the scaffold (below) so each family gets the same-named empty file.
3. Translate into every listed family (below).

## Adjust

1. Edit the line in `requirements/`; keep the id when the behavior is the same one, so existing references stay valid.
2. Change each family's translation of that id in the same change; a family left on the old behavior breaks the promise that every family covers every line.
3. Rename an id with a repository-wide search and replace of the old id, then check that no old id remains.

## Move or remove

- Moving a requirement: cut the line, paste it into the destination file (scaffold first when that file is new), and move its translation in each family to the family's counterpart file.
- Moving a file: rename it under `requirements/` and its family files with it, then scaffold. The scaffold creates what is missing and never renames, and the mirror test fails on a leftover.
- Removing a requirements file: delete the family files of the same path in every family, including their directory when it is empty. The mirror test fails on a family file without a requirements counterpart.
- Removing a requirement: delete its line and its translations; leave no reference to the id.

## Scaffold

After creating or moving a requirements file, and before writing any family's translation, run:

`bunx --no-install mise run instructions:scaffold`

(or `bun run instructions:scaffold` in `packages/runtime`). It creates the missing same-named empty files and directories in each family and never overwrites, so it is safe to rerun. Use it instead of creating family files by hand: it keeps the trees mirrored exactly, and the mirror test checks that.

## Translate per family

For each family in the supported-families list:

1. Read that family's `guide.md` first. It sets the wording, structure and tags for the model, and it is the only place those live.
2. Write the family's file from the requirement: cover every id in it, with the wording, structure and tags the guide asks for. The id-coverage test fails on an uncovered id.
3. Apply the `instruction-writing` skill (`packages/runtime/src/instructions/claude-5.5/skills/instruction-writing/SKILL.md`) for any text a Claude model reads; each family's own guide is the authority for its family.
4. Translate the meaning, not the sentence: a requirement that reads well to one model can be wrong for another, and each translation keeps the behavior and drops the phrasing.

A family whose translations arrive in a later PR stays out of the list until then; the list in code decides which families the tests cover.

## Gates

1. `bunx --no-install mise run build` regenerates the plugin from the instructions; commit its output with the change.
2. `bunx --no-install mise run verify` (type-check, lint, format check, tests) must pass. A failing mirror or id-coverage test names the missing file or id.
