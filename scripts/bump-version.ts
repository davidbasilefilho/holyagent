import { join } from "node:path"

import { Console, Data, Effect, Schema } from "effect"

/** The positions a bump can advance. */
export type BumpKind = "minor" | "patch" | "hotfix"

/** A version `0.<minor>.<patch>` with an optional `-<hotfix>` suffix. The major is always 0. */
export interface Version {
  readonly minor: number
  readonly patch: number
  readonly hotfix?: number
}

/** A string is not a `0.X.Y` or `0.X.Y-Z` version. */
export class InvalidVersion extends Data.TaggedError("InvalidVersion")<{
  readonly input: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `Invalid version ${JSON.stringify(this.input)}; expected 0.X.Y or 0.X.Y-Z without leading zeros`
  }
}

/** A version file or the lockfile could not be read, decoded or written. */
export class ManifestError extends Data.TaggedError("ManifestError")<{
  readonly file: string
  readonly cause: unknown
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.file}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

/** The version files do not all carry the same version, so there is no single version to bump. */
export class VersionMismatch extends Data.TaggedError("VersionMismatch")<{
  readonly versions: ReadonlyArray<{ readonly file: string; readonly version: string }>
}> {
  /** The description shown to the user. */
  override get message() {
    const listed = this.versions.map(({ file, version }) => `${file} ${version}`).join(", ")
    return `Versions disagree: ${listed}`
  }
}

/** The command line arguments are not `<minor|patch|hotfix> [root]`. */
export class Usage extends Data.TaggedError("Usage")<{ readonly kind: string | undefined }> {
  /** The description shown to the user. */
  override get message() {
    return `Expected minor, patch or hotfix and an optional root directory; got ${this.kind ?? "nothing"}`
  }
}

const NUMBER = String.raw`(0|[1-9]\d*)`
const VERSION = new RegExp(String.raw`^0\.${NUMBER}\.${NUMBER}(?:-([1-9]\d*))?$`)

/** Parses `0.X.Y` or `0.X.Y-Z`, failing with InvalidVersion on anything else. */
export const parseVersion = (input: string): Effect.Effect<Version, InvalidVersion> => {
  const [, minor, patch, hotfix] = VERSION.exec(input) ?? []
  return minor === undefined || patch === undefined
    ? Effect.fail(new InvalidVersion({ input }))
    : Effect.succeed({
        minor: Number(minor),
        patch: Number(patch),
        ...(hotfix === undefined ? {} : { hotfix: Number(hotfix) }),
      })
}

/** Renders a version as `0.X.Y`, with `-Z` when it has a hotfix. */
export const formatVersion = ({ minor, patch, hotfix }: Version): string =>
  `0.${minor}.${patch}${hotfix === undefined ? "" : `-${hotfix}`}`

/**
 * Advances one position and resets the later ones: minor clears patch and hotfix, patch clears
 * hotfix.
 */
export const bumpVersion = (version: Version, kind: BumpKind): Version => {
  switch (kind) {
    case "minor":
      return { minor: version.minor + 1, patch: 0 }
    case "patch":
      return { minor: version.minor, patch: version.patch + 1 }
    case "hotfix":
      return { minor: version.minor, patch: version.patch, hotfix: (version.hotfix ?? 0) + 1 }
  }
}

/**
 * The package manifests that carry the one version, relative to the repository root. The plugin and
 * marketplace manifests are generated from the Claude integration's version by `mise run build`,
 * and the runtime CLI's `--version` reads the runtime's, so none of them is edited here.
 */
export const VERSION_FILES: ReadonlyArray<string> = [
  "package.json",
  "packages/runtime/package.json",
  "packages/integrations/claude/package.json",
]

/** The lockfile of a Bun workspace repository, relative to the repository root. */
export const LOCKFILE = "bun.lock"

// These files carry many fields this program does not own, and a strict decode of a struct that
// names only the version would reject them as excess. So each file is first decoded as a record of
// unknown values, which has no excess properties and keeps every field in its order for the write.
// The version is then decoded from that record with a struct whose open rest is explicit.
const Manifest = Schema.Record(Schema.String, Schema.Unknown)
type Manifest = typeof Manifest.Type
const Versioned = Schema.StructWithRest(Schema.Struct({ version: Schema.String }), [Manifest])

const strict = { onExcessProperty: "error" } as const

// bun.lock is JSONC that Bun rewrites on install, so the version of each workspace is replaced in
// place and every other byte stays. A workspace entry is the only place a "name" line is directly
// followed by a "version" line; the root workspace carries no version and the package entries are
// arrays.
const WORKSPACE_VERSION = /("name": "[^"]+",\n\s+"version": ")[^"]*(")/g

const failWith = (file: string) =>
  Effect.mapError((cause: unknown) => new ManifestError({ file, cause }))

const load = (root: string, file: string) => {
  const path = join(root, file)
  return Effect.gen(function* () {
    const text = yield* Effect.tryPromise(() => Bun.file(path).text())
    const manifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Manifest),
      strict,
    )(text)
    const { version } = yield* Schema.decodeUnknownEffect(Versioned, strict)(manifest)
    return { file, path, manifest, version }
  }).pipe(failWith(file))
}

const lockfileWithVersion = (text: string, version: string) =>
  text.search(WORKSPACE_VERSION) < 0
    ? Effect.fail(new ManifestError({ file: LOCKFILE, cause: "no workspace version found" }))
    : Effect.succeed(
        text.replace(
          WORKSPACE_VERSION,
          (_entry, head: string, tail: string) => `${head}${version}${tail}`,
        ),
      )

const BumpKindArgument = Schema.Literals(["minor", "patch", "hotfix"])

/**
 * Reads the version files and `bun.lock` under `root`, refuses when the files disagree, then writes
 * the bumped version to all of them and to every workspace entry of `bun.lock`. Nothing is written
 * unless every file was read and they agree. Returns the old and new version.
 */
export const bumpVersions = (
  root: string,
  kind: BumpKind,
): Effect.Effect<
  { readonly from: string; readonly to: string },
  ManifestError | VersionMismatch | InvalidVersion
> =>
  Effect.gen(function* () {
    const loaded = yield* Effect.forEach(VERSION_FILES, (file) => load(root, file))
    const [first] = loaded
    if (first === undefined || loaded.some(({ version }) => version !== first.version))
      return yield* new VersionMismatch({
        versions: loaded.map(({ file, version }) => ({ file, version })),
      })
    const from = first.version
    const to = formatVersion(bumpVersion(yield* parseVersion(from), kind))
    const lockPath = join(root, LOCKFILE)
    const lockText = yield* Effect.tryPromise(() => Bun.file(lockPath).text()).pipe(
      Effect.flatMap((text) => lockfileWithVersion(text, to)),
      failWith(LOCKFILE),
    )
    yield* Effect.forEach(loaded, ({ file, path, manifest }) =>
      Effect.tryPromise(() =>
        Bun.write(path, `${JSON.stringify({ ...manifest, version: to }, null, 2)}\n`),
      ).pipe(failWith(file)),
    )
    yield* Effect.tryPromise(() => Bun.write(lockPath, lockText)).pipe(failWith(LOCKFILE))
    return { from, to }
  })

/**
 * Runs `<minor|patch|hotfix> [root]`: bumps the versions under `root` (the repository root by
 * default), prints `old -> new`, or prints the failure and sets a failing exit code.
 */
export const main = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [argument, root = join(import.meta.dir, "..")] = args
    const kind = yield* Schema.decodeUnknownEffect(BumpKindArgument)(argument).pipe(
      Effect.mapError(() => new Usage({ kind: argument })),
    )
    const { from, to } = yield* bumpVersions(root, kind)
    yield* Console.log(`${from} -> ${to}`)
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
