import { mkdir, open, rm } from "node:fs/promises"
import { dirname } from "node:path"

import { Clock, Effect, Schedule, Schema } from "effect"

import { StateIo, StateLocked } from "./errors.ts"
import { encodeJson, hasCode, io, readJson } from "./files.ts"
import { localFile } from "./layout.ts"
import { ensureLocalDirectory } from "./local.ts"

const LockOwner = Schema.Struct({
  pid: Schema.Int,
  token: Schema.String,
  acquiredAt: Schema.Int,
})
type LockOwner = typeof LockOwner.Type

/** A lock whose owner cannot be read is taken as stale after this long, in milliseconds. */
const UNREADABLE_STALE_MS = 30_000

const readOwner = (file: string) =>
  readJson(LockOwner, file).pipe(Effect.orElseSucceed((): LockOwner | undefined => undefined))

/** EPERM still means the process exists; only ESRCH proves it is gone. */
const processAlive = (pid: number) =>
  Effect.try({ try: () => process.kill(pid, 0), catch: (cause) => cause }).pipe(
    Effect.as(true),
    Effect.catch((cause) => Effect.succeed(!hasCode(cause, "ESRCH"))),
  )

/**
 * Removes the lock when its process is gone, or when it is unreadable and old. The file is read
 * again before the removal and left alone if another owner took it meanwhile. Never fails.
 */
const breakIfStale = (file: string) =>
  Effect.gen(function* () {
    const owner = yield* readOwner(file)
    const stale = owner
      ? !(yield* processAlive(owner.pid))
      : (yield* Clock.currentTimeMillis) - Bun.file(file).lastModified > UNREADABLE_STALE_MS
    if (stale && (yield* readOwner(file))?.token === owner?.token)
      yield* io(file, () => rm(file, { force: true }))
  }).pipe(Effect.ignore)

/** Creates the lock file, which must not exist yet. Resolves to the owner's token. */
const claim = (file: string) =>
  Effect.gen(function* () {
    const owner: LockOwner = {
      pid: process.pid,
      token: crypto.randomUUID(),
      acquiredAt: yield* Clock.currentTimeMillis,
    }
    const content = yield* encodeJson(LockOwner, owner).pipe(Effect.orDie)
    const handle = yield* Effect.tryPromise({
      try: () => open(file, "wx"),
      catch: (cause) =>
        hasCode(cause, "EEXIST")
          ? new StateLocked({ lockFile: file })
          : new StateIo({ path: file, cause }),
    })
    // An empty lock would look unreadable until it ages out, so a failed write removes it.
    yield* io(file, () => handle.writeFile(content)).pipe(
      Effect.tapError(() => io(file, () => rm(file, { force: true })).pipe(Effect.ignore)),
      Effect.ensuring(io(file, () => handle.close()).pipe(Effect.ignore)),
    )
    return owner.token
  })

const acquire = (file: string) =>
  claim(file).pipe(
    Effect.catchTag("StateLocked", (locked) =>
      breakIfStale(file).pipe(Effect.andThen(Effect.fail(locked))),
    ),
    Effect.retry({
      schedule: Schedule.exponential("10 millis", 1.5),
      times: 10,
      while: (error) => error._tag === "StateLocked",
    }),
  )

/** Removes the lock file, but only while it still carries the token. Never fails. */
const release = (file: string, token: string) =>
  readOwner(file).pipe(
    Effect.flatMap((owner) =>
      owner?.token === token ? io(file, () => rm(file, { force: true })) : Effect.void,
    ),
    Effect.ignore,
  )

/**
 * Runs `use` while holding the lock file, so two processes never interleave. The lock is a file
 * created exclusively; one left by a dead process is broken, and the lock is released whatever the
 * outcome. A contender retries for about a second (a holder keeps the lock for milliseconds), then
 * fails with StateLocked. The folder of the file is made when it is missing.
 */
export const withFileLock = <A, E, R>(file: string, use: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    io(file, () => mkdir(dirname(file), { recursive: true })).pipe(Effect.andThen(acquire(file))),
    () => use,
    (token) => release(file, token),
  )

/**
 * Runs `use` while holding the state lock (`local/lock` of the state folder), so two processes
 * never interleave their reads and writes.
 */
export const withStateLock = <A, E, R>(directory: string, use: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    ensureLocalDirectory(directory).pipe(Effect.andThen(acquire(localFile(directory, "lock")))),
    () => use,
    (token) => release(localFile(directory, "lock"), token),
  )
