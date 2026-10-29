import { Console, Effect, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"

import { findLeftovers } from "../claude/leftovers.ts"
import { PLUGIN_ID, projectDefaults, settingsPath } from "../claude/project.ts"
import { userFiles } from "../claude/user.ts"
import { applyDefaults, readJsonObject } from "../json-file.ts"
import { CliFailure, type Report } from "../report.ts"
import { Shell } from "../shell.ts"

const InstalledPlugins = Schema.Array(Schema.Struct({ id: Schema.String }))

const pass = (name: string, detail: string) => `ok   ${name}: ${detail}`
const fail = (name: string, detail: string) => `FAIL ${name}: ${detail}`

const checkBun = Effect.fn("checkBun")(function* (fix: boolean) {
  const shell = yield* Shell
  const revision = () =>
    shell.run("bun", ["--revision"]).pipe(Effect.map((result) => result.stdout.trim()))
  const current = yield* revision()
  if (current.includes("canary")) return pass("bun", current)
  if (!fix) {
    return fail(
      "bun",
      `${current === "" ? "not found" : `${current} is not a canary build`}; run: holyagent doctor --fix`,
    )
  }
  // BUN_OPTIONS=--smol makes `bun upgrade` fail, and a mise-managed Bun update brings stable back.
  const upgrade = yield* shell.run("bun", ["upgrade", "--canary"], { unsetEnv: ["BUN_OPTIONS"] })
  const after = yield* revision()
  if (upgrade.exitCode === 0 && after.includes("canary"))
    return pass("bun", `${after} (upgraded from ${current})`)
  return fail(
    "bun",
    `bun upgrade --canary did not produce a canary build (exit ${upgrade.exitCode})`,
  )
})

const checkCommand = (command: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const found = yield* shell.which(command)
    return Option.isSome(found) ? pass(command, found.value) : fail(command, "not found on PATH")
  })

const checkSettings = (directory: string) =>
  Effect.gen(function* () {
    const file = yield* settingsPath(directory)
    const existing = yield* readJsonObject(file)
    const { entries } = applyDefaults(existing, projectDefaults("1h"))
    const missing = entries.filter((entry) => entry.status === "added").map((entry) => entry.path)
    return missing.length === 0
      ? pass("settings", file)
      : fail("settings", `${file} lacks ${missing.join(", ")}; run: holyagent setup claude`)
  }).pipe(Effect.catchTag("CliFailure", (error) => Effect.succeed(fail("settings", error.message))))

const warn = (name: string, detail: string) => `warn ${name}: ${detail}`

/**
 * Warns when an earlier Billion Context setup left entries in the Claude Code files, and when a
 * file could not be read, because then its entries were not checked.
 */
const checkLeftovers = Effect.gen(function* () {
  const leftovers = yield* findLeftovers(yield* userFiles)
  const notes = [
    ...(leftovers.found.length === 0
      ? []
      : [
          `${leftovers.found.length} leftover(s) from an earlier setup: ${leftovers.found.join("; ")}; run: holyagent setup claude`,
        ]),
    ...(leftovers.unreadable.length === 0
      ? []
      : [`not checked, ${leftovers.unreadable.join("; ")}`]),
  ]
  return notes.length === 0
    ? pass("billion-context", "no leftovers from an earlier setup")
    : warn("billion-context", notes.join(" | "))
}).pipe(
  Effect.catchTag("CliFailure", (error) => Effect.succeed(fail("billion-context", error.message))),
)

const checkPlugin = Effect.gen(function* () {
  const shell = yield* Shell
  if (Option.isNone(yield* shell.which("claude")))
    return fail("plugin", `${PLUGIN_ID} cannot be checked without claude`)
  const listing = yield* shell.run("claude", ["plugin", "list", "--json"])
  const installed =
    listing.exitCode === 0
      ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledPlugins))(
          listing.stdout,
        ).pipe(Effect.option)
      : Option.none()
  if (Option.isNone(installed)) return fail("plugin", "claude plugin list failed")
  return installed.value.some((plugin) => plugin.id === PLUGIN_ID)
    ? pass("plugin", `${PLUGIN_ID} installed`)
    : fail("plugin", `${PLUGIN_ID} not installed; run: holyagent setup claude`)
})

/**
 * Checks the environment HolyAgent needs, one line per check: a canary Bun, `claude` and `ctx7` on
 * PATH, the project settings from `holyagent setup claude`, the installed plugin, and leftovers of
 * an earlier Billion Context setup (a warning, not a failure). With `fix`, a Bun that is not canary
 * is upgraded.
 */
export const doctor = Effect.fn("doctor")(function* (options: {
  readonly directory: string
  readonly fix: boolean
}) {
  const lines = [
    yield* checkBun(options.fix),
    yield* checkCommand("claude"),
    yield* checkCommand("ctx7"),
    yield* checkSettings(options.directory),
    yield* checkPlugin,
    yield* checkLeftovers,
  ]
  // A warning is shown but does not fail the run.
  return { lines, ok: !lines.some((line) => line.startsWith("FAIL ")) } satisfies Report
})

/** The `holyagent doctor` command. */
export const doctorCommand = Command.make(
  "doctor",
  {
    fix: Flag.Boolean("fix").pipe(
      Flag.withDescription("Upgrade Bun to a canary build when it is not one"),
      Flag.withDefault(false),
    ),
  },
  ({ fix }) =>
    doctor({ directory: ".", fix }).pipe(
      Effect.flatMap((report) =>
        Console.log(report.lines.join("\n")).pipe(
          Effect.andThen(report.ok ? Effect.void : Effect.fail(new CliFailure({ message: "" }))),
        ),
      ),
    ),
)
  .pipe(
    Command.withDescription(
      "Check Bun (canary), claude, ctx7, this project's settings and the HolyAgent plugin, and warn about Billion Context leftovers; exit 1 when a check fails.",
    ),
  )
  .pipe(
    Command.withShortDescription(
      "Check the environment HolyAgent needs; exit 1 when a check fails",
    ),
  )
