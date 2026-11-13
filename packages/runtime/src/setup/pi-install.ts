import { Effect, Option } from "effect"

import { type CapabilityForm, managedCapabilityPackages } from "../config/capabilities.ts"
import { piPackages, WEB_KIT_PACKAGE } from "../config/packages.ts"
import { PROVIDERS } from "../pi/provider.ts"
import { type Env, homeDirectory } from "./environment.ts"
import {
  type CapabilityChoices,
  listsAtPin,
  loadPiConfig,
  parseNpmSource,
  piAgentDirectory,
  piPresenceFiles,
  piSettingsFiles,
  piSettingsSources,
} from "./pi-check.ts"
import { added, failed, present, skipped } from "./report.ts"
import type { Scope } from "./scope.ts"
import { Shell } from "./shell.ts"

/**
 * The npm names of the packages setup removes when the config no longer selects them: the
 * capability packages of every form, the web kit and the provider profile packages. The HolyAgent
 * package and anything else HolyAgent does not ship are not here.
 */
const MANAGED_NAMES: ReadonlySet<string> = new Set<string>([
  ...managedCapabilityPackages(),
  WEB_KIT_PACKAGE,
  ...Object.values(PROVIDERS).flatMap((profile) =>
    profile.package === undefined ? [] : [profile.package],
  ),
])

/**
 * The managed packages (names in `managed`) that `listed` holds and `wanted` no longer names, once
 * each, in the order listed.
 */
export const staleManagedNames = (
  listed: ReadonlyArray<string>,
  wanted: ReadonlyArray<string>,
  managed: ReadonlySet<string> = MANAGED_NAMES,
): ReadonlyArray<string> => {
  const wantedNames = new Set(wanted.map((source) => parseNpmSource(source)?.name))
  return [
    ...new Set(
      listed.flatMap((source) => {
        const name = parseNpmSource(source)?.name
        return name !== undefined && managed.has(name) && !wantedNames.has(name) ? [name] : []
      }),
    ),
  ]
}

/** What the Pi step of `holyagent setup` was asked to do. */
export interface PiInstallOptions {
  /**
   * The scope setup runs at: `user` works on Pi's global settings and reads the user's own
   * HolyAgent config only, the others work on the project's settings and read its config too.
   */
  readonly scope: Scope
  /** The directory a project-level install runs in and finds `.pi/settings.json` from. */
  readonly cwd: string
  /** Say what would run and run nothing. */
  readonly dryRun: boolean
  /** The form every capability is applied in; `normal` when absent. */
  readonly form?: CapabilityForm
  /** Capability switches the run chose, laid over the config (see {@link loadPiConfig}). */
  readonly choices?: CapabilityChoices
}

/**
 * The Pi step of `holyagent setup`: makes the packages of Pi's settings match the HolyAgent config.
 * It runs `pi install npm:<name>@<pin>` for each source {@link piPackages} returns that the
 * settings of the scope do not list at that pin (the global file for scope `user`; the project's
 * file or the global one for `project` and `local`, as doctor counts them), and `pi remove
 * npm:<name>` for each managed package (the values of {@link FEATURE_PACKAGES}, the web kit and the
 * provider profile packages) that the settings of the chosen scope list but the config no longer
 * selects, because only those two commands write the `packages` list that Pi loads from. Removal
 * touches the chosen scope's file only. Scope `user` works on Pi's global settings and decides from
 * the user's HolyAgent config alone ({@link loadPiConfig}), so the repository it runs in cannot
 * remove a global package; `project` and `local` work on the project's `.pi/settings.json` with
 * `-l`, run in `cwd`, and read the project's config over the user's. With `pi.enable` off nothing
 * is installed or removed. On a dry run the lines say what would run. A failing command is a `!`
 * line and the others still run; a settings file of the chosen scope that is not valid Pi settings,
 * or a config that cannot be loaded, is a SetupFailure, while the other scope's file is ignored
 * when it is not valid.
 */
export const installPiPackages = Effect.fn("installPiPackages")(function* (
  env: Env,
  options: PiInstallOptions,
) {
  const shell = yield* Shell
  const config = yield* loadPiConfig(env, options.cwd, options.scope, options.choices)
  if (!config.pi.enable) return [skipped("pi packages: pi.enable is off in the HolyAgent config")]

  const projectLevel = options.scope !== "user"
  const [globalFile, projectFile] = piSettingsFiles(env, options.cwd)
  const file = projectLevel ? projectFile : globalFile
  const listed = yield* piSettingsSources(file)
  // Project and local scope also count the global file (Pi loads global packages in a project);
  // user scope counts the global file only, so a repository's .pi/settings.json cannot suppress
  // a global install. The global file is ignored here when it is not valid Pi settings.
  const counted = piPresenceFiles(env, options.cwd, options.scope).filter((other) => other !== file)
  const elsewhere = yield* Effect.forEach(counted, (other) =>
    piSettingsSources(other).pipe(
      Effect.map((sources) => ({ file: other, sources })),
      Effect.orElseSucceed(() => ({ file: other, sources: [] as ReadonlyArray<string> })),
    ),
  )
  const listedIn = (source: string) =>
    listsAtPin(listed, source)
      ? file
      : elsewhere.find((other) => listsAtPin(other.sources, source))?.file

  const wanted = piPackages(config, undefined, options.form)
  const installs = wanted.filter((source) => listedIn(source) === undefined)
  const removals = staleManagedNames(listed, wanted)
  const lines: Array<string> = wanted.flatMap((source) => {
    const where = listedIn(source)
    return where === undefined ? [] : [present(`pi ${source}: already listed in ${where}`)]
  })
  if (installs.length === 0 && removals.length === 0) return lines

  if (Option.isNone(yield* shell.which("pi"))) {
    return [
      ...lines,
      `! pi packages: pi not found on PATH, so the changes to ${file} cannot run; install Pi (\`holyagent doctor\` names the command), then re-run`,
    ]
  }

  // A project-level change runs in the project, whose .pi folder `-l` writes; Pi reads that
  // project's .npmrc and .pi/settings.json there. A global one runs in the home directory, so no
  // file of the current project steers Pi.
  const cwd = projectLevel ? options.cwd : homeDirectory(env)
  const withScope = (args: ReadonlyArray<string>) => (projectLevel ? [...args, "-l"] : args)
  for (const source of installs) {
    const args = withScope(["install", source])
    const command = `pi ${args.join(" ")}`
    if (options.dryRun) {
      lines.push(added(`pi ${source}: would install with ${command}`))
      continue
    }
    const result = yield* shell.run("pi", args, {
      cwd,
      env: { PI_CODING_AGENT_DIR: piAgentDirectory(env) },
    })
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
    const result = yield* shell.run("pi", args, {
      cwd,
      env: { PI_CODING_AGENT_DIR: piAgentDirectory(env) },
    })
    lines.push(
      result.exitCode === 0
        ? skipped(`pi npm:${name}: removed with ${command}; its feature is off`)
        : failed(command, result),
    )
  }
  return lines
})
