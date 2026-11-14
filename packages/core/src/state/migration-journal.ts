import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, open, readdir, realpath, rename, rm } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

import { Data, Effect, Schema } from "effect"

import { pathProblem, pathsOverlap } from "../domain/paths.ts"

/** Recovery data is private to one migration and is never included in error messages. */
export const MigrationJournalFile = Schema.Struct({
  path: Schema.String,
  before: Schema.NullOr(Schema.String),
  after: Schema.String,
  content: Schema.String,
  mode: Schema.Int,
})
/** A recorded target file. */
export type MigrationJournalFile = typeof MigrationJournalFile.Type

/** Schema for a recorded source preimage. */
export const MigrationJournalSource = Schema.Struct({
  path: Schema.String,
  digest: Schema.String,
  tracked: Schema.Boolean,
})
/** A recorded source preimage. */
export type MigrationJournalSource = typeof MigrationJournalSource.Type

/** Schema for the durable transaction phase. */
export const MigrationJournalPhase = Schema.Literals([
  "prepared",
  "ref-published",
  "target-published",
  "source-cleaned",
])
/** A durable transaction phase. */
export type MigrationJournalPhase = typeof MigrationJournalPhase.Type

/** All paths are relative to their respective root, except the two canonical bound roots. */
export const MigrationJournal = Schema.Struct({
  version: Schema.Literal(1),
  transaction: Schema.String,
  sourceRoot: Schema.String,
  targetRoot: Schema.String,
  branch: Schema.String,
  parent: Schema.String,
  commit: Schema.String,
  tree: Schema.String,
  indexBefore: Schema.String,
  indexAfter: Schema.String,
  files: Schema.Array(MigrationJournalFile),
  source: Schema.Array(MigrationJournalSource),
  phase: MigrationJournalPhase,
})
/** A validated durable transaction record. */
export type MigrationJournal = typeof MigrationJournal.Type

/** Journal failures never print journal data, which can include state contents. */
export class MigrationJournalError extends Data.TaggedError("MigrationJournalError")<{
  readonly path: string
  readonly reason: string
}> {
  /** A diagnostic that excludes record contents. */
  override get message() {
    return `Migration recovery journal at ${this.path}: ${this.reason}`
  }
}

/** The caller derives `path` from trusted repository metadata, not from journal content. */
export interface MigrationJournalLocation {
  readonly path: string
  readonly sourceRoot: string
  readonly targetRoot: string
}

const MAX_BYTES = 16 * 1024 * 1024
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const PHASES: ReadonlyArray<MigrationJournalPhase> = [
  "prepared",
  "ref-published",
  "target-published",
  "source-cleaned",
]
const decode = Schema.decodeUnknownSync(MigrationJournal, { onExcessProperty: "error" })

const invalid = (location: MigrationJournalLocation, reason: string) =>
  new MigrationJournalError({ path: location.path, reason })

const canonicalAbsolute = (path: string) => isAbsolute(path) && resolve(path) === path
const isMissing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

/** Check the complete record, including invariants not expressible by its structural schema. */
const validate = (location: MigrationJournalLocation, value: unknown): MigrationJournal => {
  let record: MigrationJournal
  try {
    record = decode(value)
  } catch {
    throw invalid(location, "invalid or unsupported journal; inspect it before retrying")
  }
  const validBranch =
    record.branch.length > 0 &&
    !record.branch.startsWith("-") &&
    !record.branch.startsWith("/") &&
    !record.branch.endsWith("/") &&
    !record.branch.endsWith(".") &&
    !record.branch.includes("..") &&
    !record.branch.includes("@{") &&
    !Array.from(record.branch).some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    ) &&
    !["~", "^", ":", "?", "*", "[", "\\"].some((char) => record.branch.includes(char)) &&
    record.branch
      .split("/")
      .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  const validContent = (content: string) =>
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content) &&
    Buffer.from(content, "base64").toString("base64") === content
  const matchesBlob = (file: MigrationJournalFile) => {
    const bytes = Buffer.from(file.content, "base64")
    return (
      createHash(file.after.length === 40 ? "sha1" : "sha256")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex") === file.after
    )
  }
  const filePaths = record.files.map((file) => file.path)
  const sourcePaths = record.source.map((file) => file.path)
  const unique = (paths: ReadonlyArray<string>) =>
    paths.every(
      (path, i) =>
        pathProblem(path) === undefined &&
        !paths.slice(0, i).some((prior) => pathsOverlap(prior, path)),
    )
  if (
    !canonicalAbsolute(record.sourceRoot) ||
    !canonicalAbsolute(record.targetRoot) ||
    record.sourceRoot !== location.sourceRoot ||
    record.targetRoot !== location.targetRoot ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(record.transaction) ||
    !validBranch ||
    ![record.parent, record.commit, record.tree].every((oid) => OID.test(oid)) ||
    ![record.indexBefore, record.indexAfter].every((hash) => FINGERPRINT.test(hash)) ||
    !unique(filePaths) ||
    !unique(sourcePaths) ||
    !record.files.every(
      (file) =>
        (file.before === null || OID.test(file.before)) &&
        OID.test(file.after) &&
        (file.mode === 0o100644 || file.mode === 0o100755) &&
        validContent(file.content) &&
        matchesBlob(file),
    ) ||
    !record.source.every((file) => OID.test(file.digest))
  )
    throw invalid(location, "invalid journal fields or root binding; inspect it before retrying")
  return record
}

const owner = (info: { uid: number; mode: number }) =>
  (typeof process.getuid !== "function" || info.uid === process.getuid()) &&
  (info.mode & 0o022) === 0

/** A crash after the exclusive link may leave our synced temporary name as a second link. */
const temporaryAlias = async (
  location: MigrationJournalLocation,
  info: { dev: number; ino: number },
) => {
  const prefix = `${basename(location.path)}.`
  const names = await readdir(dirname(location.path))
  const candidates = names.filter(
    (name) => name.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/.test(name.slice(prefix.length)),
  )
  const aliases: Array<string> = []
  for (const name of candidates) {
    const path = join(dirname(location.path), name)
    try {
      const entry = await lstat(path)
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.dev === info.dev &&
        entry.ino === info.ino
      )
        aliases.push(path)
    } catch (cause) {
      if (!isMissing(cause)) throw cause
    }
  }
  return aliases
}

const removeTemporaryAlias = async (location: MigrationJournalLocation) => {
  const info = await lstat(location.path)
  if (info.nlink === 2) {
    const aliases = await temporaryAlias(location, info)
    if (aliases.length !== 1) throw invalid(location, "journal has an unexpected hard link")
    await rm(aliases[0]!)
  }
}

/** Require trusted canonical existing roots and a private, non-link journal parent. */
const checkLocation = async (location: MigrationJournalLocation) => {
  if (![location.path, location.sourceRoot, location.targetRoot].every(canonicalAbsolute))
    throw invalid(location, "journal path and trusted roots must be canonical absolute paths")
  try {
    const parent = dirname(location.path)
    const [directory, actualParent, source, target, sourceInfo, targetInfo] = await Promise.all([
      lstat(parent),
      realpath(parent),
      realpath(location.sourceRoot),
      realpath(location.targetRoot),
      lstat(location.sourceRoot),
      lstat(location.targetRoot),
    ])
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !owner(directory) ||
      actualParent !== parent ||
      !sourceInfo.isDirectory() ||
      !targetInfo.isDirectory() ||
      source !== location.sourceRoot ||
      target !== location.targetRoot
    )
      throw invalid(
        location,
        "journal parent or trusted roots are not private canonical directories",
      )
  } catch (cause) {
    if (cause instanceof MigrationJournalError) throw cause
    throw invalid(location, "cannot verify journal parent and trusted roots")
  }
}

const read = async (location: MigrationJournalLocation): Promise<MigrationJournal | undefined> => {
  await checkLocation(location)
  let handle
  try {
    handle = await open(location.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (cause) {
    if (isMissing(cause)) return undefined
    throw invalid(location, "cannot safely open journal; inspect it before retrying")
  }
  try {
    const [info, pathInfo] = await Promise.all([handle.stat(), lstat(location.path)])
    if (
      !info.isFile() ||
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      !owner(info) ||
      (info.mode & 0o077) !== 0 ||
      info.dev !== pathInfo.dev ||
      info.ino !== pathInfo.ino ||
      info.size > MAX_BYTES
    )
      throw invalid(location, "journal is not an owned private regular file")
    if (
      info.nlink !== 1 &&
      !(info.nlink === 2 && (await temporaryAlias(location, info)).length === 1)
    )
      throw invalid(location, "journal has an unexpected hard link")
    const text = await handle.readFile("utf8")
    if (Buffer.byteLength(text) > MAX_BYTES) throw invalid(location, "journal exceeds size limit")
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw invalid(location, "journal is corrupt; inspect it before retrying")
    }
    return validate(location, value)
  } finally {
    await handle.close()
  }
}

const syncDirectory = async (location: MigrationJournalLocation) => {
  // Windows does not support opening directories for fsync. File replacement remains atomic there.
  if (process.platform === "win32") return
  const directory = await open(dirname(location.path), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

const encoded = (location: MigrationJournalLocation, record: MigrationJournal) => {
  validate(location, record)
  const contents = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(contents) > MAX_BYTES) throw invalid(location, "journal exceeds size limit")
  return contents
}

const write = async (
  location: MigrationJournalLocation,
  record: MigrationJournal,
  create: boolean,
) => {
  const contents = encoded(location, record)
  const temporary = `${location.path}.${crypto.randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(contents, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    // Link is create-exclusive; it cannot replace a foreign or corrupt journal.
    if (create) {
      await link(temporary, location.path)
      await rm(temporary)
    } else await rename(temporary, location.path)
    await syncDirectory(location)
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

const operation = <A>(location: MigrationJournalLocation, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof MigrationJournalError
        ? cause
        : invalid(location, "journal I/O failed; inspect it before retrying"),
  })

/** Read only. Callers must block ordinary readers if any pending journal exists. */
export const readMigrationJournal = (location: MigrationJournalLocation) =>
  operation(location, () => read(location))

/**
 * Caller holds the initialization/state lock. An authorized small atomic write is allowed to finish
 * on interruption. A foreign existing file is never replaced.
 */
export const beginMigrationJournal = <E>(
  location: MigrationJournalLocation,
  record: MigrationJournal,
  authorize: Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    if (record.phase !== "prepared")
      return yield* invalid(location, "a new journal must be prepared")
    yield* operation(location, async () => {
      await checkLocation(location)
      encoded(location, record)
      if ((await read(location)) !== undefined)
        throw invalid(location, "a journal already exists; recover it first")
    })
    yield* authorize
    yield* Effect.uninterruptible(operation(location, () => write(location, record, true)))
  })

/** Compare transaction and phase, then advance exactly one step; immutable data is retained. */
export const advanceMigrationJournal = <E>(
  location: MigrationJournalLocation,
  transaction: string,
  expected: MigrationJournalPhase,
  next: MigrationJournalPhase,
  authorize: Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    if (PHASES.indexOf(next) !== PHASES.indexOf(expected) + 1)
      return yield* invalid(location, "invalid journal phase transition")
    const current = yield* operation(location, () => read(location))
    if (current === undefined || current.transaction !== transaction || current.phase !== expected)
      return yield* invalid(location, "journal changed or is missing; reload recovery state")
    yield* authorize
    return yield* Effect.uninterruptible(
      operation(location, async () => {
        const latest = await read(location)
        if (latest === undefined || JSON.stringify(latest) !== JSON.stringify(current))
          throw invalid(location, "journal changed during authorization; reload recovery state")
        await removeTemporaryAlias(location)
        const updated: MigrationJournal = { ...current, phase: next }
        await write(location, updated, false)
        return updated
      }),
    )
  })

/** Remove only the exact completed transaction, after the caller verifies coherent publication. */
export const finishMigrationJournal = <E>(
  location: MigrationJournalLocation,
  transaction: string,
  authorize: Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    const current = yield* operation(location, () => read(location))
    if (
      current === undefined ||
      current.transaction !== transaction ||
      current.phase !== "source-cleaned"
    )
      return yield* invalid(location, "journal is missing, changed, or not complete")
    yield* authorize
    yield* Effect.uninterruptible(
      operation(location, async () => {
        const latest = await read(location)
        if (latest === undefined || JSON.stringify(latest) !== JSON.stringify(current))
          throw invalid(location, "journal changed during authorization; reload recovery state")
        await removeTemporaryAlias(location)
        await rm(location.path)
        await syncDirectory(location)
      }),
    )
  })
