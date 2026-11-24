import { isAbsolute, join, relative } from "node:path"

import { Effect, Option, Schema } from "effect"

import { version as installedVersion } from "../../../../package.json" with { type: "json" }
import { localHolyagentPackageAt, piLocalSourcePath } from "../../../core/src/setup/pi-install.ts"
import { type Env, homeDirectory } from "../setup/environment.ts"
import { readJsonObject } from "../setup/json-file.ts"
import {
  isHolyagentSource,
  parseNpmSource,
  piAgentDirectory,
  piSettingsFiles,
  piSettingsSources,
} from "../setup/pi-check.ts"
import { Shell, shellLive, type ShellResult } from "../setup/shell.ts"
import { booleanFlag, choiceFlag, stringFlag } from "./args.ts"
import { type Command, Verbatim } from "./types.ts"

const RELEASE = Schema.String.check(Schema.isPattern(/^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/))
const VERSION_RESPONSE = Schema.fromJsonString(RELEASE)
const REGISTRY = "https://registry.npmjs.org/"
const USAGE = "update [--version <0.x.y>] [--dry-run]"

const failure = (message: string, result?: ShellResult) => {
  const details = result?.stderr.trim() || result?.stdout.trim()
  return new Verbatim("", details ? `${message}\n${details}\n` : `${message}\n`, 1)
}

/** Installs the same verified stable npm version in Pi and on the global command path. */
export const updateInstallation = Effect.fn("updateInstallation")(function* (
  env: Env,
  requested: string | undefined,
  dryRun: boolean,
  installedPackageRoot?: string,
) {
  const target =
    requested === undefined ? undefined : yield* choiceFlag(RELEASE, "version", requested, USAGE)
  const shell = yield* Shell
  if (Option.isNone(yield* shell.which("npm")))
    return failure("npm was not found. Install Node.js and reopen your terminal.")
  if (Option.isNone(yield* shell.which("pi")))
    return failure("Pi was not found. Install the Pi backend from the HolyAgent quickstart.")

  const cwd = homeDirectory(env)
  const [settings] = piSettingsFiles(env, cwd)
  const sources = yield* piSettingsSources(settings)
  let managed = 0
  let npmRegistered = false
  for (const entry of sources) {
    const source = entry.trim()
    const npm = parseNpmSource(source)
    if (npm !== undefined) {
      npmRegistered ||= npm.name.trim() === "holyagent"
      continue
    }
    const local = piLocalSourcePath(env, settings, source)
    if (
      local !== undefined &&
      installedPackageRoot !== undefined &&
      isAbsolute(installedPackageRoot) &&
      relative(installedPackageRoot, local) === ""
    ) {
      managed++
      continue
    }
    if (
      isHolyagentSource(source) ||
      (local !== undefined && (yield* localHolyagentPackageAt(local)))
    )
      return failure(
        "Pi is loading HolyAgent from Git or a local path. Remove that source before switching to npm with the HolyAgent quickstart.",
      )
  }
  if (managed > 1 || (managed === 1 && npmRegistered))
    return failure("Pi has multiple HolyAgent registrations. Keep the intended source and retry.")

  const registeredRoot = managed === 1 ? installedPackageRoot : undefined
  if (registeredRoot !== undefined) {
    const root = yield* shell.run("npm", ["root", "--global"], { cwd })
    if (root.exitCode !== 0)
      return failure("Could not verify npm's global installation path.", root)
    const location = root.stdout.trim()
    if (!isAbsolute(location) || relative(registeredRoot, join(location, "holyagent")) !== "")
      return failure(
        "Pi is loading the installed HolyAgent from a different location than npm's global path. Update it with the package manager that installed it.",
      )
  }
  const selected = yield* shell.run(
    "npm",
    ["view", `holyagent@${target ?? "latest"}`, "version", "--json", "--registry", REGISTRY],
    { cwd },
  )
  if (selected.exitCode !== 0)
    return failure("Could not resolve the HolyAgent release on npm.", selected)
  const decoded = yield* Schema.decodeUnknownEffect(VERSION_RESPONSE)(selected.stdout).pipe(
    Effect.option,
  )
  if (Option.isNone(decoded) || (target !== undefined && decoded.value !== target))
    return failure("npm did not return the requested stable HolyAgent version.")
  const version = decoded.value
  if (Bun.semver.order(version, installedVersion) < 0)
    return failure(`HolyAgent ${version} is older than the running version ${installedVersion}.`)
  if (dryRun)
    return new Verbatim(
      `Would install HolyAgent ${version} in Pi and on the npm global PATH.\n`,
      "",
      0,
    )

  const source = `holyagent@${version}`
  if (registeredRoot === undefined) {
    const pi = yield* shell.run("pi", ["install", `npm:${source}`], {
      cwd,
      env: {
        PI_CODING_AGENT_DIR: piAgentDirectory(env),
        npm_config_registry: REGISTRY,
        npm_config_ignore_scripts: "true",
      },
    })
    if (pi.exitCode !== 0)
      return failure("The Pi backend update failed. The global commands were left in place.", pi)
  }

  const npm = yield* shell.run(
    "npm",
    [
      "install",
      "-g",
      "--ignore-scripts",
      ...(registeredRoot === undefined ? ["--legacy-peer-deps"] : []),
      "--registry",
      REGISTRY,
      source,
    ],
    { cwd },
  )
  if (registeredRoot !== undefined) {
    const manifest = yield* readJsonObject(join(registeredRoot, "package.json")).pipe(Effect.option)
    if (
      npm.exitCode !== 0 ||
      Option.isNone(manifest) ||
      manifest.value.name !== "holyagent" ||
      manifest.value.version !== version
    )
      return failure(
        `Could not verify HolyAgent ${version} at the registered npm path. Reinstall that release in the same npm global prefix and check holyagent --version.`,
        npm,
      )
  } else if (npm.exitCode !== 0)
    return failure(
      `Pi has HolyAgent ${version}. The global command update failed. Retry with holyagent update --version ${version}.`,
      npm,
    )

  return new Verbatim(
    `Installed HolyAgent ${version} in Pi and on the npm global PATH. Restart T3 Code to load it.\n`,
    "",
    0,
  )
})

/** Human-facing commands for maintaining the installed package. */
export const PUBLIC_MAINTENANCE_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["update"],
    usage: USAGE,
    summary: "Update the Pi package and the global HolyAgent commands together",
    notes: [
      "Uses the latest stable release unless --version names a published version.",
      "Use --dry-run to check the target version without installing it.",
    ],
    flags: { version: "string", "dry-run": "boolean" },
    stateless: true,
    positionals: 0,
    run: ({ args, env, installedPackageRoot }) =>
      updateInstallation(
        env,
        stringFlag(args, "version"),
        booleanFlag(args, "dry-run"),
        installedPackageRoot,
      ).pipe(Effect.provide(shellLive(env))),
  },
]
