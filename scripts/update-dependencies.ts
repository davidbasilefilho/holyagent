import { join } from "node:path"

import { $ } from "bun"
import { Console, Data, Effect, Schema } from "effect"

import {
  newestAllowedRelease,
  newestPypiRelease,
  newestTag,
  nextPackageRange,
  nextPiVersion,
  packageDependencies,
  type PackageDependency,
  parseActionUses,
  parseMiseTools,
  parseTags,
  renderPiPackages,
  rewriteActionUses,
  rewriteMiseTools,
  type Tag,
  unreadableActionUses,
  withPackageRanges,
  withPiPackageVersions,
} from "./dependency-pins.ts"

/** A registry, a git remote or a download could not be reached or answered something unusable. */
export class SourceError extends Data.TaggedError("SourceError")<{
  readonly source: string
  readonly cause: unknown
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.source}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

/** A file could not be read, decoded or written. */
export class FileError extends Data.TaggedError("FileError")<{
  readonly file: string
  readonly cause: unknown
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.file}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

/** A command that the updater runs exited with a failure. */
export class CommandError extends Data.TaggedError("CommandError")<{
  readonly command: string
  readonly exitCode: number
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.command} exited with ${this.exitCode}`
  }
}

/** One or more pins are behind the newest stable release (the `--check` mode). */
export class PinsBehind extends Data.TaggedError("PinsBehind")<{ readonly count: number }> {
  /** The description shown to the user. */
  override get message() {
    return `${this.count} pin(s) are behind; run mise run deps:update`
  }
}

/** The command line arguments are not `[--dry-run | --check] [root]`. */
export class Usage extends Data.TaggedError("Usage")<{ readonly args: ReadonlyArray<string> }> {
  /** The description shown to the user. */
  override get message() {
    return `Expected [--dry-run | --check] [root]; got ${this.args.join(" ") || "nothing"}`
  }
}

/** What the updater does: `apply` writes, `dry-run` only prints, `check` fails on a pin behind. */
export type Mode = "apply" | "dry-run" | "check"

/** The kinds of pin the updater moves. */
export type PinKind = "action" | "mise" | "package" | "pi" | "pypi"

/** One pin: where it is, what it is now and what it would become. */
export interface Pin {
  readonly kind: PinKind
  readonly name: string
  readonly file: string
  readonly current: string
  readonly next: string
}

/** A pin is behind when it would change. */
export const isBehind = (pin: Pin): boolean => pin.current !== pin.next

/** The result of looking at every pin without writing anything. */
export interface Survey {
  readonly pins: ReadonlyArray<Pin>
  /** Pins the updater found but cannot move, each with its reason. */
  readonly skipped: ReadonlyArray<string>
  readonly actions: ReadonlyMap<string, { readonly sha: string; readonly version: string }>
  readonly mise: ReadonlyMap<string, string>
  /** The range every registry dependency should have, by manifest. */
  readonly packages: ReadonlyMap<string, ReadonlyArray<PackageDependency>>
  /** The exact version every Pi package of `pi-packages.json` should have, by npm name. */
  readonly piPackages: ReadonlyMap<string, string>
  /** The exact version every PyPI package of `pypi-packages.json` should have, by PyPI name. */
  readonly pypiPackages: ReadonlyMap<string, string>
}

const strict = { onExcessProperty: "error" } as const

// A registry answers with many fields this program does not own. Excess properties are errors, so
// each response is decoded as a record of unknown values, which has none, with the fields the
// program reads named in a struct with an explicit open rest.
const Fields = Schema.Record(Schema.String, Schema.Unknown)
const open = <S extends Schema.Struct.Fields>(fields: S) =>
  Schema.StructWithRest(Schema.Struct(fields), [Fields])
const Packument = open({
  "dist-tags": open({ latest: Schema.String }),
  versions: Schema.Record(Schema.String, open({ deprecated: Schema.optionalKey(Schema.Unknown) })),
})
const PypiProject = open({
  releases: Schema.Record(
    Schema.String,
    Schema.Array(open({ yanked: Schema.optionalKey(Schema.Boolean) })),
  ),
})
const REGISTRY = "https://registry.npmjs.org"
const PYPI = "https://pypi.org"

/** How long a registry request may take, from the request to the last byte of the answer. */
export const REGISTRY_TIMEOUT_MS = 60_000
const ABBREVIATED = "application/vnd.npm.install-v1+json"

const GITHUB = "https://github.com"

/** The mise tools whose releases are tags of a GitHub repository. */
export const MISE_SOURCES: Record<string, { repository: string; prefix: string }> = {
  bun: { repository: "oven-sh/bun", prefix: "bun-v" },
  "aqua:BurntSushi/ripgrep": { repository: "BurntSushi/ripgrep", prefix: "" },
  "aqua:sharkdp/fd": { repository: "sharkdp/fd", prefix: "v" },
}

/** The file that holds the exact version of every Pi package HolyAgent enables. */
export const PI_PACKAGE_PINS = "packages/core/src/config/pi-packages.json"

/** The file that holds the exact version of every PyPI package HolyAgent runs. */
export const PYPI_PACKAGE_PINS = "packages/core/src/config/pypi-packages.json"

const readText = (root: string, file: string) =>
  Effect.tryPromise({
    try: () => Bun.file(join(root, file)).text(),
    catch: (cause) => new FileError({ file, cause }),
  })

const writeText = (root: string, file: string, text: string) =>
  Effect.tryPromise({
    try: () => Bun.write(join(root, file), text),
    catch: (cause) => new FileError({ file, cause }),
  })

const scan = (root: string, pattern: string, dot: boolean) =>
  Effect.tryPromise({
    try: () => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true, dot })),
    catch: (cause) => new FileError({ file: pattern, cause }),
  }).pipe(Effect.map((files) => files.map((file) => file.replaceAll("\\", "/")).toSorted()))

const tagsOf = (repository: string) =>
  Effect.tryPromise({
    try: () =>
      $`git ls-remote --tags ${`${GITHUB}/${repository}`}`
        .env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })
        .quiet()
        .text(),
    catch: (cause) => new SourceError({ source: `${GITHUB}/${repository}`, cause }),
  }).pipe(Effect.map(parseTags))

/**
 * The release a package moves to: the newest stable, non-deprecated version no higher than the
 * registry's `latest` dist-tag. A registry that takes longer than `timeoutMs` to answer fails with
 * a `SourceError`, so a stalled connection cannot hang the update.
 */
export const releaseOf = (
  name: string,
  registry: string = REGISTRY,
  timeoutMs: number = REGISTRY_TIMEOUT_MS,
) =>
  Effect.gen(function* () {
    const source = `${registry}/${name.replace("/", "%2F")}`
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(source, {
          headers: { accept: ABBREVIATED },
          signal: AbortSignal.timeout(timeoutMs),
        }),
      catch: (cause) => new SourceError({ source, cause }),
    })
    if (!response.ok)
      return yield* Effect.fail(new SourceError({ source, cause: `answered ${response.status}` }))
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => new SourceError({ source, cause }),
    })
    const packument = yield* Schema.decodeUnknownEffect(
      Packument,
      strict,
    )(body).pipe(Effect.mapError((cause) => new SourceError({ source, cause })))
    const latest = packument["dist-tags"].latest
    const release = newestAllowedRelease(packument.versions, latest)
    return release === undefined
      ? yield* Effect.fail(
          new SourceError({
            source,
            cause: `no stable, non-deprecated release at or below ${latest}`,
          }),
        )
      : release
  })

/**
 * The release a PyPI package moves to, from the JSON API of the index at `index` (the base URL, so
 * a test can serve a fixture): the newest stable release that has an installable file, so
 * prereleases (`rc`, `a`, `b`, `dev`), post releases and yanked releases are skipped. A project
 * that takes longer than `timeoutMs` to answer fails with a `SourceError`.
 */
export const pypiReleaseOf = (
  name: string,
  index: string = PYPI,
  timeoutMs: number = REGISTRY_TIMEOUT_MS,
) =>
  Effect.gen(function* () {
    const source = `${index}/pypi/${name}/json`
    const response = yield* Effect.tryPromise({
      try: () => fetch(source, { signal: AbortSignal.timeout(timeoutMs) }),
      catch: (cause) => new SourceError({ source, cause }),
    })
    if (!response.ok)
      return yield* Effect.fail(new SourceError({ source, cause: `answered ${response.status}` }))
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => new SourceError({ source, cause }),
    })
    const project = yield* Schema.decodeUnknownEffect(
      PypiProject,
      strict,
    )(body).pipe(Effect.mapError((cause) => new SourceError({ source, cause })))
    const release = newestPypiRelease(project.releases)
    return release === undefined
      ? yield* Effect.fail(
          new SourceError({ source, cause: "no stable release that is not yanked" }),
        )
      : release
  })

const newestOrFail = (source: string, tags: ReadonlyArray<Tag>, prefix: string) => {
  const found = newestTag(tags, prefix)
  return found === undefined
    ? Effect.fail(new SourceError({ source, cause: `no stable ${prefix}X.Y.Z tag` }))
    : Effect.succeed(found)
}

const short = (sha: string): string => sha.slice(0, 7)

/** A map from each distinct key to the effect that resolves it, run a few at a time. */
const resolveAll = <K, V, E>(keys: Iterable<K>, resolve: (key: K) => Effect.Effect<V, E>) =>
  Effect.forEach(
    [...new Set(keys)],
    (key) => resolve(key).pipe(Effect.map((v) => [key, v] as const)),
    {
      concurrency: 4,
    },
  ).pipe(Effect.map((entries) => new Map(entries)))

const surveyActions = (root: string) =>
  Effect.gen(function* () {
    const files = yield* scan(root, ".github/**/*.{yml,yaml}", true)
    const texts = yield* Effect.forEach(files, (file) =>
      readText(root, file).pipe(Effect.map((text) => ({ file, text }))),
    )
    const uses = texts.flatMap(({ file, text }) =>
      parseActionUses(text).map((use) => ({ file, ...use })),
    )
    const skipped = texts.flatMap(({ file, text }) =>
      unreadableActionUses(text).map(
        (line) => `action ${file}: "${line}" is not pinned as @<sha> # vX.Y.Z`,
      ),
    )
    const latest = yield* resolveAll(
      uses.map((use) => use.repository),
      (repository) =>
        tagsOf(repository).pipe(
          Effect.flatMap((tags) => newestOrFail(`${GITHUB}/${repository}`, tags, "v")),
          Effect.map(({ release, tag }) => ({ sha: tag.sha, version: `v${release}` })),
        ),
    )
    const pins = [
      ...new Map(
        uses.map((use) => {
          const next = latest.get(use.repository)
          return [
            `${use.file} ${use.repository} ${use.sha} ${use.version}`,
            {
              kind: "action",
              name: use.repository,
              file: use.file,
              current: `${use.version} (${short(use.sha)})`,
              next: `${next?.version} (${short(next?.sha ?? "")})`,
            } satisfies Pin,
          ] as const
        }),
      ).values(),
    ]
    return { pins, latest, skipped }
  })

const surveyMise = (root: string) =>
  Effect.gen(function* () {
    const tools = parseMiseTools(yield* readText(root, "mise.toml"))
    const skipped: Array<string> = []
    const known = tools.filter((tool) => {
      const reason = !/^\d+\.\d+\.\d+$/.test(tool.version)
        ? `"${tool.version}" is a channel, not a pinned version`
        : MISE_SOURCES[tool.name] === undefined
          ? "no release source is known for this tool"
          : undefined
      if (reason !== undefined) skipped.push(`mise ${tool.name} (mise.toml): ${reason}`)
      return reason === undefined
    })
    const latest = yield* resolveAll(
      known.map((tool) => tool.name),
      (name) => {
        const { repository, prefix } = MISE_SOURCES[name] ?? { repository: "", prefix: "" }
        return tagsOf(repository).pipe(
          Effect.flatMap((tags) => newestOrFail(`${GITHUB}/${repository}`, tags, prefix)),
          Effect.map(({ release }) => release),
        )
      },
    )
    const pins = known.map((tool): Pin => ({
      kind: "mise",
      name: tool.name,
      file: "mise.toml",
      current: tool.version,
      next: latest.get(tool.name) ?? tool.version,
    }))
    return { pins, latest, skipped }
  })

/**
 * The `package.json` files of the repository: the root one and one in each folder that a
 * `workspaces` glob of the root names, relative to `root`. Nothing under `node_modules` is read.
 */
export const manifestFiles = (root: string) =>
  Effect.gen(function* () {
    const text = yield* readText(root, "package.json")
    const { workspaces = [] } = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(open({ workspaces: Schema.optionalKey(Schema.Array(Schema.String)) })),
      strict,
    )(text).pipe(Effect.mapError((cause) => new FileError({ file: "package.json", cause })))
    const found = yield* Effect.forEach(workspaces, (glob) =>
      scan(root, `${glob}/package.json`, false),
    )
    return ["package.json", ...new Set(found.flat())].toSorted()
  })

/** Removes the npm mise wrapper, whose Windows binary package does not exist; use native mise. */
export const withoutNpmMise = (
  manifest: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const result = { ...manifest }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const table = result[field]
    if (table !== null && typeof table === "object" && !Array.isArray(table) && "mise" in table) {
      const { mise: _mise, ...rest } = table as Record<string, unknown>
      result[field] = rest
    }
  }
  if (Array.isArray(result["trustedDependencies"]))
    result["trustedDependencies"] = result["trustedDependencies"].filter((name) => name !== "mise")
  return result
}

const surveyPackages = (root: string) =>
  Effect.gen(function* () {
    const files = yield* manifestFiles(root)
    const manifests = yield* Effect.forEach(files, (file) =>
      readText(root, file).pipe(
        Effect.flatMap((text) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(Fields), strict)(text),
        ),
        Effect.mapError((cause) => new FileError({ file, cause })),
        Effect.map((manifest) => ({
          file,
          dependencies: packageDependencies(withoutNpmMise(manifest)),
        })),
      ),
    )
    const releases = yield* resolveAll(
      manifests.flatMap(({ dependencies }) => dependencies.map(({ name }) => name)),
      releaseOf,
    )
    const pins: Array<Pin> = []
    const ranges = new Map<string, Array<PackageDependency>>()
    for (const { file, dependencies } of manifests)
      for (const dependency of dependencies) {
        const next = nextPackageRange(
          dependency.name,
          dependency.range,
          releases.get(dependency.name) ?? "0.0.0",
        )
        pins.push({
          kind: "package",
          name: `${dependency.name} (${dependency.field})`,
          file,
          current: dependency.range,
          next,
        })
        ranges.set(file, [...(ranges.get(file) ?? []), { ...dependency, range: next }])
      }
    return { pins, ranges }
  })

const readPiPins = (root: string) =>
  readText(root, PI_PACKAGE_PINS).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
        strict,
      )(text).pipe(Effect.mapError((cause) => new FileError({ file: PI_PACKAGE_PINS, cause }))),
    ),
  )

/**
 * The exact Pi package pins of `pi-packages.json`, each looked up in the registry like a package
 * range: the newest stable, non-deprecated release no higher than `latest`, never moving a pin
 * down. `registry` is the registry base URL, so a test can serve a fixture.
 */
export const surveyPiPackages = (root: string, registry: string = REGISTRY) =>
  Effect.gen(function* () {
    const table = yield* readPiPins(root)
    const releases = yield* resolveAll(Object.keys(table), (name) => releaseOf(name, registry))
    const pins: Array<Pin> = []
    const latest = new Map<string, string>()
    for (const [name, current] of Object.entries(table)) {
      const next = nextPiVersion(current, releases.get(name) ?? current)
      latest.set(name, next)
      pins.push({ kind: "pi", name, file: PI_PACKAGE_PINS, current, next })
    }
    return { pins, latest }
  })

const readPypiPins = (root: string) =>
  readText(root, PYPI_PACKAGE_PINS).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
        strict,
      )(text).pipe(Effect.mapError((cause) => new FileError({ file: PYPI_PACKAGE_PINS, cause }))),
    ),
  )

/**
 * The exact PyPI pins of `pypi-packages.json`, each looked up in the index's JSON API (see
 * {@link pypiReleaseOf}) and never moved down. `index` is the index base URL, so a test can serve a
 * fixture.
 */
export const surveyPypiPackages = (root: string, index: string = PYPI) =>
  Effect.gen(function* () {
    const table = yield* readPypiPins(root)
    const releases = yield* resolveAll(Object.keys(table), (name) => pypiReleaseOf(name, index))
    const pins: Array<Pin> = []
    const latest = new Map<string, string>()
    for (const [name, current] of Object.entries(table)) {
      const next = nextPiVersion(current, releases.get(name) ?? current)
      latest.set(name, next)
      pins.push({ kind: "pypi", name, file: PYPI_PACKAGE_PINS, current, next })
    }
    return { pins, latest }
  })

/**
 * Looks at every pin without writing anything: the external actions of the workflows (a tag
 * resolved to its commit), the mise tools, the ranges of every `package.json`, the exact versions
 * of the Pi packages and those of the PyPI packages. Each pin moves to the newest stable release; a
 * prerelease is never chosen.
 */
export const survey = (root: string) =>
  Effect.gen(function* () {
    const actions = yield* surveyActions(root)
    const mise = yield* surveyMise(root)
    const packages = yield* surveyPackages(root)
    const pi = yield* surveyPiPackages(root)
    const pypi = yield* surveyPypiPackages(root)
    return {
      pins: [...actions.pins, ...mise.pins, ...packages.pins, ...pi.pins, ...pypi.pins],
      skipped: [...actions.skipped, ...mise.skipped],
      actions: actions.latest,
      mise: mise.latest,
      packages: packages.ranges,
      piPackages: pi.latest,
      pypiPackages: pypi.latest,
    } satisfies Survey
  })

const run = (command: string, execute: () => Promise<{ readonly exitCode: number }>) =>
  Effect.tryPromise({
    try: execute,
    catch: (cause) => new SourceError({ source: command, cause }),
  }).pipe(
    Effect.flatMap(({ exitCode }) =>
      exitCode === 0 ? Effect.void : Effect.fail(new CommandError({ command, exitCode })),
    ),
  )

/** The text of each manifest of a survey with its ranges set; nothing is written. */
const renderRanges = (root: string, packages: Survey["packages"]) =>
  Effect.forEach([...packages], ([file, ranges]) =>
    Effect.gen(function* () {
      const text = yield* readText(root, file)
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Fields),
        strict,
      )(text).pipe(Effect.mapError((cause) => new FileError({ file, cause })))
      return [
        file,
        `${JSON.stringify(withoutNpmMise(withPackageRanges(manifest, ranges)), null, 2)}\n`,
      ] as const
    }),
  )

/** The text of `pi-packages.json` with the versions of a survey set; nothing is written. */
export const renderPiPins = (root: string, versions: Survey["piPackages"]) =>
  readPiPins(root).pipe(
    Effect.map((table) => renderPiPackages(withPiPackageVersions(table, versions))),
  )

/** The text of `pypi-packages.json` with the versions of a survey set; nothing is written. */
export const renderPypiPins = (root: string, versions: Survey["pypiPackages"]) =>
  readPypiPins(root).pipe(
    Effect.map((table) => renderPiPackages(withPiPackageVersions(table, versions))),
  )

const writeRanges = (root: string, packages: Survey["packages"]) =>
  renderRanges(root, packages).pipe(
    Effect.flatMap((rendered) =>
      Effect.forEach(rendered, ([file, text]) => writeText(root, file, text)),
    ),
  )

/**
 * Writes the moves a survey found. Everything that can fail on the network or on a file is done
 * first: the new texts of the workflows, `mise.toml`, the manifests and the Pi and PyPI package
 * pins are computed. Only then is anything written, and `bun update` then refreshes the lockfile
 * within the new ranges. The installs run with `--ignore-scripts`, so no install script runs during
 * the update; a later plain `bun install` runs the trusted ones. A failure after the first write
 * leaves the tree half moved.
 */
export const applySurvey = (root: string, found: Survey) =>
  Effect.gen(function* () {
    const workflows = yield* Effect.forEach(
      [...new Set(found.pins.filter((p) => p.kind === "action").map((p) => p.file))],
      (file) =>
        readText(root, file).pipe(
          Effect.map((text) => [file, rewriteActionUses(text, found.actions)] as const),
        ),
    )
    const mise = rewriteMiseTools(yield* readText(root, "mise.toml"), found.mise)
    const ranges = yield* renderRanges(root, found.packages)
    const piPins = yield* renderPiPins(root, found.piPackages)
    const pypiPins = yield* renderPypiPins(root, found.pypiPackages)
    for (const [file, text] of workflows) yield* writeText(root, file, text)
    yield* writeText(root, "mise.toml", mise)
    for (const [file, text] of ranges) yield* writeText(root, file, text)
    yield* writeText(root, PI_PACKAGE_PINS, piPins)
    yield* writeText(root, PYPI_PACKAGE_PINS, pypiPins)
    // `bun update` moves the lockfile to the newest release within each range, but it also writes
    // that release into package.json as the range. The ranges are written back, and `bun install`
    // then records them in the lockfile.
    yield* run("bun update --ignore-scripts", () =>
      $`bun update --ignore-scripts`.cwd(root).nothrow(),
    )
    yield* writeRanges(root, found.packages)
    yield* run("bun install --ignore-scripts", () =>
      $`bun install --ignore-scripts`.cwd(root).nothrow(),
    )
  })

const describePin = (pin: Pin): string =>
  `${pin.kind.padEnd(8)}${pin.name} (${pin.file}): ${pin.current} -> ${pin.next}${isBehind(pin) ? "" : "  [current]"}`

const parseArguments = (args: ReadonlyArray<string>) => {
  const flags = args.filter((arg) => arg.startsWith("--"))
  const positional = args.filter((arg) => !arg.startsWith("--"))
  const mode: Mode | undefined =
    flags.length === 0
      ? "apply"
      : flags.length === 1 && flags[0] === "--dry-run"
        ? "dry-run"
        : flags.length === 1 && flags[0] === "--check"
          ? "check"
          : undefined
  return mode === undefined || positional.length > 1
    ? Effect.fail(new Usage({ args }))
    : Effect.succeed({ mode, root: positional[0] ?? join(import.meta.dir, "..") })
}

/** Refreshes workspace links while retaining the currently locked external package versions. */
export const refreshWorkspaceLock = (root: string) =>
  run("bun install --lockfile-only --ignore-scripts", () =>
    $`bun install --lockfile-only --ignore-scripts`.cwd(root).nothrow(),
  )

/** The steps of a run that touch the network and the tree, so a test can stand in for them. */
export interface Steps {
  readonly survey: (root: string) => Effect.Effect<Survey, FileError | SourceError>
  readonly apply: (
    root: string,
    found: Survey,
  ) => Effect.Effect<void, CommandError | FileError | SourceError>
}

/**
 * Runs `[--dry-run | --check] [root]` on `root` (the repository root by default). `--dry-run`
 * prints `current -> next` for every pin and writes nothing; `--check` prints the pins that are
 * behind and fails with `PinsBehind` when there are any; with neither, the updater moves every pin
 * and refreshes the lockfile. Only the apply mode calls `steps.apply`.
 */
export const execute = (
  args: ReadonlyArray<string>,
  steps: Steps = { survey, apply: applySurvey },
) =>
  Effect.gen(function* () {
    if (args[0] === "--workspace-lock-only" && args.length <= 2) {
      yield* refreshWorkspaceLock(args[1] ?? join(import.meta.dir, ".."))
      return
    }
    const { mode, root } = yield* parseArguments(args)
    const found = yield* steps.survey(root)
    const behind = found.pins.filter(isBehind)
    for (const pin of mode === "dry-run" ? found.pins : behind) yield* Console.log(describePin(pin))
    for (const note of found.skipped) yield* Console.log(`skipped ${note}`)
    if (mode === "check") {
      if (behind.length === 0)
        return yield* Console.log("every pin is on the newest stable release")
      return yield* Effect.fail(new PinsBehind({ count: behind.length }))
    }
    if (mode === "dry-run")
      return yield* Console.log(`${behind.length} of ${found.pins.length} pins are behind`)
    yield* steps.apply(root, found)
    yield* Console.log(`moved ${behind.length} of ${found.pins.length} pins`)
  })

/** Runs `execute`, prints a failure and sets a failing exit code. */
export const main = (args: ReadonlyArray<string>, steps?: Steps) =>
  execute(args, steps).pipe(
    Effect.catch((error) =>
      Console.error(`error: ${error._tag}: ${error.message}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1
          }),
        ),
      ),
    ),
  )

if (import.meta.main) await Effect.runPromise(main(Bun.argv.slice(2)))
