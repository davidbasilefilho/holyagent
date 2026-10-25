import { Console, Effect } from "effect"
import { Command, Flag } from "effect/cli"

import { CACHE_TTLS, setupProject } from "../claude/project.ts"
import { asStep, setupUser } from "../claude/user.ts"
import { CliFailure, type Report } from "../report.ts"

/**
 * Sets up Claude Code for HolyAgent: the plugin, Billion Context and ctx7 for the current user,
 * then the project settings. Every step is idempotent, a step that fails does not stop the next
 * one, and on a dry run nothing is installed or written.
 */
export const setupClaude = Effect.fn("setupClaude")(function* (options: {
  readonly directory: string
  readonly subagentCacheTtl: (typeof CACHE_TTLS)[number]
  readonly dryRun: boolean
  readonly skipBillionContext: boolean
  readonly skipCtx7: boolean
}) {
  const user = yield* setupUser(options)
  const project = yield* asStep(
    "project settings",
    setupProject(options).pipe(Effect.map((report) => report.lines)),
  )
  const lines = [...user.lines, ...project]
  return { lines, ok: !lines.some((line) => line.startsWith("! ")) } satisfies Report
})

/** The `holyagent setup claude` command. */
export const setupClaudeCommand = Command.make(
  "claude",
  {
    directory: Flag.Directory("dir", { mustExist: true }).pipe(
      Flag.withDescription("Project directory (default: the current directory)"),
      Flag.withDefault("."),
    ),
    subagentCacheTtl: Flag.Literals("subagent-cache-ttl", CACHE_TTLS).pipe(
      Flag.withDescription("Prompt cache lifetime for subagents (default: 1h)"),
      Flag.withDefault("1h"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Show what would change and install or write nothing"),
      Flag.withDefault(false),
    ),
    skipBillionContext: Flag.Boolean("skip-billion-context").pipe(
      Flag.withDescription("Do not install Billion Context"),
      Flag.withDefault(false),
    ),
    skipCtx7: Flag.Boolean("skip-ctx7").pipe(
      Flag.withDescription("Do not install ctx7 or its skill"),
      Flag.withDefault(false),
    ),
  },
  (options) =>
    setupClaude(options).pipe(
      Effect.flatMap((report) =>
        Console.log(report.lines.join("\n")).pipe(
          Effect.andThen(report.ok ? Effect.void : Effect.fail(new CliFailure({ message: "" }))),
        ),
      ),
    ),
)
  .pipe(
    Command.withDescription(
      [
        "Install and configure HolyAgent for Claude Code, skipping every step that is already done.",
        "For your user: the plugin (claude plugin marketplace add + install), Billion Context with Bun and its",
        "Claude Code native mode (it routes Claude Code traffic through a local proxy and turns off",
        "auto-compact) with compress.rules set only when absent, and ctx7 with the Context7 skill (needs",
        "CONTEXT7_API_KEY or a saved login; the key is passed on the command line to ctx7 setup).",
        "For the project: .claude/settings.json gets the keys a plugin cannot set, without changing anything",
        "already set: attribution (empty commit and PR text, no session URL), includeGitInstructions false",
        "(removes the built-in commit/PR instructions and the git status snapshot from context),",
        "subagentPromptCacheTtl, and the marketplace entries (HolyAgent and Billion Context) and the",
        "plugin entry that offer the plugin to teammates.",
        "A failed step is reported and the rest still run; the exit code is 1 when any step failed.",
      ].join(" "),
    ),
  )
  .pipe(
    Command.withShortDescription(
      "Install the HolyAgent plugin, Billion Context and ctx7, and configure this project",
    ),
  )
