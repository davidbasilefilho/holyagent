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

/**
 * How long a contender waits for a lock: a holder that commits to git keeps it for a while, and a
 * plugin hook, which the host kills after 10 seconds, waits only a few seconds so that it fails
 * cleanly with StateLocked instead.
 */
export type Patience = "short" | "long" | "hook"

/**
 * Each patience polls every `delay` milliseconds for at most `limit` milliseconds. With `stuck`, a
 * lock that a live process took longer ago than the limit is respected at once: its holder is
 * stuck, not busy, and a contender that waited on it would only wait the whole limit.
 */
const WAITS = {
  // The state lock is held across a git commit, which takes a while on Windows or in a large tree.
  short: { delay: 25, limit: 30_000, stuck: true },
  // For a holder that works for as long as a checkout of a large repository takes, about a minute.
  long: { delay: 50, limit: 60_000, stuck: false },
  // Well inside the 10 second timeout of a plugin hook, which also has its own work to do.
  hook: { delay: 25, limit: 3_000, stuck: true },
} as const

/** True unless the lock was taken by a live process more than `limit` milliseconds ago. */
const holderBusy = (file: string, limit: number) =>
  Effect.gen(function* () {
    const owner = yield* readOwner(file)
    return owner === undefined || (yield* Clock.currentTimeMillis) - owner.acquiredAt < limit
  })

const acquire = (file: string, patience: Patience = "short") => {
  const { delay, limit, stuck } = WAITS[patience]
  return claim(file).pipe(
    Effect.catchTag("StateLocked", (locked) =>
      breakIfStale(file).pipe(Effect.andThen(Effect.fail(locked))),
    ),
    Effect.retry({
      schedule: Schedule.spaced(delay),
      times: limit / delay,
      while: (error) =>
        error._tag === "StateLocked" && stuck
          ? holderBusy(file, limit)
          : error._tag === "StateLocked",
    }),
  )
}

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
 * outcome. A contender retries until its patience runs out, then fails with StateLocked: up to 30
 * seconds with `"short"` (the default; a holder keeps the lock for as long as a git commit takes),
 * a minute with `"long"` for a holder that does slow work, or 3 seconds with `"hook"` for a caller
 * under a hook timeout. With `"short"` and `"hook"`, a lock a live process has held longer than the
 * limit fails at once, since its holder is stuck; `"long"` never does and waits the whole limit.
 * The folder of the file is made when it is missing.
 */
export const withFileLock = <A, E, R>(
  file: string,
  use: Effect.Effect<A, E, R>,
  patience: Patience = "short",
) =>
  Effect.acquireUseRelease(
    io(file, () => mkdir(dirname(file), { recursive: true })).pipe(
      Effect.andThen(acquire(file, patience)),
    ),
    () => use,
    (token) => release(file, token),
  )

/**
 * Runs `use` while holding the state lock (`local/lock` of the state folder), so two processes
 * never interleave their reads and writes. `patience` is as for {@link withFileLock}.
 */
export const withStateLock = <A, E, R>(
  directory: string,
  use: Effect.Effect<A, E, R>,
  patience: Patience = "short",
) =>
  Effect.acquireUseRelease(
    ensureLocalDirectory(directory).pipe(
      Effect.andThen(acquire(localFile(directory, "lock"), patience)),
    ),
    () => use,
    (token) => release(localFile(directory, "lock"), token),
  )
