---
name: bun-prefs
description: Use when creating or changing a JavaScript or TypeScript project that runs on Bun, when adding, bumping or declaring any dependency, when structuring a monorepo, or when choosing where package versions live. Applies the user's preferences for dependency range format, Bun workspace layout and single-source versioning, and adds the tests that enforce them.
---

# Bun Preferences

Preferences for how Bun projects declare dependencies, lay out monorepos and own their version. They are firm rules, not suggestions. For the toolchain around them (runtime APIs, linting, formatting, type checking, scripts) load `bun-stack-prefs`. For bumping dependencies safely load `upgrade-deps`. For general coding preferences load `general-prefs`, and for React or web projects `react-prefs` and `web-stack`.

This skill is model-, harness- and environment-agnostic. It describes **capabilities** and says what to do when each is absent.

## Capabilities to look for (use them when present)

| Capability | Use it for | Fallback when absent |
|---|---|---|
| Web search / fetch | Checking current Bun docs before relying on anything marked "verify" below | Use the references and say they may be stale |
| Code execution | Running `bun test`, the version sync script and `bun install` | Give the user the exact commands and say they were not run |
| Structured question tool | Confirming an ambiguous range format or version location | Ask in plain text with numbered options |

## Rules

1. **Dependency ranges are zeroed carets.** Every declared dependency, dev dependency, optional dependency and the like (peer dependencies, overrides, resolutions, catalog entries) must be `^X.0.0`, `^0.X.0` or `^0.0.X`, or any variant of those shapes with any numbers. Examples: `^2.0.0`, `^0.4.0`, `^0.0.7`. A prerelease suffix is allowed for packages that publish only prereleases (`^0.21.0-beta`). No tilde, exact, `>=`, `*` or tag ranges, except as the peer-range bullet below allows.
   - **Peer-range exception.** When a dependency's peer requirement, in the `peerDependencies` of another declared and installed package, is narrower than the zeroed caret (for example `better-auth >=1.7.16 <1.8.0`), declare the peer range instead (`~1.7.16`), because the zeroed caret would admit versions the other package rejects. Any other tilde still fails; the test accepts one only when a declared and installed package's peer range requires it, so run `bun install` before `bun test`. Detail in [Tests](references/tests.md).
   - `bun add` writes a caret on the resolved version (for example `^2.4.1`), and no `bunfig.toml` key that zeroes it was found. After every `bun add` or version bump, normalize the written range by hand or script, then run the test. Verify against current Bun docs whether a save-prefix setting now exists before saying none does.
   - **This must always be tested.** Add the range-format test from [Tests](references/tests.md) to every project, and keep it in the default `bun test` run and in CI.
2. **Monorepos always use Bun workspaces.** Put the globs in the root `package.json` `workspaces` field: `packages/*` for libraries, `apps/*` for deployables, and any other directory the project requires (for example `tooling/*` or `services/*`). Every workspace has a `name`, because Bun skips a matched `package.json` without one. Reference siblings with `workspace:*`.
3. **One source of truth for versions.** The version of every package, app and other workspace is defined in one place and propagated everywhere else. Default: the root `package.json` `version` is the source, a script copies it into every workspace, and sibling dependencies use `workspace:*` so no second copy exists. If the project already has a single source, keep it and adapt the test to read it.
   - **This must also be tested.** Add the single-version test from [Tests](references/tests.md) and the sync script it pairs with, and keep both in `bun test` and CI.

## Workflow

1. Detect the situation: single package or monorepo, existing workspaces globs, existing version source, existing tests. Reuse what exists.
2. Apply rules 1 to 3. Create the tests from [Tests](references/tests.md) with the file names given there, copied unchanged unless the project's layout requires an adaptation (the file lists what to adapt).
3. Run `bun test` and confirm it passes, and that it fails when you break a range or a version on purpose. If code execution is absent, say the tests were not run.
4. Add the `version:sync` script to the root `package.json` scripts. Script naming and the rest of the scripts follow `bun-stack-prefs`.
5. When bumping dependencies, follow `upgrade-deps` and then re-normalize ranges to rule 1 before running the tests.

Details, caveats and unverified points are in [Workspaces and versions](references/workspaces-and-versions.md).

## Honesty

- Bun moves fast. Before relying on a flag, config key or workspace feature marked "verify" in the references, check current Bun docs with web search or fetch, and say when you could not.
- The range-format regex is a reading of the preference ("or any variant"). When a project needs a shape it rejects, ask the user and change it in one place in the test.

## Self-update

At the end of a session, if it surfaced general lessons (a Bun behavior that changed, a range shape the test mishandled, a workspace edge case), offer the user to update this skill with them. Add only general lessons, never project names, package names, paths or other user data.

## References

- [Tests](references/tests.md): the range-format test, the single-version test, the shared helper and the sync script, as complete files, with skipped specifiers and how they were verified.
- [Workspaces and versions](references/workspaces-and-versions.md): workspace globs and filters, catalogs, `workspace:` publishing behavior, versioning options, unverified points.
