import { Effect, Schema } from "effect"

import { doctor } from "../setup/doctor.ts"
import type { Report } from "../setup/report.ts"
import { CACHE_TTLS } from "../setup/settings.ts"
import { Shell } from "../setup/shell.ts"
import { setup } from "../setup/steps.ts"
import { booleanFlag, choiceFlag, stringFlag } from "./args.ts"
import { type Command, Verbatim } from "./types.ts"

const CacheTtlFlag = Schema.Literals(CACHE_TTLS)

/** A report as the text of stdout, one line each, and exit 1 when any step failed. */
const printed = (report: Report) =>
  new Verbatim(`${report.lines.join("\n")}\n`, "", report.ok ? 0 : 1)

const SETUP_USAGE = "setup [--dry-run] [--subagent-cache-ttl 1h|5m] [--skip-ctx7]"

/**
 * The `setup` and `doctor` commands, which install and check what HolyAgent needs beside the
 * plugin. Both are stateless: they work on the user's machine, not on a project.
 */
export const SETUP_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["setup"],
    usage: SETUP_USAGE,
    summary:
      "Install and configure what HolyAgent needs beside the plugin, skipping every step already done",
    output:
      "report lines: `+` added, `=` already in place, `-` skipped, `~` kept or needs you, `!` failed; exit 1 when any step failed",
    notes: [
      "installs ctx7 with the Context7 skill (needs CONTEXT7_API_KEY or a saved login)",
      "removes what an earlier Billion Context setup left in your Claude Code files (the local proxy base URL and DISABLE_AUTO_COMPACT in settings.json, its hook, the bili MCP server, commands/acp-cache.md, and its plugin and marketplace), only entries that match what it wrote, and prints each entry it removes",
      "merges these keys into the user settings (CLAUDE_CONFIG_DIR, else ~/.claude/settings.json) without changing any value already set: attribution, includeGitInstructions, subagentPromptCacheTtl, extraKnownMarketplaces, enabledPlugins and permissions.deny for WebSearch and WebFetch",
      "a failed step is reported and the rest still run; in a claude.ai cloud session (CLAUDE_CODE_REMOTE=true) ctx7 is skipped and the settings are still merged",
    ],
    flags: {
      "dry-run": "boolean",
      "subagent-cache-ttl": "string",
      "skip-ctx7": "boolean",
    },
    stateless: true,
    positionals: 0,
    run: ({ args, env }) =>
      Effect.gen(function* () {
        const subagentCacheTtl = yield* choiceFlag(
          CacheTtlFlag,
          "subagent-cache-ttl",
          stringFlag(args, "subagent-cache-ttl") ?? "1h",
          SETUP_USAGE,
        )
        const report = yield* setup(env, {
          subagentCacheTtl,
          dryRun: booleanFlag(args, "dry-run"),
          skipCtx7: booleanFlag(args, "skip-ctx7"),
        })
        return printed(report)
      }).pipe(Effect.provide(Shell.live(env))),
  },
  {
    path: ["doctor"],
    usage: "doctor [--fix]",
    summary:
      "Check bun, ctx7 and the user settings, and warn about Billion Context leftovers; exit 1 when a check fails",
    output:
      "one line per check, `ok   <name>: …` or `FAIL <name>: …`; exit 1 when any check failed",
    notes: [
      "--fix runs the setup steps behind a failing check, prints their lines, then checks again; it never installs Bun",
    ],
    flags: { fix: "boolean" },
    stateless: true,
    positionals: 0,
    run: ({ args, env }) =>
      doctor(env, { fix: booleanFlag(args, "fix") }).pipe(
        Effect.map(printed),
        Effect.provide(Shell.live(env)),
      ),
  },
]
