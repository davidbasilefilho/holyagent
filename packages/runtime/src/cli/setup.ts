import { Effect, Schema } from "effect"

import { doctor } from "../setup/doctor.ts"
import type { Report } from "../setup/report.ts"
import { SCOPES } from "../setup/scope.ts"
import { CACHE_TTLS } from "../setup/settings.ts"
import { Shell } from "../setup/shell.ts"
import { setup } from "../setup/steps.ts"
import { booleanFlag, choiceFlag, stringFlag } from "./args.ts"
import { type Command, Verbatim } from "./types.ts"

const CacheTtlFlag = Schema.Literals(CACHE_TTLS)
const ScopeFlag = Schema.Literals(SCOPES)

/** A report as the text of stdout, one line each, and exit 1 when any step failed. */
const printed = (report: Report) =>
  new Verbatim(`${report.lines.join("\n")}\n`, "", report.ok ? 0 : 1)

const SETUP_USAGE =
  "setup [--scope user|project|local] [--undo] [--dry-run] [--subagent-cache-ttl 1h|5m] [--skip-ctx7]"
const DOCTOR_USAGE = "doctor [--scope user|project|local] [--fix]"

/**
 * The `setup` and `doctor` commands, which install and check what HolyAgent needs beside the
 * plugin. Both are stateless: they never read the HolyAgent state, and the settings file they work
 * on is the one `--scope` names (the user's by default).
 */
export const SETUP_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["setup"],
    usage: SETUP_USAGE,
    summary:
      "Install and configure what HolyAgent needs beside the plugin, skipping every step already done",
    output:
      "report lines: `+` added, `=` already in place, `-` skipped (with --undo: removed), `~` kept or needs you, `!` failed; exit 1 when any step failed",
    notes: [
      "installs ctx7 with the Context7 skill (needs CONTEXT7_API_KEY or a saved login)",
      "when Pi is in use (HOLYAGENT_HOST=pi, or pi on PATH; not in a cloud session), makes Pi's packages match the HolyAgent config: `pi install npm:<name>@<pin>` for each package the config enables that Pi's settings do not list at that pin, and `pi remove npm:<name>` for each feature package the settings list but the config turns off; scope user works on Pi's global settings, project and local on the project's .pi/settings.json with -l; nothing runs while pi.enable is off; re-run setup after changing pi.features or pi.web in the config",
      "merges these keys into the settings file of --scope without changing any value already set: attribution, includeGitInstructions, subagentPromptCacheTtl, modelSettings.claude-opus-5-5 (effortLevel high and autoCompactWindow 450000 for the root), extraKnownMarketplaces, enabledPlugins and permissions.deny for WebSearch and WebFetch",
      "--scope picks the file like Claude Code's scopes: user (default) is CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json; project is .claude/settings.json and local is .claude/settings.local.json, both in the git top-level of the current directory when that is the current directory or above it and holds a .git entry, else in the current directory (a `~` line says so, outside a repository too); project and local refuse a symlinked settings file or .claude folder with a `!` line; ctx7 is installed for the user whatever the scope",
      "setup records the keys it adds, per settings file, in holyagent/setup-records.json under CLAUDE_CONFIG_DIR (else ~/.claude), outside the project",
      "--undo removes from the --scope file only what that record says setup added, and only while the value still equals what setup wrote: a changed value, and a key with no record (set before setup or by an earlier version), is kept and reported with `~`, so remove it by hand; permissions.deny loses only the entries setup added, and parent objects left empty are dropped; removed keys print `-` lines (`= nothing to remove` when absent); the file's record is cleared; ctx7 and the Pi packages stay installed; honors --dry-run",
      "a failed step is reported and the rest still run; in a claude.ai cloud session (CLAUDE_CODE_REMOTE=true) ctx7 is skipped and the settings are still merged",
    ],
    flags: {
      scope: "string",
      undo: "boolean",
      "dry-run": "boolean",
      "subagent-cache-ttl": "string",
      "skip-ctx7": "boolean",
    },
    stateless: true,
    positionals: 0,
    run: ({ args, env, cwd }) =>
      Effect.gen(function* () {
        const scope = yield* choiceFlag(
          ScopeFlag,
          "scope",
          stringFlag(args, "scope") ?? "user",
          SETUP_USAGE,
        )
        const subagentCacheTtl = yield* choiceFlag(
          CacheTtlFlag,
          "subagent-cache-ttl",
          stringFlag(args, "subagent-cache-ttl") ?? "1h",
          SETUP_USAGE,
        )
        const report = yield* setup(env, {
          scope,
          undo: booleanFlag(args, "undo"),
          cwd,
          subagentCacheTtl,
          dryRun: booleanFlag(args, "dry-run"),
          skipCtx7: booleanFlag(args, "skip-ctx7"),
        })
        return printed(report)
      }).pipe(Effect.provide(Shell.live(env))),
  },
  {
    path: ["doctor"],
    usage: DOCTOR_USAGE,
    summary:
      "Check bun, ctx7 and the settings of a scope, and, when Pi is in use, pi, node and the Pi packages the config enables; exit 1 when a check fails",
    output:
      "one line per check, `ok   <name>: …` or `FAIL <name>: …`; exit 1 when any check failed",
    notes: [
      "--scope picks the settings file to check, as for setup (user by default); --fix then merges into that file",
      "the Pi checks run when HOLYAGENT_HOST=pi or pi is on PATH and pi.enable is on; otherwise one `~ pi: not in use` line is printed and nothing fails; a missing Pi package line names its `pi install` command, and `holyagent setup` installs them",
      "--fix runs the setup steps behind a failing check, prints their lines, then checks again; it never installs Bun, Pi, Node or Pi packages",
    ],
    flags: { scope: "string", fix: "boolean" },
    stateless: true,
    positionals: 0,
    run: ({ args, env, cwd }) =>
      Effect.gen(function* () {
        const scope = yield* choiceFlag(
          ScopeFlag,
          "scope",
          stringFlag(args, "scope") ?? "user",
          DOCTOR_USAGE,
        )
        return printed(yield* doctor(env, { fix: booleanFlag(args, "fix"), scope, cwd }))
      }).pipe(Effect.provide(Shell.live(env))),
  },
]
