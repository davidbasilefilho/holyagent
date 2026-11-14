import { join } from "node:path"

import { Console, Data, Effect, Schema } from "effect"

/** The positions a bump can advance. */
export type BumpKind = "minor" | "patch"

/** A version `0.<minor>.<patch>`. The major is always 0 (ZeroVer). */
export interface Version {
  readonly minor: number
  readonly patch: number
}

/** A string is not a `0.X.Y` version. */
export class InvalidVersion extends Data.TaggedError("InvalidVersion")<{
  readonly input: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `Invalid version ${JSON.stringify(this.input)}; expected 0.X.Y without leading zeros`
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

/** The command line arguments are not `<minor|patch|sync> [root]`. */
export class Usage extends Data.TaggedError("Usage")<{ readonly kind: string | undefined }> {
  /** The description shown to the user. */
  override get message() {
    return `Expected minor, patch or sync and an optional root directory; got ${this.kind ?? "nothing"}`
  }
}

const NUMBER = String.raw`(0|[1-9]\d*)`
// A `-Z` suffix is tolerated on input only: earlier releases used it, so a repository still on one
// can bump out of it. It is dropped on parse and never written.
const VERSION = new RegExp(String.raw`^0\.${NUMBER}\.${NUMBER}(?:-[1-9]\d*)?$`)

/**
 * Parses `0.X.Y`, failing with InvalidVersion on anything else. A legacy `-Z` suffix is accepted
 * and dropped.
 */
export const parseVersion = (input: string): Effect.Effect<Version, InvalidVersion> => {
  const [, minor, patch] = VERSION.exec(input) ?? []
  return minor === undefined || patch === undefined
    ? Effect.fail(new InvalidVersion({ input }))
    : Effect.succeed({ minor: Number(minor), patch: Number(patch) })
}

/** Renders a version as `0.X.Y`. */
export const formatVersion = ({ minor, patch }: Version): string => `0.${minor}.${patch}`

/**
 * Orders two versions by minor, then patch: negative when `a` is older than `b`, zero when equal,
 * positive when newer. The major is always 0, so it takes no part.
 */
export const compareVersions = (a: Version, b: Version): number =>
  a.minor - b.minor || a.patch - b.patch

/** Advances one position and resets the later one: minor clears patch. */
export const bumpVersion = (version: Version, kind: BumpKind): Version => {
  switch (kind) {
    case "minor":
      return { minor: version.minor + 1, patch: 0 }
    case "patch":
      return { minor: version.minor, patch: version.patch + 1 }
  }
}

/**
 * The one hand-edited version, in the root manifest, relative to the repository root. Every other
 * copy is written from it by `syncVersions`, and `bumpVersions` edits nothing else.
 */
export const VERSION_SOURCE = "package.json"

/**
 * The workspace manifests that carry a copy of the version, relative to the repository root. Bun
 * workspaces and the generators read their own package's `version`, so the copy stays and
 * `syncVersions` writes it. The plugin and marketplace manifests are generated from the Claude
 * integration's copy and the Pi package manifest from the Pi integration's by `mise run build`, and
 * the CLI's `--version` reads the root manifest.
 */
export const VERSION_COPIES: ReadonlyArray<string> = [
  "packages/core/package.json",
  "packages/runtime/package.json",
  "packages/integrations/claude/package.json",
  "packages/integrations/pi/package.json",
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
const WORKSPACE_VERSION = /("name": "[^"]+",\r?\n\s+"version": ")[^"]*(")/g

const failWith = (file: string) =>
  Effect.mapError((cause: unknown) => new ManifestError({ file, cause }))

interface Loaded {
  readonly file: string
  readonly path: string
  readonly manifest: Manifest
  readonly version: string
}

const load = (root: string, file: string): Effect.Effect<Loaded, ManifestError> => {
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

/** Reads the `version` field of the manifest `file` under `root` without parsing it as `0.X.Y`. */
export const readVersion = (root: string, file: string): Effect.Effect<string, ManifestError> =>
  load(root, file).pipe(Effect.map(({ version }) => version))

const lockfileWithVersion = (text: string, version: string) =>
  text.search(WORKSPACE_VERSION) < 0
    ? Effect.fail(new ManifestError({ file: LOCKFILE, cause: "no workspace version found" }))
    : Effect.succeed(
        text.replace(
          WORKSPACE_VERSION,
          (_entry, head: string, tail: string) => `${head}${version}${tail}`,
        ),
      )

const CommandArgument = Schema.Literals(["minor", "patch", "sync"])

const writeLoaded = ({ file, path, manifest }: Loaded, version: string) =>
  Effect.tryPromise(() =>
    Bun.write(path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`),
  ).pipe(failWith(file))

/**
 * Reads the version of the root manifest under `root` and writes the next one back to it, nothing
 * else: the copies follow from `syncVersions`. Returns the old and new version.
 */
export const bumpVersions = (
  root: string,
  kind: BumpKind,
): Effect.Effect<{ readonly from: string; readonly to: string }, ManifestError | InvalidVersion> =>
  Effect.gen(function* () {
    const source = yield* load(root, VERSION_SOURCE)
    const from = source.version
    const to = formatVersion(bumpVersion(yield* parseVersion(from), kind))
    yield* writeLoaded(source, to)
    return { from, to }
  })

/**
 * Writes the version of the root manifest under `root` into every workspace manifest and every
 * workspace entry of `bun.lock`, leaving every other byte alone, and returns that version. A file
 * that already carries it is not written. Every file is read and checked before the first write, so
 * nothing is written when the source is not `0.X.Y`, a copy is unreadable or the lockfile has no
 * workspace version.
 */
export const syncVersions = (root: string): Effect.Effect<string, ManifestError | InvalidVersion> =>
  Effect.gen(function* () {
    const { version } = yield* load(root, VERSION_SOURCE)
    yield* parseVersion(version)
    const lockPath = join(root, LOCKFILE)
    const lockText = yield* Effect.tryPromise(() => Bun.file(lockPath).text()).pipe(
      failWith(LOCKFILE),
    )
    const synced = yield* lockfileWithVersion(lockText, version)
    const copies = yield* Effect.forEach(VERSION_COPIES, (file) => load(root, file))
    yield* Effect.forEach(
      copies.filter((copy) => copy.version !== version),
      (copy) => writeLoaded(copy, version),
    )
    if (synced !== lockText)
      yield* Effect.tryPromise(() => Bun.write(lockPath, synced)).pipe(failWith(LOCKFILE))
    return version
  })

/**
 * Runs `<minor|patch|sync> [root]` on `root` (the repository root by default): `minor` and `patch`
 * bump the root manifest and print `old -> new`, `sync` copies its version to the other files and
 * prints it. A failure is printed and sets a failing exit code.
 */
export const main = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [argument, root = join(import.meta.dir, "..")] = args
    const command = yield* Schema.decodeUnknownEffect(CommandArgument)(argument).pipe(
      Effect.mapError(() => new Usage({ kind: argument })),
    )
    if (command === "sync") return yield* Console.log(yield* syncVersions(root))
    const { from, to } = yield* bumpVersions(root, command)
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
