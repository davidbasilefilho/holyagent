import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { Data, Effect, Schema } from "effect"

import { pathProblem, pathsOverlap } from "../domain/paths.ts"
import { hasCode } from "./files.ts"
import { MigrationJournalFile, MigrationJournalSource } from "./migration-journal.ts"

/** A migration path could not be safely verified or changed. */
export class MigrationFilesError extends Data.TaggedError("MigrationFilesError")<{
  readonly path: string
  readonly reason: string
}> {
  /** A diagnostic that does not include file contents. */
  override get message() {
    return `Migration file ${this.path}: ${this.reason}`
  }
}

const fail = (path: string, reason: string) => new MigrationFilesError({ path, reason })
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const blob = (bytes: Buffer, id: string) =>
  createHash(id.length === 40 ? "sha1" : "sha256")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex")
const operation = <A>(path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof MigrationFilesError
        ? cause
        : fail(path, "filesystem operation failed; inspect and retry"),
  })
const sameIdentity = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino
const missing = (cause: unknown) => hasCode(cause, "ENOENT")
const infoOrMissing = async (path: string) => {
  try {
    return await lstat(path)
  } catch (cause) {
    if (missing(cause)) return undefined
    throw cause
  }
}

const validatePaths = (root: string, paths: readonly string[]) => {
  if (!isAbsolute(root) || resolve(root) !== root)
    throw fail(root, "root must be canonical and absolute")
  for (const [i, path] of paths.entries())
    if (
      pathProblem(path) !== undefined ||
      paths.slice(0, i).some((other) => pathsOverlap(path, other))
    )
      throw fail(path, "invalid or overlapping path")
}
const validateFiles = (root: string, input: readonly MigrationJournalFile[]) => {
  let files: readonly MigrationJournalFile[]
  try {
    files = Schema.decodeUnknownSync(Schema.Array(MigrationJournalFile), {
      onExcessProperty: "error",
    })(input)
  } catch {
    throw fail(root, "invalid file records")
  }
  validatePaths(
    root,
    files.map((file) => file.path),
  )
  for (const file of files) {
    const bytes = Buffer.from(file.content, "base64")
    if (
      !oid.test(file.after) ||
      (file.before !== null && !oid.test(file.before)) ||
      (file.mode !== 0o100644 && file.mode !== 0o100755) ||
      bytes.toString("base64") !== file.content ||
      blob(bytes, file.after) !== file.after
    )
      throw fail(file.path, "invalid file postimage")
  }
  return files
}
const validateSources = (root: string, input: readonly MigrationJournalSource[]) => {
  let source: readonly MigrationJournalSource[]
  try {
    source = Schema.decodeUnknownSync(Schema.Array(MigrationJournalSource), {
      onExcessProperty: "error",
    })(input)
  } catch {
    throw fail(root, "invalid source records")
  }
  validatePaths(
    root,
    source.map((file) => file.path),
  )
  for (const file of source)
    if (!oid.test(file.digest)) throw fail(file.path, "invalid source digest")
  return source
}

/**
 * Check each component without following links. These checks do not provide OS filesystem
 * isolation.
 */
const parents = async (root: string, path: string) => {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (await realpath(root)) !== root)
    throw fail(root, "root is not a canonical directory")
  const checked = [{ path: root, info: rootInfo }]
  let current = root
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part)
    const info = await infoOrMissing(current)
    if (info === undefined) break
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
      throw fail(path, "parent is not a canonical directory")
    checked.push({ path: current, info })
  }
  return checked
}
const recheck = async (checked: Awaited<ReturnType<typeof parents>>, path: string) => {
  for (const entry of checked) {
    const latest = await lstat(entry.path)
    if (
      !latest.isDirectory() ||
      latest.isSymbolicLink() ||
      !sameIdentity(entry.info, latest) ||
      (await realpath(entry.path)) !== entry.path
    )
      throw fail(path, "parent changed")
  }
}
const readRegular = async (path: string) => {
  const before = await infoOrMissing(path)
  if (before === undefined) return undefined
  if (!before.isFile() || before.isSymbolicLink()) throw fail(path, "path is not a regular file")
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    const latest = await lstat(path)
    if (
      !info.isFile() ||
      !latest.isFile() ||
      latest.isSymbolicLink() ||
      !sameIdentity(before, info) ||
      !sameIdentity(info, latest)
    )
      throw fail(path, "file changed while reading")
    return { bytes: await handle.readFile(), info }
  } finally {
    await handle.close()
  }
}
const matchesMode = (mode: number, expected: number) =>
  process.platform === "win32" || (mode & 0o111) === (expected & 0o111)

/** Publish absent postimages with an exclusive hard link; existing matching files are unchanged. */
export const publishMigrationFiles = <E, R>(options: {
  readonly root: string
  readonly files: readonly MigrationJournalFile[]
  readonly authorize: Effect.Effect<void, E, R>
}) =>
  Effect.gen(function* () {
    const files = yield* operation(options.root, () =>
      Promise.resolve().then(() => validateFiles(options.root, options.files)),
    )
    for (const file of files) {
      const path = join(options.root, file.path)
      let checked = yield* operation(path, () => parents(options.root, file.path))
      const existing = yield* operation(path, () => readRegular(path))
      if (existing !== undefined) {
        if (
          blob(existing.bytes, file.after) === file.after &&
          matchesMode(existing.info.mode, file.mode)
        ) {
          yield* operation(path, () => recheck(checked, path))
          continue
        }
        if (
          file.before === null ||
          blob(existing.bytes, file.before) !== file.before ||
          !matchesMode(existing.info.mode, file.mode)
        )
          return yield* fail(file.path, "existing file differs from preimage")
      } else if (file.before !== null) return yield* fail(file.path, "preexisting file was deleted")
      const components = file.path.split("/").slice(0, -1)
      for (let i = checked.length - 1; i < components.length; i++) {
        const dir = join(options.root, ...components.slice(0, i + 1))
        yield* operation(dir, () => recheck(checked, path))
        yield* options.authorize
        yield* operation(dir, async () => {
          try {
            await mkdir(dir)
          } catch (cause) {
            if (!hasCode(cause, "EEXIST")) throw cause
          }
        }).pipe(Effect.uninterruptible)
        checked = yield* operation(dir, () => parents(options.root, file.path))
      }
      yield* operation(path, () => recheck(checked, path))
      yield* options.authorize
      const temporary = join(dirname(path), `.holyagent-migration-${randomUUID()}.tmp`)
      // The finalizer waits for a cancelled preparation to settle before removing its temporary.
      // Its only uninterruptible part before publication is creating the promise itself.
      let created = false
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const preparation = (async () => {
            const handle = await open(temporary, "wx", file.mode & 0o777)
            created = true
            try {
              await handle.writeFile(Buffer.from(file.content, "base64"))
              if (process.platform !== "win32") await handle.chmod(file.mode & 0o777)
              await handle.sync()
            } finally {
              await handle.close()
            }
          })()
          // Install a rejection handler even if interruption wins the race with preparation.
          void preparation.catch(() => {})
          return preparation
        }),
        (preparation) =>
          Effect.gen(function* () {
            yield* operation(path, () => preparation)
            yield* operation(path, () => recheck(checked, path))
            if (existing !== undefined) {
              const latest = yield* operation(path, () => readRegular(path))
              if (
                latest === undefined ||
                !sameIdentity(existing.info, latest.info) ||
                file.before === null ||
                blob(latest.bytes, file.before) !== file.before ||
                !matchesMode(latest.info.mode, file.mode)
              )
                return yield* fail(file.path, "preexisting file changed during publication")
            }
            yield* options.authorize
            yield* operation(path, () =>
              existing === undefined ? link(temporary, path) : rename(temporary, path),
            ).pipe(Effect.uninterruptible)
          }),
        (preparation) =>
          Effect.promise(async () => {
            await preparation.catch(() => {})
            if (created) await rm(temporary, { force: true }).catch(() => {})
          }),
      )
    }
  })

/**
 * Caller verifies target publication first. Tracking must be checked against the current trusted
 * index.
 */
export const cleanupMigrationSources = <E, R, E2 = never, R2 = never>(options: {
  readonly root: string
  readonly source: readonly MigrationJournalSource[]
  readonly authorize: Effect.Effect<void, E, R>
  readonly isTracked?: (path: string) => Effect.Effect<boolean, E2, R2>
}) =>
  Effect.gen(function* () {
    const source = yield* operation(options.root, () =>
      Promise.resolve().then(() => validateSources(options.root, options.source)),
    )
    const removed: string[] = []
    const retained: { path: string; reason: string }[] = []
    for (const file of source) {
      const path = join(options.root, file.path)
      const checked = yield* operation(path, () => parents(options.root, file.path))
      const current = yield* operation(path, () => readRegular(path))
      if (current === undefined) continue
      if (
        file.tracked ||
        options.isTracked === undefined ||
        (yield* options.isTracked(file.path))
      ) {
        retained.push({ path: file.path, reason: "tracked or tracking unknown" })
        continue
      }
      if (blob(current.bytes, file.digest) !== file.digest) {
        retained.push({ path: file.path, reason: "changed" })
        continue
      }
      yield* options.authorize
      if (yield* options.isTracked(file.path)) {
        retained.push({ path: file.path, reason: "tracked" })
        continue
      }
      const latest = yield* operation(path, async () => {
        await recheck(checked, path)
        return readRegular(path)
      })
      if (latest === undefined) continue
      if (
        !sameIdentity(current.info, latest.info) ||
        blob(latest.bytes, file.digest) !== file.digest
      ) {
        retained.push({ path: file.path, reason: "changed" })
        continue
      }
      yield* options.authorize
      yield* operation(path, () => unlink(path)).pipe(Effect.uninterruptible)
      removed.push(file.path)
    }
    return { removed, retained }
  })

/** Verify all recorded postimages without creating or modifying paths. */
export const verifyMigrationFiles = (options: {
  readonly root: string
  readonly files: readonly MigrationJournalFile[]
}) =>
  Effect.gen(function* () {
    const files = yield* operation(options.root, () =>
      Promise.resolve().then(() => validateFiles(options.root, options.files)),
    )
    for (const file of files) {
      const path = join(options.root, file.path)
      yield* operation(path, async () => {
        const checked = await parents(options.root, file.path)
        const actual = await readRegular(path)
        if (
          actual === undefined ||
          blob(actual.bytes, file.after) !== file.after ||
          !matchesMode(actual.info.mode, file.mode)
        )
          throw fail(file.path, "file does not match postimage")
        await recheck(checked, path)
      })
    }
  })

/** Check the recorded target preimages before publishing the commit ref. */
export const verifyMigrationFilePreimages = (options: {
  readonly root: string
  readonly files: readonly MigrationJournalFile[]
}) =>
  Effect.gen(function* () {
    const files = yield* operation(options.root, () =>
      Promise.resolve().then(() => validateFiles(options.root, options.files)),
    )
    for (const file of files) {
      const path = join(options.root, file.path)
      yield* operation(path, async () => {
        const checked = await parents(options.root, file.path)
        const actual = await readRegular(path)
        if (
          actual === undefined
            ? file.before !== null
            : file.before === null ||
              !matchesMode(actual.info.mode, file.mode) ||
              blob(actual.bytes, file.before) !== file.before
        )
          throw fail(file.path, "file does not match a recorded migration preimage")
        await recheck(checked, path)
      })
    }
  })

/** Snapshot one source regular file without following links in its path. */
export const readMigrationSource = (options: { readonly root: string; readonly path: string }) =>
  operation(options.root, async () => {
    validatePaths(options.root, [options.path])
    const checked = await parents(options.root, options.path)
    const value = await readRegular(join(options.root, options.path))
    if (value === undefined) throw fail(options.path, "source disappeared during preparation")
    await recheck(checked, options.path)
    return {
      bytes: value.bytes,
      mode: process.platform !== "win32" && (value.info.mode & 0o111) !== 0 ? 0o100755 : 0o100644,
    }
  })
