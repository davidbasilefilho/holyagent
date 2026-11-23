# Workspaces and versions

Sourced from the Bun docs (workspaces, catalogs, `bun run`, `bun add`, bunfig) and the Bun v1.3.9 release notes, read on 2026-11-04. Bun changes quickly: re-check current docs with web search or fetch before relying on a detail, and say when you could not.

## Workspaces

- Root `package.json`: `"workspaces": ["packages/*"]`. Full glob syntax and negative patterns such as `!**/excluded/**` work.
- The docs show `packages/` as the convention and do not mention `apps/` or `tooling/`. Layouts such as `["apps/*", "packages/*", "tooling/*"]` rely on glob support; confirm with `bun install` that each directory is picked up.
- Each workspace needs a `name`. Bun skips a matched `package.json` without one.
- Sibling references: `workspace:*`, `workspace:^`, `workspace:~`. On publish Bun rewrites `workspace:*` to the exact version, `workspace:^` to `^1.0.1` and `workspace:~` to `~1.0.1`; a specific version such as `workspace:1.0.2` is kept as written. Published ranges are then outside rule 1 by design, because the zeroed caret rule applies to what is declared in the repository.
- Install a subset: `bun install --filter "pkg-*" --filter "!pkg-c"`, or by path `--filter "./packages/pkg-*"`. `bun add --filter <pattern>` also exists.
- `bun run --filter '<pattern>' <script>` runs a script in every matching package; `--workspaces` runs it in all workspaces. `--filter '*'` and `--workspaces` skip the root package, and `--workspaces` errors on a missing script unless `--if-present` is set. Script flags (`--parallel`, `--sequential`) are covered in `bun-stack-prefs`.

## Catalogs

- Shared dependency versions can live in the root `package.json`, under `workspaces.catalog` and `workspaces.catalogs` or at the top level, and be referenced as `catalog:` or `catalog:name` in dependencies, devDependencies, optionalDependencies, peerDependencies and root `overrides`.
- `bun add pkg --catalog` or `--catalog=name` writes the root entry and the reference. `bun publish` and `bun pm pack` replace `catalog:` with the real range.
- Catalog entries are held to rule 1 like any other declared range (the docs' own examples show exact versions such as `"jest": "30.0.0"`; normalize them). The range test checks catalog values.
- Catalogs are the single source for dependency versions, not for package versions. Verify the Bun version that introduced `catalogs` and `bun add --catalog` before using them in a project pinned to an old Bun.

## Dependency range facts

- `bun add pkg` writes `^` plus the resolved version (for example `^2.4.1`). `bunfig.toml` `[install] exact = true` and `bun add --exact` pin an exact version. No bunfig save-prefix or zeroing option was found, so enforcement is the test plus a manual or scripted normalization after `bun add`. Verify this is still true before telling the user.
- `overrides` and `resolutions` are checked by the test because they declare versions.
- A package that publishes only prereleases (tsrs at the time of writing) cannot be matched by a plain zeroed caret, so the test allows a prerelease suffix: `^0.21.0-ts7.1.0-beta`. Normalize the numbers to a zeroed shape and keep the suffix.

## Single source of truth for package versions

- Default: the root `package.json` `version` is canonical. `scripts/sync-version.ts` copies it into each workspace; `versions.test.ts` fails on drift.
- Internal dependencies use `workspace:*`, so there is no internal version to keep in sync.
- A release tool that bumps a group of packages together (Changesets "fixed" mode is the usual candidate) may replace the sync script. This behavior was not verified; read its current docs before proposing it, and keep the test.
- If the project already has one canonical place (for example a shared config or a version file), keep it, make the sync script read it, and point the test at it.
