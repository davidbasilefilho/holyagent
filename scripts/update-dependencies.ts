import { join } from "node:path"

import { $ } from "bun"
import { Console, Data, Effect, Schema } from "effect"

import { VENDOR_DIRECTORY } from "../packages/integrations/claude/src/files.ts"
import {
  type Asset,
  ASSETS,
  installAsset,
  readArchive,
  sha256,
} from "../packages/integrations/claude/src/vendor.ts"
import {
  caretRange,
  type Hashes,
  newestAllowedRelease,
  newestTag,
  packageDependencies,
  type PackageDependency,
  parseActionUses,
  parseChecksumFile,
  parseDigest,
  parseMiseTools,
  parseTags,
  parseVendoredVersion,
  rewriteActionUses,
  rewriteMiseTools,
  rewriteVendoredTool,
  type Tag,
  unreadableActionUses,
  type VendoredTool,
  withPackageRanges,
} from "./dependency-pins.ts"
import { download } from "./vendor.ts"

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

/** A downloaded archive does not have the SHA-256 that its release publishes. */
export class ChecksumMismatch extends Data.TaggedError("ChecksumMismatch")<{
  readonly url: string
  readonly actual: string
  readonly expected: string
  /** Where the expected hash was published. */
  readonly via: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.url} has SHA-256 ${this.actual}, but ${this.via} publishes ${this.expected}`
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
// each response is decoded as a record of unknown values, which has none, with the fields the
// program reads named in a struct with an explicit open rest.
const Fields = Schema.Record(Schema.String, Schema.Unknown)
const open = <S extends Schema.Struct.Fields>(fields: S) =>
  Schema.StructWithRest(Schema.Struct(fields), [Fields])
const Packument = open({
  "dist-tags": open({ latest: Schema.String }),
  versions: Schema.Record(Schema.String, open({ deprecated: Schema.optionalKey(Schema.Unknown) })),
})
const GithubRelease = open({
  assets: Schema.Array(
    open({ name: Schema.String, digest: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
})

const REGISTRY = "https://registry.npmjs.org"
const ABBREVIATED = "application/vnd.npm.install-v1+json"

const GITHUB = "https://github.com"
const GITHUB_API = "https://api.github.com"

/**
 * The GitHub remotes of the vendored tools, with the tag prefix of their releases and where a
 * release publishes the SHA-256 of its archives: a `<archive>.sha256` file, or the `digest` of the
 * asset in GitHub's release API.
 */
const VENDORED: Record<
  VendoredTool,
  { repository: string; prefix: string; checksums: "file" | "release-digest" }
> = {
  ripgrep: { repository: "BurntSushi/ripgrep", prefix: "", checksums: "file" },
  fd: { repository: "sharkdp/fd", prefix: "v", checksums: "release-digest" },
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

/**
 * The release a package moves to: the newest stable, non-deprecated version no higher than the
 * registry's `latest` dist-tag.
 */
const releaseOf = (name: string) =>
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

const surveyPackages = (root: string) =>
  Effect.gen(function* () {
    const files = yield* manifestFiles(root)
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
      releaseOf,
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
      skipped: [...actions.skipped, ...mise.skipped],
      actions: actions.latest,
      vendored: vendored.latest,
      mise: mise.latest,
      packages: packages.ranges,
    } satisfies Survey
  })

/** What the updater reads from the network, so a test can stand in for it. */
export type Get = (url: string) => Effect.Effect<Uint8Array, SourceError>

/** The bytes at a URL, through the vendor script's download. */
const fetchBytes: Get = (url) =>
  Effect.tryPromise({
    try: () => download(url),
    catch: (cause) => new SourceError({ source: url, cause }),
  })

const fetchText = (get: Get, url: string) =>
  get(url).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)))

/** The program inside a release archive, by its path in the archive. */
const programOf = (asset: Asset, archive: Uint8Array, path: string) =>
  Effect.tryPromise({
    try: () => readArchive(asset.format, archive, [path]).then((files) => files.get(path)),
    catch: (cause) => new SourceError({ source: asset.url, cause }),
  }).pipe(
    Effect.flatMap((program) =>
      program === undefined
        ? Effect.fail(new SourceError({ source: asset.url, cause: `the archive has no ${path}` }))
        : Effect.succeed(program),
    ),
  )

/** Where a SHA-256 was published and what it is. */
interface Published {
  readonly hash: string
  readonly via: string
}

/** Fails with `ChecksumMismatch` unless the archive's SHA-256 is the published one. */
export const verifyChecksum = (url: string, actual: string, published: Published) =>
  actual === published.hash
    ? Effect.void
    : Effect.fail(
        new ChecksumMismatch({ url, actual, expected: published.hash, via: published.via }),
      )

const published = (
  url: string,
  via: string,
  hash: string | undefined,
): Effect.Effect<Published, SourceError> =>
  hash === undefined
    ? Effect.fail(new SourceError({ source: url, cause: `${via} publishes no SHA-256` }))
    : Effect.succeed({ hash, via })

/**
 * The SHA-256 that a tool's release publishes for each archive, by archive URL: ripgrep's
 * `<archive>.sha256` file, or, for fd, which publishes no file, the `digest` that GitHub's release
 * API reports for the asset. It fails when the release publishes none for an archive, because an
 * archive that nothing independent vouches for is not pinned.
 */
const publishedChecksums = (
  tool: VendoredTool,
  urls: ReadonlyArray<string>,
  tag: string,
  get: Get,
) =>
  Effect.gen(function* () {
    const { repository, checksums } = VENDORED[tool]
    if (checksums === "file")
      return new Map(
        yield* Effect.forEach(urls, (url) =>
          fetchText(get, `${url}.sha256`).pipe(
            Effect.flatMap((text) => published(url, `${url}.sha256`, parseChecksumFile(text))),
            Effect.map((entry) => [url, entry] as const),
          ),
        ),
      )
    const api = `${GITHUB_API}/repos/${repository}/releases/tags/${tag}`
    const release = yield* fetchText(get, api).pipe(
      Effect.flatMap((text) =>
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(GithubRelease),
          strict,
        )(text).pipe(Effect.mapError((cause) => new SourceError({ source: api, cause }))),
      ),
    )
    const digests = new Map(release.assets.map(({ name, digest }) => [name, digest ?? ""] as const))
    return new Map(
      yield* Effect.forEach(urls, (url) =>
        published(
          url,
          `the GitHub release API (${api})`,
          parseDigest(digests.get(url.slice(url.lastIndexOf("/") + 1)) ?? ""),
        ).pipe(Effect.map((entry) => [url, entry] as const)),
      ),
    )
  })

/** A release archive of a vendored tool that was downloaded and checked. */
export interface Downloaded {
  /** The asset at its new version, with the hashes it has now. */
  readonly asset: Asset
  readonly archive: Uint8Array
  readonly hashes: Hashes
}

/**
 * Downloads a vendored tool's release archives for every target and returns them with their hashes,
 * by target id: the SHA-256 of each archive and of the program inside. The archives are the current
 * ones with the version replaced in their URL and folder. Each archive is hashed once and compared
 * with the hash its release publishes (see `publishedChecksums`) before its contents are read, and
 * a difference fails with `ChecksumMismatch`, so no hash is pinned on the word of one download.
 */
export const fetchVendored = (
  tool: VendoredTool,
  from: string,
  to: string,
  get: Get = fetchBytes,
) =>
  Effect.gen(function* () {
    const assets = ASSETS.filter((asset) => asset.project === tool).map((asset): Asset => ({
      ...asset,
      url: asset.url.replaceAll(from, to),
      folder: asset.folder.replaceAll(from, to),
    }))
    const checksums = yield* publishedChecksums(
      tool,
      assets.map((asset) => asset.url),
      `${VENDORED[tool].prefix}${to}`,
      get,
    )
    return yield* Effect.forEach(
      assets,
      (asset) =>
        Effect.gen(function* () {
          const archive = yield* get(asset.url)
          const hash = sha256(archive)
          const expected = checksums.get(asset.url)
          if (expected === undefined)
            return yield* Effect.fail(new SourceError({ source: asset.url, cause: "no checksum" }))
          yield* verifyChecksum(asset.url, hash, expected)
          const program = yield* programOf(
            asset,
            archive,
            `${asset.folder}/${asset.tool}${asset.target.suffix}`,
          )
          const hashes = { archive: hash, binary: sha256(program) }
          return [
            asset.target.id,
            {
              asset: { ...asset, archiveSha256: hashes.archive, binarySha256: hashes.binary },
              archive,
              hashes,
            },
          ] as const
        }),
      { concurrency: 2 },
    ).pipe(Effect.map((entries): ReadonlyMap<string, Downloaded> => new Map(entries)))
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
      return [file, `${JSON.stringify(withPackageRanges(manifest, ranges), null, 2)}\n`] as const
    }),
  )

const writeRanges = (root: string, packages: Survey["packages"]) =>
  renderRanges(root, packages).pipe(
    Effect.flatMap((rendered) =>
      Effect.forEach(rendered, ([file, text]) => writeText(root, file, text)),
    ),
  )

/**
 * Writes the moves a survey found. Everything that can fail on the network or on a file is done
 * first: the new texts of the workflows, `mise.toml`, the manifests and the vendored pins are
 * computed, and every moved archive is downloaded and checked against its release's published
 * SHA-256. Only then is anything written, so a failed download leaves the tree unchanged. The moved
 * programs are installed from the archives already downloaded, `scripts/vendor.ts` (the `vendor`
 * task) removes what no pin names, and `bun update` then refreshes the lockfile within the new
 * ranges. The installs run with `--ignore-scripts`, so a freshly published package never runs code
 * on this machine.
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
    const moved = found.pins.filter((pin) => pin.kind === "vendor" && isBehind(pin))
    let vendor = yield* readText(root, VENDOR_PINS)
    const archives: Array<Downloaded> = []
    for (const pin of moved) {
      const tool = pin.name as VendoredTool
      const fetched = yield* fetchVendored(tool, pin.current, pin.next)
      archives.push(...fetched.values())
      const hashes = new Map([...fetched].map(([target, { hashes }]) => [target, hashes] as const))
      vendor = yield* Effect.try({
        try: () => rewriteVendoredTool(vendor, tool, pin.next, hashes),
        catch: (cause) => new FileError({ file: VENDOR_PINS, cause }),
      })
    }
    for (const [file, text] of workflows) yield* writeText(root, file, text)
    yield* writeText(root, "mise.toml", mise)
    for (const [file, text] of ranges) yield* writeText(root, file, text)
    if (moved.length > 0) {
      yield* writeText(root, VENDOR_PINS, vendor)
      for (const { asset, archive } of archives)
        yield* Effect.tryPromise({
          try: () => installAsset(join(root, VENDOR_DIRECTORY), asset, archive),
          catch: (cause) => new FileError({ file: asset.url, cause }),
        })
      yield* run("bun scripts/vendor.ts", () => $`bun scripts/vendor.ts`.cwd(root).nothrow())
    }
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

/** The steps of a run that touch the network and the tree, so a test can stand in for them. */
export interface Steps {
  readonly survey: (root: string) => Effect.Effect<Survey, FileError | SourceError>
  readonly apply: (
    root: string,
    found: Survey,
  ) => Effect.Effect<void, CommandError | FileError | SourceError | ChecksumMismatch>
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
