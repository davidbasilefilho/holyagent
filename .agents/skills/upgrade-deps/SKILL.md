---
name: upgrade-deps
description: Use when a project's dependencies need upgrading, whether only the lockfile or the declared version ranges too, in any package manager or language ecosystem. Upgrades the lockfile to the latest versions the declared ranges allow, or bumps the declared dependencies to the latest version in the bun-prefs range format and relocks.
---

# Upgrade Dependencies

Two upgrade modes that work in any ecosystem, not only Node ones. For the range format's owner see `bun-prefs`; for how an upgrade lands (version bump, release stack, squash) see `general-prefs`; for the tests to run see `bun-stack-prefs`.

This skill is model-, harness- and environment-agnostic. It names capabilities, never agent tools.

## Capabilities to look for (use them when present)

| Capability | Use it for | Fallback when absent |
|---|---|---|
| Web search / fetch | Checking the current command and flag for the ecosystem, latest versions, and every command marked verify in the reference | Say the command is unchecked and ask the user to confirm it before running |
| Code execution | Running the upgrade commands, the lockfile install and the project's tests | Show the exact commands for the user to run |
| Structured question tool | Asking which mode to use, or whether to take a major bump | Ask in plain numbered text |
| Memory / notes | Recording which package managers and workspaces a project uses | Record it in the project's agent instructions file |

Package managers change flags often. Before running a command, check it against the current docs with web search or fetch when available. The reference was researched on 2026-11-04 and marks what stayed unconfirmed.

## Modes

1. **Lockfile only.** Upgrade the lockfile, using the package manager's commands, to the latest version of every dependency that fits the ranges already declared. The declared ranges stay as they are.
2. **Declared ranges and lockfile.** Upgrade every declared dependency to the latest version, written in the range format below, then upgrade the lockfile to match.

When the request does not say which, ask. "Update the lockfile" is mode 1; "upgrade the dependencies" or "to latest" is mode 2.

## The range format

Every declared dependency is a caret with zeroed lower parts, from the latest version `A.B.C`:

| Latest | Declared |
|---|---|
| `A >= 1` | `^A.0.0` |
| `A = 0`, `B >= 1` | `^0.B.0` |
| `A = 0`, `B = 0` | `^0.0.C` |

This is the `bun-prefs` range format. One exception: a dependency whose range is narrowed by another package's peer requirement (for example `better-auth` declared `~1.7.16` because `@convex-dev/better-auth` needs `>=1.7.16 <1.8.0`) keeps the peer range, never the zeroed caret. Mode 2 keeps that range, because `latest`-style bumps ignore peer ranges; bump such a dependency only when the constraining package's peer range moves (upgrade the two together, then write the new peer range). Ecosystems whose syntax has no caret express the same interval; see [Ecosystems](references/ecosystems.md) for each equivalent, and for the ones that cannot express it, where you tell the user what you wrote instead and why.

## Workflow

1. Find every manifest and lockfile, including workspaces and more than one ecosystem in one repository.
2. For each, read the matching row in [Ecosystems](references/ecosystems.md) and verify the commands it marks unconfirmed against current docs.
3. Mode 1: run the lockfile command. If the tool also rewrote the manifest, restore the declared ranges to their previous values and relock, because mode 1 never changes declarations.
4. Mode 2: bump each declared dependency to the latest version, rewrite every range to the format, except a dependency kept on its peer range (tools keep or write other operators, so read the manifest diff, fix each one, and restore a peer-range dependency that the tool rewrote, for example `bun update --latest` moving `~1.7.16` to the newest version's tilde), then relock so the lockfile satisfies the new ranges.
5. Run the project's install from the lockfile, tests, type-check, lint and build. Fix or report failures; report each as command and exit code.
6. Report what moved (old to new), what stayed behind and why (for example an ecosystem with no latest-version command, or a range that cannot be written in the format), and any command you did not verify.

## References

- [Ecosystems](references/ecosystems.md): per-package-manager commands for both modes, range equivalents, commands to verify.

## Session end and self-update

At the end of a session, if it surfaced general lessons (a changed command or flag, a new ecosystem, a range equivalent that proved wrong), offer the user to update this skill with them. Add only general lessons, never project, user or account data.
