import { createHash, randomUUID } from "node:crypto"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

import { Context, Effect, Option } from "effect"

import release from "../../../../package.json" with { type: "json" }
import { type CapabilityForm, managedCapabilityPackages } from "../config/capabilities.ts"
import { piPackages, WEB_KIT_PACKAGE } from "../config/packages.ts"
import type { PiProviderSelection } from "../config/schema.ts"
import { PROVIDERS } from "../pi/provider.ts"
import { fileSystem } from "../ports/filesystem.ts"
import { type Env, homeDirectory } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import {
  fileExists,
  isJsonObject,
  readJsonObject,
  readJsonObjectSnapshot,
  writeJsonObjectIfUnchanged,
} from "./json-file.ts"
import { isBunxPackageRoot, isNpmExecPackageRoot } from "./package-runner.ts"
import {
  type CapabilityChoices,
  isHolyagentSource,
  listsAtPin,
  loadPiConfig,
  parseNpmSource,
  piAgentDirectory,
  piPresenceFiles,
  piSettingsFiles,
  piSettingsSources,
} from "./pi-check.ts"
import { reportSetupActivity } from "./progress.ts"
import { added, failed, hint, present, skipped } from "./report.ts"
import { refuseLinks, type Scope } from "./scope.ts"
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

const realPath = (path: string) =>
  fileSystem.pipe(
    Effect.flatMap((fs) => Effect.tryPromise(() => fs.realpath(path))),
    Effect.orElseSucceed(() => undefined),
  )

const installedLayout = (path: string) =>
  basename(path) === "holyagent" && basename(dirname(path)) === "node_modules"

const installedPackage = Effect.fn("installedPiPackage")(function* (path: string) {
  const invalid = new SetupFailure({
    message: `${JSON.stringify(path)} is not an installed HolyAgent ${release.version} package; install the CLI globally and run it again`,
  })
  if (!isAbsolute(path) || !installedLayout(path)) return yield* invalid
  const root = resolve(path)
  const physical = yield* realPath(root)
  if (physical === undefined || !installedLayout(physical)) return yield* invalid
  const manifest = yield* readJsonObject(join(root, "package.json"))
  if (
    manifest.name !== "holyagent" ||
    (manifest.version !== release.version &&
      !(
        typeof manifest.version === "string" &&
        manifest.version.startsWith(`${release.version}-dev.`)
      )) ||
    manifest.private === true ||
    !isJsonObject(manifest.pi) ||
    !Array.isArray(manifest.pi.extensions) ||
    !manifest.pi.extensions.includes("./extensions") ||
    !(yield* fileExists(join(root, "extensions", "holyagent.js")))
  )
    return yield* invalid
  return { root, physical, version: String(manifest.version) }
})

/** Resolves a Pi local package source relative to the settings file that holds it. */
export const piLocalSourcePath = (env: Env, file: string, source: string): string | undefined => {
  if (isAbsolute(source)) return resolve(source)
  if (/^(?:[a-z][a-z0-9+.-]*:|[^/\\]+@[^/\\]+:)/i.test(source)) return undefined
  if (source === "~" || /^~[/\\]/.test(source)) return resolve(homeDirectory(env), source.slice(2))
  return resolve(dirname(file), source)
}

const sourcePackageRoot = (path: string) =>
  basename(path) === "holyagent.js" && basename(dirname(path)) === "extensions"
    ? dirname(dirname(path))
    : path

/** Recognizes a local HolyAgent package, including its directly registered extension file. */
export const localHolyagentPackageAt = (path: string) =>
  readJsonObject(join(sourcePackageRoot(path), "package.json")).pipe(
    Effect.map((manifest) => manifest.name === "holyagent"),
    Effect.orElseSucceed(() => false),
  )

interface PackageSources {
  readonly file: string
  readonly sources: ReadonlyArray<string>
}

const registration = Effect.fn("planPiPackageRegistration")(function* (
  env: Env,
  path: string,
  settings: ReadonlyArray<PackageSources>,
  replace: boolean,
) {
  const { root, physical, version } = yield* installedPackage(path)
  const source = [root, physical].some(
    (path) => isBunxPackageRoot(path) || isNpmExecPackageRoot(path),
  )
    ? `npm:holyagent@${version}`
    : root
  let listedIn: string | undefined
  const conflicts: Array<{ readonly file: string; readonly prior: string }> = []
  for (const { file, sources } of settings) {
    for (const entry of sources) {
      const local = piLocalSourcePath(env, file, entry.trim())
      const actual = local === undefined ? undefined : yield* realPath(local)
      if (
        entry.trim() === source ||
        (source === root && actual !== undefined && relative(physical, actual) === "")
      ) {
        listedIn ??= file
      } else if (
        isHolyagentSource(entry.trim()) ||
        (actual !== undefined && (yield* localHolyagentPackageAt(actual)))
      ) {
        conflicts.push({ file, prior: entry })
      }
    }
  }
  const [conflict] = conflicts
  if (conflict !== undefined) {
    if (
      !replace ||
      conflicts.length !== 1 ||
      conflict.file !== settings[0]?.file ||
      listedIn !== undefined
    )
      return yield* new SetupFailure({
        message: `HolyAgent is already configured as ${JSON.stringify(conflict.prior)} in ${conflict.file}; review the existing registration in interactive setup at its scope before replacing it`,
      })
    return { source, prior: conflict.prior }
  }
  return listedIn === undefined ? { source } : { listedIn }
})

const entrySource = (entry: unknown): unknown => (isJsonObject(entry) ? entry.source : entry)

/** A replacement of one recognized registration and the exact entry inspected in preview. */
export interface PiRegistrationConflict {
  readonly file: string
  readonly prior: string
  readonly source: string
  readonly fingerprint: string
}

/** Carries the interactive preview and approval without changing the unattended setup input. */
export const PiRegistrationReview = Context.Reference<
  | { readonly preview?: (conflict: PiRegistrationConflict) => void; readonly expected?: string }
  | undefined
>("holyagent/setup/PiRegistrationReview", { defaultValue: () => undefined })

const registrationEntry = (settings: Readonly<Record<string, unknown>>, source: string) => {
  if (!Array.isArray(settings.packages)) return undefined
  const matching = (settings.packages as ReadonlyArray<unknown>).filter(
    (entry) => entrySource(entry) === source,
  )
  return matching.length === 1 ? matching[0] : undefined
}

const backupRegistration = Effect.fn("backupPiRegistration")(function* (
  file: string,
  source: string,
  entry: unknown,
) {
  const path = `${file}.holyagent-package.${randomUUID()}.bak`
  const fs = yield* fileSystem
  yield* Effect.tryPromise({
    try: () =>
      fs.writeFile(path, `${JSON.stringify({ source, entry }, undefined, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      }),
    catch: (cause) =>
      new SetupFailure({
        message: `Could not back up the Pi registration to ${path}: ${String(cause)}`,
      }),
  })
  return path
})

/** On a failed native install, only reverse the exact removal of the reviewed entry. */
const restoreRegistration = Effect.fn("restorePiRegistration")(function* (
  file: string,
  prior: string,
  before: Readonly<Record<string, unknown>>,
) {
  const current = yield* readJsonObjectSnapshot(file)
  if (current.text === undefined || !Array.isArray(before.packages)) return false
  const withoutPrior = (before.packages as ReadonlyArray<unknown>).filter(
    (entry) => entrySource(entry) !== prior,
  )
  if (JSON.stringify(current.value.packages) !== JSON.stringify(withoutPrior)) return false
  return yield* writeJsonObjectIfUnchanged(
    file,
    { ...current.value, packages: before.packages },
    current.text,
  )
})

/** Keep the old source until Pi has installed the new one. Preserve its package filters in place. */
const retireRegistration = Effect.fn("retirePiRegistration")(function* (
  file: string,
  prior: string,
  source: string,
  previousEntry: unknown,
) {
  const current = yield* readJsonObjectSnapshot(file)
  const packages: ReadonlyArray<unknown> = Array.isArray(current.value.packages)
    ? current.value.packages
    : []
  const old = packages.filter((entry) => entrySource(entry) === prior)
  if (
    current.text === undefined ||
    packages.filter((entry) => entrySource(entry) === source).length !== 1 ||
    old.length > 1 ||
    (old.length === 1 && JSON.stringify(old[0]) !== JSON.stringify(previousEntry))
  )
    return yield* new SetupFailure({
      message: `${file}: the Pi registration changed during install; kept the previous source where it was still present`,
    })
  const replacement = isJsonObject(previousEntry) ? { ...previousEntry, source } : source
  const next = packages.flatMap((entry) => {
    const key = entrySource(entry)
    if (key === prior) return [replacement]
    if (key === source) return old.length === 0 ? [replacement] : []
    return [entry]
  })
  if (
    !(yield* writeJsonObjectIfUnchanged(file, { ...current.value, packages: next }, current.text))
  )
    return yield* new SetupFailure({
      message: `${file}: settings changed while replacing the package; did not remove the previous source`,
    })
})

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
  /** Absolute package root supplied by the installed public launcher. */
  readonly installedPackageRoot?: string
  /** Public review explicitly authorizes replacement at the selected scope. */
  readonly replacePiRegistration?: boolean
  /** The form every capability is applied in; `normal` when absent. */
  readonly form?: CapabilityForm
  /** Capability switches the run chose, laid over the config (see {@link loadPiConfig}). */
  readonly choices?: CapabilityChoices
  /** Explicit provider selection used by preflight and setup. */
  readonly providers?: PiProviderSelection
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
 * when it is not valid. When the public launcher supplies its installed package root, setup
 * registers that directory with Pi first. An existing different HolyAgent entry or an unreadable
 * settings file that could hold one stops registration before running a package command.
 */
export const installPiPackages = Effect.fn("installPiPackages")(function* (
  env: Env,
  options: PiInstallOptions,
) {
  const shell = yield* Shell
  const config = yield* loadPiConfig(
    env,
    options.cwd,
    options.scope,
    options.choices,
    options.providers,
  )
  if (!config.pi.enable) return [skipped("pi packages: pi.enable is off in the HolyAgent config")]

  const projectLevel = options.scope !== "user"
  const [globalFile, projectFile] = piSettingsFiles(env, options.cwd)
  const file = projectLevel ? projectFile : globalFile
  if (options.installedPackageRoot !== undefined)
    yield* refuseLinks(options.cwd, options.scope, file, "register the installed HolyAgent package")
  const listed = yield* piSettingsSources(file)
  // Project and local scope also count the global file (Pi loads global packages in a project);
  // user scope counts the global file only, so a repository's .pi/settings.json cannot suppress
  // a global install. Only the installed-package path needs every relevant file readable to
  // reject a conflicting HolyAgent registration.
  const counted = piPresenceFiles(env, options.cwd, options.scope).filter((other) => other !== file)
  const elsewhere = yield* Effect.forEach(counted, (other) => {
    const read = piSettingsSources(other).pipe(
      Effect.map((sources): PackageSources => ({ file: other, sources })),
    )
    return options.installedPackageRoot === undefined
      ? read.pipe(Effect.orElseSucceed((): PackageSources => ({ file: other, sources: [] })))
      : read
  })
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
  if (listed.some((source) => parseNpmSource(source)?.name === "@amaster.ai/pi-computer-use"))
    lines.push(
      skipped(
        "pi computer-use: legacy package registration has no ownership receipt and was kept; HolyAgent uses the official Cua Driver instead",
      ),
    )
  const review = yield* PiRegistrationReview
  let replacement:
    | { readonly source: string; readonly prior: string; readonly entry: unknown }
    | undefined
  if (options.installedPackageRoot !== undefined) {
    const match = yield* registration(
      env,
      options.installedPackageRoot,
      [{ file, sources: listed }, ...elsewhere],
      options.replacePiRegistration === true,
    )
    if (match.source === undefined)
      lines.unshift(present(`pi package: installed HolyAgent already listed in ${match.listedIn}`))
    else {
      if (match.prior !== undefined) {
        const { source, prior } = match
        const entry = registrationEntry(yield* readJsonObject(file), prior)
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([file, prior, source, entry]))
          .digest("hex")
        if (
          entry === undefined ||
          (!options.dryRun && review !== undefined && review.expected !== fingerprint)
        )
          return yield* new SetupFailure({
            message: `${file}: the Pi registration changed after review; review it again`,
          })
        if (options.dryRun && review?.preview !== undefined)
          yield* Effect.sync(() => review.preview?.({ file, prior, source, fingerprint }))
        replacement = { source, prior, entry }
        lines.unshift(
          added(
            `pi package: replace ${JSON.stringify(match.prior)} with ${JSON.stringify(match.source)} in ${file}`,
          ),
        )
      }
      installs.unshift(match.source)
    }
  }
  if (replacement === undefined && !options.dryRun && review?.expected !== undefined)
    return yield* new SetupFailure({
      message: `${file}: the Pi registration changed after review; review it again`,
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
    const commit = replacement?.source === source ? replacement : undefined
    yield* reportSetupActivity(`Installing ${source}`)
    const install = shell.run("pi", args, {
      cwd,
      env: { PI_CODING_AGENT_DIR: piAgentDirectory(env) },
    })
    if (commit === undefined) {
      const result = yield* install
      lines.push(
        result.exitCode === 0
          ? added(`pi ${source}: installed with ${command}`)
          : failed(command, result),
      )
      continue
    }
    const priorIsUnchanged = (state: Readonly<Record<string, unknown>>) =>
      JSON.stringify(registrationEntry(state, commit.prior)) === JSON.stringify(commit.entry)
    const readRegistration = readJsonObject(file).pipe(
      Effect.orElseSucceed((): Readonly<Record<string, unknown>> => ({})),
    )
    if (!priorIsUnchanged(yield* readRegistration))
      return [
        ...lines,
        `! pi package: ${file} changed before install; the previous registration was not replaced`,
      ]
    const backup = yield* backupRegistration(file, source, commit.entry)
    const discardBackupIfOriginalRemains = Effect.gen(function* () {
      if (!priorIsUnchanged(yield* readRegistration)) return false
      const fs = yield* fileSystem
      return yield* Effect.tryPromise(() => fs.rm(backup, { force: true })).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
    })
    const backupHint = added(`pi package: saved the previous registration in ${backup}`)
    const beforeInstall = yield* readRegistration
    if (
      !priorIsUnchanged(beforeInstall) ||
      (Array.isArray(beforeInstall.packages) &&
        beforeInstall.packages.some((entry) => entrySource(entry) === source))
    )
      return [
        ...lines,
        backupHint,
        `! pi package: ${file} changed before install; the previous registration was not replaced`,
      ]
    const result = yield* install
    if (result.exitCode !== 0) {
      const discardedBackup = yield* discardBackupIfOriginalRemains
      const restored = discardedBackup
        ? false
        : yield* restoreRegistration(file, commit.prior, beforeInstall).pipe(
            Effect.orElseSucceed(() => false),
          )
      return [
        ...lines,
        ...(discardedBackup ? [] : [backupHint]),
        ...(restored
          ? [
              hint(
                `pi package: restored the previous registration in ${file}; the package files were not verified`,
              ),
            ]
          : []),
        failed(command, result),
      ]
    }
    const retirement = yield* retireRegistration(file, commit.prior, source, commit.entry).pipe(
      Effect.result,
    )
    if (retirement._tag === "Failure")
      return [
        ...lines,
        ...((yield* discardBackupIfOriginalRemains) ? [] : [backupHint]),
        `! pi package: ${retirement.failure.message}`,
      ]
    lines.push(backupHint, added(`pi ${source}: installed with ${command}`))
  }
  for (const name of removals) {
    const args = withScope(["remove", `npm:${name}`])
    const command = `pi ${args.join(" ")}`
    if (options.dryRun) {
      lines.push(skipped(`pi npm:${name}: would remove with ${command}; its feature is off`))
      continue
    }
    yield* reportSetupActivity(`Removing npm:${name}`)
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
