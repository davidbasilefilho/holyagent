---
description: One-time setup for HolyAgent - install ctx7 and merge the recommended settings into your user, project or local settings, or back them out
argument-hint: "[--scope user|project|local] [--undo] [--dry-run] [--subagent-cache-ttl 1h|5m] [--skip-ctx7]"
allowed-tools: Bash(bun --no-env-file --config=*empty-bunfig.toml* *holyagent.js* setup*)
---

Run HolyAgent's setup, show its report and tell the user whether to restart. Steps:

1. Run the plugin's own CLI, quoting both paths: `bun --no-env-file --config="${CLAUDE_PLUGIN_ROOT}/scripts/empty-bunfig.toml" "${CLAUDE_PLUGIN_ROOT}/scripts/holyagent.js" setup $ARGUMENTS`. Run nothing else: it installs the ctx7 CLI when it is missing and merges the recommended keys into the settings file of `--scope` (the user settings unless set) without changing a value that is already set. With `--undo` it installs nothing and removes from that file only the values setup recorded adding.
2. Show the report exactly as the command printed it. Its lines start with `+` for added, `=` for already in place (with `--undo`, nothing to remove), `-` for skipped (with `--undo`, removed), `~` for kept or for something the user has to do, and `!` for a failed step; a failed step does not stop the others, and the command exits 1 when any step failed.
3. Tell the user to **restart Claude Code** only after a real run (no `--dry-run` in the arguments) whose report has a `+` line (with `--undo`, a `- ... removed` line), because Claude Code reads its settings and skills at launch. A `--dry-run` also prints those lines but changes nothing, so then say that nothing was changed and nothing needs a restart, and that running the setup without `--dry-run` applies it. Otherwise say that nothing needs a restart.

Notes:

- `--scope project` writes `.claude/settings.json` and `--scope local` writes `.claude/settings.local.json`, in the git top-level of the current directory when that is the current directory or above it and holds a `.git` entry (else the current directory itself, with a `~` line saying so, outside a repository too), so HolyAgent can be tried in one repository; they refuse a settings file or `.claude` folder that is a symlink. ctx7 is still installed for the user. Pass the same `--scope` to `holyagent doctor`.
- Setup records what it adds, per settings file, outside the project. `--undo` removes only recorded keys whose value still equals what setup wrote, and from `permissions.deny` only the entries setup added; a changed value or a key with no record (set before setup, or by an earlier version) stays and is reported with `~`, for the user to remove by hand. It drops objects it leaves empty and does not uninstall ctx7.
- Run it again after fixing whatever a `!` line names; finished steps print `=` and change nothing.
- Setup no longer installs external Context7 skills or rules. Existing files are left in place. Context7 authentication is managed separately; the CLI check does not verify authentication.
- In a claude.ai cloud session ctx7 is skipped with a `-` line, and the settings are still merged.
- `holyagent doctor` checks the same things without changing them, and `holyagent doctor --fix` runs the missing steps.
