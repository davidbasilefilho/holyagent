import { join } from "node:path"

import { Effect, Option } from "effect"

import { FEATURE_PACKAGES, piPackages, WEB_KIT_PACKAGE } from "../config/packages.ts"
import { type Env, homeDirectory } from "./environment.ts"
import {
  listsAtPin,
  loadPiConfig,
  parseNpmSource,
  piAgentDirectory,
  piSettingsSources,
} from "./pi-check.ts"
import { added, failed, present, skipped } from "./report.ts"
import type { Scope } from "./scope.ts"
import { Shell } from "./shell.ts"

/** The npm names of the packages setup removes when the config turns their feature off. */
const MANAGED_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(FEATURE_PACKAGES),
  WEB_KIT_PACKAGE,
])

/** What the Pi step of `holyagent setup` was asked to do. */
export interface PiInstallOptions {
  /** The scope setup runs at: `user` works on Pi's global settings, the others on the project's. */
  readonly scope: Scope
  /** The directory a project-level install runs in and finds `.pi/settings.json` from. */
  readonly cwd: string
  /** Say what would run and run nothing. */
  readonly dryRun: boolean
}

/**
 * The Pi step of `holyagent setup`: makes the packages of Pi's settings match the HolyAgent config.
 * It runs `pi install npm:<name>@<pin>` for each source {@link piPackages} returns that the
 * settings do not list at that pin, and `pi remove npm:<name>` for each feature package (the values
 * of {@link FEATURE_PACKAGES} and the web kit) the settings list but the config no longer enables,
 * because only those two commands write the `packages` list that Pi loads from. Scope `user` works
 * on Pi's global settings; `project` and `local` work on the project's `.pi/settings.json` with
 * `-l`, run in `cwd`. With `pi.enable` off nothing is installed or removed. On a dry run the lines
 * say what would run. A failing command is a `!` line and the others still run; a settings file
 * that is not valid Pi settings, or a config that cannot be loaded, is a SetupFailure.
 */
export const installPiPackages = Effect.fn("installPiPackages")(function* (
  env: Env,
  options: PiInstallOptions,
) {
  const shell = yield* Shell
  const config = yield* loadPiConfig(env, options.cwd)
  if (!config.pi.enable) return [skipped("pi packages: pi.enable is off in the HolyAgent config")]

  const projectLevel = options.scope !== "user"
  const file = projectLevel
    ? join(options.cwd, ".pi", "settings.json")
    : join(piAgentDirectory(env), "settings.json")
  const listed = yield* piSettingsSources(file)

  const wanted = piPackages(config)
  const wantedNames = new Set(wanted.map((source) => parseNpmSource(source)?.name))
  const installs = wanted.filter((source) => !listsAtPin(listed, source))
  const removals = [
    ...new Set(
      listed.flatMap((source) => {
        const name = parseNpmSource(source)?.name
        return name !== undefined && MANAGED_NAMES.has(name) && !wantedNames.has(name) ? [name] : []
      }),
    ),
  ]
  const lines: Array<string> = wanted
    .filter((source) => listsAtPin(listed, source))
    .map((source) => present(`pi ${source}: already listed in ${file}`))
  if (installs.length === 0 && removals.length === 0) return lines

  if (Option.isNone(yield* shell.which("pi"))) {
    return [
      ...lines,
      `! pi packages: pi not found on PATH, so the changes to ${file} cannot run; install Pi (\`holyagent doctor\` names the command), then re-run`,
    ]
  }

  // A project-level change runs in the project, whose .pi folder `-l` writes; a global one in the
  // home directory, so no file of the current project steers Pi.
  const cwd = projectLevel ? options.cwd : homeDirectory(env)
  const withScope = (args: ReadonlyArray<string>) => (projectLevel ? [...args, "-l"] : args)
  for (const source of installs) {
    const args = withScope(["install", source])
    const command = `pi ${args.join(" ")}`
    if (options.dryRun) {
      lines.push(added(`pi ${source}: would install with ${command}`))
      continue
    }
    const result = yield* shell.run("pi", args, { cwd })
    lines.push(
      result.exitCode === 0
        ? added(`pi ${source}: installed with ${command}`)
        : failed(command, result),
    )
  }
  for (const name of removals) {
    const args = withScope(["remove", `npm:${name}`])
    const command = `pi ${args.join(" ")}`
    if (options.dryRun) {
      lines.push(skipped(`pi npm:${name}: would remove with ${command}; its feature is off`))
      continue
    }
    const result = yield* shell.run("pi", args, { cwd })
    lines.push(
      result.exitCode === 0
        ? skipped(`pi npm:${name}: removed with ${command}; its feature is off`)
        : failed(command, result),
    )
  }
  return lines
})
