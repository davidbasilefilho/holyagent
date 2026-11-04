import { join } from "node:path"

import { $ } from "bun"
import { Console, Data, Effect, Schema } from "effect"

import { type Asset, ASSETS, readZip, sha256 } from "../packages/integrations/claude/src/vendor.ts"
import {
  caretRange,
  type Hashes,
  newestRelease,
  newestTag,
  packageDependencies,
  type PackageDependency,
  parseActionUses,
  parseMiseTools,
  parseTags,
  parseVendoredVersion,
  rewriteActionUses,
  rewriteMiseTools,
  rewriteVendoredTool,
  type Tag,
  type VendoredTool,
  withPackageRanges,
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
export type PinKind = "action" | "vendor" | "mise" | "package"

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
  readonly vendored: ReadonlyMap<VendoredTool, string>
  readonly mise: ReadonlyMap<string, string>
  /** The range every registry dependency should have, by manifest. */
  readonly packages: ReadonlyMap<string, ReadonlyArray<PackageDependency>>
}

const strict = { onExcessProperty: "error" } as const

// A registry answers with many fields this program does not own. Excess properties are errors, so
// the response is decoded as a record of unknown values, which has none, with the one field the
// program reads named in a struct with an explicit open rest.
const Fields = Schema.Record(Schema.String, Schema.Unknown)
const Packument = Schema.StructWithRest(Schema.Struct({ versions: Fields }), [Fields])

const REGISTRY = "https://registry.npmjs.org"
const ABBREVIATED = "application/vnd.npm.install-v1+json"

/** The GitHub remotes of the tools the updater knows, with the tag prefix of their releases. */
const GITHUB = "https://github.com"
const VENDORED: Record<VendoredTool, { repository: string; prefix: string }> = {
  ripgrep: { repository: "BurntSushi/ripgrep", prefix: "" },
  fd: { repository: "sharkdp/fd", prefix: "v" },
}

/** The mise tools whose releases are tags of a GitHub repository. */
const MISE_SOURCES: Record<string, { repository: string; prefix: string }> = {
  bun: { repository: "oven-sh/bun", prefix: "bun-v" },
}

/** The file that holds the vendored tools' pins, relative to the repository root. */
export const VENDOR_PINS = "packages/integrations/claude/src/vendor.ts"

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

const releasesOf = (name: string) =>
  Effect.gen(function* () {
    const source = `${REGISTRY}/${name.replace("/", "%2F")}`
    const response = yield* Effect.tryPromise({
      try: () => fetch(source, { headers: { accept: ABBREVIATED } }),
      catch: (cause) => new SourceError({ source, cause }),
    })
    if (!response.ok)
      return yield* Effect.fail(new SourceError({ source, cause: `answered ${response.status}` }))
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => new SourceError({ source, cause }),
    })
    const { versions } = yield* Schema.decodeUnknownEffect(
      Packument,
      strict,
    )(body).pipe(Effect.mapError((cause) => new SourceError({ source, cause })))
    return Object.keys(versions)
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
    const uses = yield* Effect.forEach(files, (file) =>
      readText(root, file).pipe(
        Effect.map((text) => parseActionUses(text).map((use) => ({ file, ...use }))),
      ),
    ).pipe(Effect.map((perFile) => perFile.flat()))
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
    return { pins, latest }
  })

const surveyVendored = (root: string) =>
  Effect.gen(function* () {
    const text = yield* readText(root, VENDOR_PINS)
    const tools = Object.keys(VENDORED) as Array<VendoredTool>
    const found = yield* resolveAll(tools, (tool) => {
      const { repository, prefix } = VENDORED[tool]
      return tagsOf(repository).pipe(
        Effect.flatMap((tags) => newestOrFail(`${GITHUB}/${repository}`, tags, prefix)),
        Effect.map(({ release }) => release),
      )
    })
    const pins: Array<Pin> = []
    const latest = new Map<VendoredTool, string>()
    for (const tool of tools) {
      const current = parseVendoredVersion(text, tool)
      const next = found.get(tool)
      if (current === undefined || next === undefined)
        return yield* Effect.fail(new FileError({ file: VENDOR_PINS, cause: `no ${tool} version` }))
      latest.set(tool, next)
      pins.push({ kind: "vendor", name: tool, file: VENDOR_PINS, current, next })
    }
    return { pins, latest }
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

const surveyPackages = (root: string) =>
  Effect.gen(function* () {
    const files = (yield* scan(root, "**/package.json", false)).filter(
      (file) => !file.split("/").includes("node_modules"),
    )
    const manifests = yield* Effect.forEach(files, (file) =>
      readText(root, file).pipe(
        Effect.flatMap((text) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(Fields), strict)(text),
        ),
        Effect.mapError((cause) => new FileError({ file, cause })),
        Effect.map((manifest) => ({ file, dependencies: packageDependencies(manifest) })),
      ),
    )
    const releases = yield* resolveAll(
      manifests.flatMap(({ dependencies }) => dependencies.map(({ name }) => name)),
      (name) =>
        releasesOf(name).pipe(
          Effect.map(newestRelease),
          Effect.flatMap((release) =>
            release === undefined
              ? Effect.fail(
                  new SourceError({ source: `${REGISTRY}/${name}`, cause: "no stable release" }),
                )
              : Effect.succeed(release),
          ),
        ),
    )
    const pins: Array<Pin> = []
    const ranges = new Map<string, Array<PackageDependency>>()
    for (const { file, dependencies } of manifests)
      for (const dependency of dependencies) {
        const next = caretRange(releases.get(dependency.name) ?? "0.0.0")
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

/**
 * Looks at every pin without writing anything: the external actions of the workflows (a tag
 * resolved to its commit), the vendored ripgrep and fd, the mise tools and the ranges of every
 * `package.json`. Each pin moves to the newest stable release; a prerelease is never chosen.
 */
export const survey = (root: string) =>
  Effect.gen(function* () {
    const actions = yield* surveyActions(root)
    const vendored = yield* surveyVendored(root)
    const mise = yield* surveyMise(root)
    const packages = yield* surveyPackages(root)
    return {
      pins: [...actions.pins, ...vendored.pins, ...mise.pins, ...packages.pins],
      skipped: mise.skipped,
      actions: actions.latest,
      vendored: vendored.latest,
      mise: mise.latest,
      packages: packages.ranges,
    } satisfies Survey
  })

const download = (url: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url),
      catch: (cause) => new SourceError({ source: url, cause }),
    })
    if (!response.ok)
      return yield* Effect.fail(
        new SourceError({ source: url, cause: `answered ${response.status}` }),
      )
    return yield* Effect.tryPromise({
      try: () => response.bytes(),
      catch: (cause) => new SourceError({ source: url, cause }),
    })
  })

/** The program inside a release archive, by its path in the archive. */
const programOf = (asset: Asset, archive: Uint8Array, path: string) =>
  Effect.gen(function* () {
    const source = asset.url
    const program =
      asset.format === "zip"
        ? (yield* Effect.try({
            try: () => readZip(archive, [path]),
            catch: (cause) => new SourceError({ source, cause }),
          })).get(path)
        : yield* Effect.tryPromise({
            try: () => new Bun.Archive(archive).files(),
            catch: (cause) => new SourceError({ source, cause }),
          }).pipe(
            Effect.flatMap((files) =>
              Effect.tryPromise({
                try: () => files.get(path)?.bytes() ?? Promise.resolve(undefined),
                catch: (cause) => new SourceError({ source, cause }),
              }),
            ),
          )
    return program === undefined
      ? yield* Effect.fail(new SourceError({ source, cause: `the archive has no ${path}` }))
      : program
  })

/**
 * The hashes of a vendored tool's release archives for every target, taken from the downloads: the
 * SHA-256 of each archive and of the program inside. The archives are the current ones with the
 * version replaced in their URL and folder.
 */
export const hashesOf = (tool: VendoredTool, from: string, to: string) =>
  Effect.forEach(
    ASSETS.filter((asset) => asset.project === tool),
    (asset) =>
      Effect.gen(function* () {
        const url = asset.url.replaceAll(from, to)
        const folder = asset.folder.replaceAll(from, to)
        const archive = yield* download(url)
        const program = yield* programOf(
          asset,
          archive,
          `${folder}/${asset.tool}${asset.target.suffix}`,
        )
        return [asset.target.id, { archive: sha256(archive), binary: sha256(program) }] as const
      }),
    { concurrency: 2 },
  ).pipe(Effect.map((entries): ReadonlyMap<string, Hashes> => new Map(entries)))

const run = (command: string, execute: () => Promise<{ readonly exitCode: number }>) =>
  Effect.tryPromise({
    try: execute,
    catch: (cause) => new SourceError({ source: command, cause }),
  }).pipe(
    Effect.flatMap(({ exitCode }) =>
      exitCode === 0 ? Effect.void : Effect.fail(new CommandError({ command, exitCode })),
    ),
  )

const writeRanges = (root: string, packages: Survey["packages"]) =>
  Effect.forEach(packages, ([file, ranges]) =>
    Effect.gen(function* () {
      const text = yield* readText(root, file)
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Fields),
        strict,
      )(text).pipe(Effect.mapError((cause) => new FileError({ file, cause })))
      yield* writeText(
        root,
        file,
        `${JSON.stringify(withPackageRanges(manifest, ranges), null, 2)}\n`,
      )
    }),
  )

/**
 * Writes the moves a survey found. Actions, the mise tools and the package ranges are rewritten in
 * place; a vendored tool gets its new version and the hashes taken from its downloaded archives,
 * and `scripts/vendor.ts` (the `vendor` task) re-vendors the programs. `bun update` then refreshes
 * the lockfile within the new ranges.
 */
export const applySurvey = (root: string, found: Survey) =>
  Effect.gen(function* () {
    const files = [...new Set(found.pins.filter((p) => p.kind === "action").map((p) => p.file))]
    yield* Effect.forEach(files, (file) =>
      readText(root, file).pipe(
        Effect.flatMap((text) => writeText(root, file, rewriteActionUses(text, found.actions))),
      ),
    )
    const mise = yield* readText(root, "mise.toml")
    yield* writeText(root, "mise.toml", rewriteMiseTools(mise, found.mise))
    yield* writeRanges(root, found.packages)
    const moved = found.pins.filter((pin) => pin.kind === "vendor" && isBehind(pin))
    let vendor = yield* readText(root, VENDOR_PINS)
    for (const pin of moved) {
      const tool = pin.name as VendoredTool
      const hashes = yield* hashesOf(tool, pin.current, pin.next)
      vendor = yield* Effect.try({
        try: () => rewriteVendoredTool(vendor, tool, pin.next, hashes),
        catch: (cause) => new FileError({ file: VENDOR_PINS, cause }),
      })
    }
    if (moved.length > 0) {
      yield* writeText(root, VENDOR_PINS, vendor)
      yield* run("bun scripts/vendor.ts", () => $`bun scripts/vendor.ts`.cwd(root).nothrow())
    }
    // `bun update` moves the lockfile to the newest release within each range, but it also writes
    // that release into package.json as the range. The ranges are written back, and `bun install`
    // then records them in the lockfile.
    yield* run("bun update", () => $`bun update`.cwd(root).nothrow())
    yield* writeRanges(root, found.packages)
    yield* run("bun install", () => $`bun install`.cwd(root).nothrow())
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

/**
 * Runs `[--dry-run | --check] [root]` on `root` (the repository root by default). `--dry-run`
 * prints `current -> next` for every pin and writes nothing; `--check` prints the pins that are
 * behind and fails when there are any; with neither, the updater moves every pin and refreshes the
 * lockfile. A failure is printed and sets a failing exit code.
 */
export const main = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { mode, root } = yield* parseArguments(args)
    const found = yield* survey(root)
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
    yield* applySurvey(root, found)
    yield* Console.log(`moved ${behind.length} of ${found.pins.length} pins`)
  }).pipe(
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
