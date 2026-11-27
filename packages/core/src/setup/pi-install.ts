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

interface RegistrationSource {
  readonly source: string
  /** The verified installed directory for a local source. Registry pins stay opaque. */
  readonly physical?: string
}

const matchesRegistration = (
  target: RegistrationSource,
  source: string,
  physical: string | undefined,
) =>
  target.physical === undefined
    ? source === target.source
    : physical !== undefined && relative(target.physical, physical) === ""

const exactHolyagentPin =
  /^npm:holyagent@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/

const registration = Effect.fn("planPiPackageRegistration")(function* (
  env: Env,
  path: string,
  settings: ReadonlyArray<PackageSources>,
  replace: boolean,
) {
  const { root, physical, version } = yield* installedPackage(path)
  const cached = [root, physical].some(
    (path) => isBunxPackageRoot(path) || isNpmExecPackageRoot(path),
  )
  const target: RegistrationSource = cached
    ? { source: `npm:holyagent@${version}` }
    : { source: root, physical }
  let listedIn: string | undefined
  let matches = 0
  const conflicts: Array<{ readonly file: string; readonly prior: string }> = []
  for (const { file, sources } of settings) {
    for (const entry of sources) {
      const local = piLocalSourcePath(env, file, entry.trim())
      const actual = local === undefined ? undefined : yield* realPath(local)
      if (matchesRegistration(target, entry, actual)) {
        listedIn ??= file
        matches++
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
    const repair =
      target.physical !== undefined &&
      conflicts.length === 1 &&
      conflict.file === settings[0]?.file &&
      matches === 1 &&
      listedIn === conflict.file &&
      conflict.prior === conflict.prior.trim() &&
      exactHolyagentPin.test(conflict.prior)
    if (
      !replace ||
      conflicts.length !== 1 ||
      conflict.file !== settings[0]?.file ||
      (listedIn !== undefined && !repair)
    )
      return yield* new SetupFailure({
        message: `HolyAgent is already configured as ${JSON.stringify(conflict.prior)} in ${conflict.file}; ${
          replace && (listedIn !== undefined || conflicts.length > 1) && !repair
            ? "the duplicate registrations cannot be repaired safely. Keep only the intended HolyAgent source in the applicable Pi settings before reopening setup"
            : "review the existing registration in interactive setup at its scope before replacing it"
        }`,
      })
    return { target, prior: conflict.prior, repair }
  }
  return listedIn === undefined ? { target } : { listedIn }
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

const matchingEntries = (
  env: Env,
  file: string,
  packages: ReadonlyArray<unknown>,
  target: RegistrationSource,
) =>
  Effect.filter(packages, (entry) =>
    Effect.gen(function* () {
      const source = entrySource(entry)
      if (typeof source !== "string") return false
      const local =
        target.physical === undefined ? undefined : piLocalSourcePath(env, file, source.trim())
      return matchesRegistration(
        target,
        source,
        local === undefined ? undefined : yield* realPath(local),
      )
    }),
  )

const packageFilters = (entry: unknown) =>
  isJsonObject(entry)
    ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "source"))
    : {}

const planDuplicateRepair = Effect.fn("planDuplicatePiRegistrationRepair")(function* (
  env: Env,
  file: string,
  target: RegistrationSource,
  prior: string,
  settings: Readonly<Record<string, unknown>>,
) {
  const packages: ReadonlyArray<unknown> = Array.isArray(settings.packages) ? settings.packages : []
  const entry = registrationEntry(settings, prior)
  const matching = yield* matchingEntries(env, file, packages, target)
  const [local] = matching
  const source = entrySource(local)
  if (entry === undefined || matching.length !== 1 || typeof source !== "string")
    return yield* new SetupFailure({
      message: `${file}: the Pi registrations changed; review them again`,
    })
  const priorFilters = packageFilters(entry)
  const localFilters = packageFilters(local)
  if (
    Object.entries(priorFilters).some(
      ([key, value]) =>
        Object.hasOwn(localFilters, key) &&
        JSON.stringify(localFilters[key]) !== JSON.stringify(value),
    )
  )
    return yield* new SetupFailure({
      message: `${file}: the old pin and the installed HolyAgent registration have different package filters. Reconcile the filters in Pi settings and review setup again; both entries were kept`,
    })
  const keep =
    isJsonObject(entry) || isJsonObject(local)
      ? { ...priorFilters, ...localFilters, source }
      : source
  const next = packages
    .filter((item) => item !== entry)
    .map((item) => (item === local ? keep : item))
  return { source, entry, next, packages }
})

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
  env: Env,
  file: string,
  prior: string,
  target: RegistrationSource,
  previousEntry: unknown,
  before: ReadonlyArray<unknown>,
) {
  const current = yield* readJsonObjectSnapshot(file)
  const packages: ReadonlyArray<unknown> = Array.isArray(current.value.packages)
    ? current.value.packages
    : []
  const old = packages.filter((entry) => entrySource(entry) === prior)
  const saved = yield* matchingEntries(env, file, packages, target)
  const [installed] = saved
  const savedSource = entrySource(installed)
  const replacement = isJsonObject(previousEntry)
    ? { ...previousEntry, source: savedSource }
    : savedSource
  // Pi appends a new local source as a native relative path. An npm pin can instead replace an
  // entry in place because Pi matches npm registrations by package name, not by pin.
  const replacedPin =
    old.length === 0 &&
    target.physical === undefined &&
    parseNpmSource(prior)?.name === parseNpmSource(target.source)?.name
  const expected = replacedPin ? before.filter((entry) => entrySource(entry) !== prior) : before
  if (
    current.text === undefined ||
    saved.length !== 1 ||
    typeof savedSource !== "string" ||
    old.length > 1 ||
    JSON.stringify(packages.filter((entry) => entry !== installed)) !== JSON.stringify(expected) ||
    (typeof installed !== "string" &&
      (!replacedPin || JSON.stringify(installed) !== JSON.stringify(replacement)))
  )
    return yield* new SetupFailure({
      message: `${file}: the Pi registration changed during install; kept the previous source where it was still present`,
    })
  const next = packages.flatMap((entry) => {
    if (entrySource(entry) === prior) return [replacement]
    if (entry === installed) return replacedPin ? [replacement] : []
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
  let repair:
    | {
        readonly target: RegistrationSource
        readonly prior: string
        readonly source: string
        readonly packages: ReadonlyArray<unknown>
      }
    | undefined
  let replacement:
    | { readonly target: RegistrationSource; readonly prior: string; readonly entry: unknown }
    | undefined
  if (options.installedPackageRoot !== undefined) {
    const match = yield* registration(
      env,
      options.installedPackageRoot,
      [{ file, sources: listed }, ...elsewhere],
      options.replacePiRegistration === true,
    )
    if (match.target === undefined)
      lines.unshift(present(`pi package: installed HolyAgent already listed in ${match.listedIn}`))
    else {
      if (match.prior !== undefined) {
        const { target, prior } = match
        const settings = yield* readJsonObject(file)
        if (
          match.repair &&
          (!Array.isArray(settings.packages) ||
            JSON.stringify(settings.packages.map(entrySource)) !== JSON.stringify(listed))
        )
          return yield* new SetupFailure({
            message: `${file}: the Pi registration changed after review; review it again`,
          })
        const pending = match.repair
          ? yield* planDuplicateRepair(env, file, target, prior, settings)
          : undefined
        const source = pending?.source ?? target.source
        const entry = pending?.entry ?? registrationEntry(settings, prior)
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify([
              file,
              prior,
              source,
              entry,
              ...(pending === undefined ? [] : [target.physical, pending.packages]),
            ]),
          )
          .digest("hex")
        if (
          entry === undefined ||
          (!options.dryRun &&
            (pending !== undefined || review !== undefined) &&
            review?.expected !== fingerprint)
        )
          return yield* new SetupFailure({
            message: `${file}: the Pi registration changed after review; review it again`,
          })
        if (options.dryRun && review?.preview !== undefined)
          yield* Effect.sync(() => review.preview?.({ file, prior, source, fingerprint }))
        if (pending === undefined) replacement = { target, prior, entry }
        else repair = { target, prior, source, packages: pending.packages }
        lines.unshift(
          added(
            pending === undefined
              ? `pi package: replace ${JSON.stringify(prior)} with ${JSON.stringify(source)} in ${file}`
              : `pi package: remove ${JSON.stringify(prior)} from ${file}; keep ${JSON.stringify(source)} without reinstalling`,
          ),
        )
      }
      if (repair === undefined) installs.unshift(match.target.source)
    }
  }
  if (
    replacement === undefined &&
    repair === undefined &&
    !options.dryRun &&
    review?.expected !== undefined
  )
    return yield* new SetupFailure({
      message: `${file}: the Pi registration changed after review; review it again`,
    })
  if (repair !== undefined && !options.dryRun) {
    yield* reportSetupActivity(`Keeping the verified registration ${repair.source}`)
    yield* refuseLinks(
      options.cwd,
      options.scope,
      file,
      "repair the installed HolyAgent package registration",
    )
    const snapshot = yield* readJsonObjectSnapshot(file)
    if (
      snapshot.text === undefined ||
      JSON.stringify(snapshot.value.packages) !== JSON.stringify(repair.packages)
    )
      return [
        ...lines,
        `! pi package: ${file} changed after review; the previous registration was not removed`,
      ]
    const current = yield* planDuplicateRepair(
      env,
      file,
      repair.target,
      repair.prior,
      snapshot.value,
    )
    const backup = yield* backupRegistration(file, current.source, current.entry)
    lines.push(added(`pi package: saved the previous registration in ${backup}`))
    if (
      !(yield* writeJsonObjectIfUnchanged(
        file,
        { ...snapshot.value, packages: current.next },
        snapshot.text,
      ))
    )
      return [
        ...lines,
        `! pi package: ${file} changed while repairing the package; did not remove the previous source`,
      ]
    lines.push(present(`pi package: kept the installed HolyAgent registration in ${file}`))
  }
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
    const commit = replacement?.target.source === source ? replacement : undefined
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
    const beforePackages: ReadonlyArray<unknown> = Array.isArray(beforeInstall.packages)
      ? beforeInstall.packages
      : []
    if (
      !priorIsUnchanged(beforeInstall) ||
      (yield* matchingEntries(env, file, beforePackages, commit.target)).length > 0
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
    const retirement = yield* retireRegistration(
      env,
      file,
      commit.prior,
      commit.target,
      commit.entry,
      beforePackages,
    ).pipe(Effect.result)
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
