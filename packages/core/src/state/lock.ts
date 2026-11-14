import type { FileHandle } from "node:fs/promises"
import { link, lstat, mkdir, open, rename, rm, stat } from "node:fs/promises"
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

/** True unless `file` is certainly absent: a file that cannot even be examined is in the way. */
const inTheWay = (file: string) =>
  Effect.tryPromise({ try: () => lstat(file), catch: (cause) => cause }).pipe(
    Effect.as(true),
    Effect.catch((cause) => Effect.succeed(!hasCode(cause, "ENOENT"))),
  )

/**
 * Puts a lock moved aside back where it was, without overwriting a lock created there since. A hard
 * link cannot replace a file; when the file system has none (any failure but EEXIST), the lock is
 * renamed back if nothing is in the way. Never fails.
 */
const putBack = (taken: string, file: string) =>
  io(file, () => link(taken, file)).pipe(
    Effect.catch((error) =>
      hasCode(error.cause, "EEXIST")
        ? Effect.void
        : inTheWay(file).pipe(
            Effect.flatMap((present) =>
              present ? Effect.void : io(file, () => rename(taken, file)),
            ),
          ),
    ),
    Effect.ignore,
  )

/**
 * Removes the lock when its process is gone, or when it is unreadable and old. The lock is first
 * renamed to a name of its own, and the renamed file is checked: if it carries a different owner
 * than the one judged stale (another process claimed the lock between the read and the rename), it
 * is put back by a hard link, which fails when the lock was claimed again meanwhile, so that no
 * claim is overwritten. On a file system without hard links the file is renamed back instead, when
 * nothing is in the way; a process that claims the lock between that check and the rename loses its
 * claim, a narrow window that only such file systems have. Between the move and the putting back no
 * lock file exists, so a process that claims it in that moment keeps its claim and the moved owner
 * loses its lock; a plain read followed by a removal left that open for the whole gap between the
 * two. Never fails.
 */
const breakIfStale = <E, R>(file: string, authorize: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const owner = yield* readOwner(file)
    const stale = owner
      ? !(yield* processAlive(owner.pid))
      : (yield* Clock.currentTimeMillis) -
          (yield* io(file, () => stat(file)).pipe(
            Effect.map((item) => item.mtimeMs),
            Effect.orElseSucceed(() => 0),
          )) >
        UNREADABLE_STALE_MS
    if (!stale) return
    yield* authorize
    const taken = `${file}.stale-${crypto.randomUUID()}`
    const moved = yield* io(file, () => rename(file, taken)).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (!moved) return
    const claimedMeanwhile = (yield* readOwner(taken))?.token !== owner?.token
    if (claimedMeanwhile) yield* putBack(taken, file)
    yield* io(taken, () => rm(taken, { force: true }))
  }).pipe(Effect.catchTag("StateIo", () => Effect.void))

/**
 * Codes a create-exclusive open can fail with, besides EEXIST, while a lock file is in the way. On
 * Windows a file that was removed while another process still has it open (a contender reading the
 * owner, as `breakIfStale` does) lingers as delete-pending, and creating it again fails with EPERM,
 * or EACCES or EBUSY, until the last handle closes.
 */
const BLOCKED_CODES = ["EPERM", "EACCES", "EBUSY"] as const

/**
 * Opens the lock file for writing, which must not exist yet. A file in the way, even a
 * delete-pending one that fails with {@link BLOCKED_CODES}, is StateLocked, so the contender waits
 * and tries again. A refusal with no file in the way is a real I/O failure, after one more try,
 * since the file may have vanished between the open and the check.
 */
const create = (
  file: string,
  retry: boolean = true,
): Effect.Effect<FileHandle, StateLocked | StateIo> =>
  Effect.tryPromise({ try: () => open(file, "wx"), catch: (cause) => cause }).pipe(
    Effect.catch((cause) => {
      if (hasCode(cause, "EEXIST")) return Effect.fail(new StateLocked({ lockFile: file }))
      if (!BLOCKED_CODES.some((code) => hasCode(cause, code)))
        return Effect.fail(new StateIo({ path: file, cause }))
      return inTheWay(file).pipe(
        Effect.flatMap((present): Effect.Effect<FileHandle, StateLocked | StateIo> =>
          present
            ? Effect.fail(new StateLocked({ lockFile: file }))
            : retry
              ? create(file, false)
              : Effect.fail(new StateIo({ path: file, cause })),
        ),
      )
    }),
  )

/** Creates the lock file, which must not exist yet. Resolves to the owner's token. */
const claim = <E, R>(file: string, authorize: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const owner: LockOwner = {
      pid: process.pid,
      token: crypto.randomUUID(),
      acquiredAt: yield* Clock.currentTimeMillis,
    }
    const content = yield* encodeJson(LockOwner, owner).pipe(Effect.orDie)
    yield* authorize
    const handle = yield* create(file)
    // An empty lock would look unreadable until it ages out, so a failed write removes it.
    yield* io(file, () => handle.writeFile(content)).pipe(
      Effect.tapError(() => io(file, () => rm(file, { force: true })).pipe(Effect.ignore)),
      Effect.ensuring(io(file, () => handle.close()).pipe(Effect.ignore)),
    )
    return owner.token
  })

/**
 * How long a contender waits for a lock: a holder that commits to git keeps it for a while
 * (`"short"`), and one that checks out a large repository for longer (`"long"`). A plugin hook,
 * which the host kills after 10 seconds, passes a {@link Deadline} instead, shared by every lock it
 * takes, so that it fails cleanly with StateLocked in time.
 */
export type Patience = "short" | "long" | Deadline

/**
 * The moment, in epoch milliseconds, after which a contender stops waiting. One deadline is passed
 * to every lock a caller takes, so the waits add up to the deadline and not to a limit for each.
 */
export interface Deadline {
  readonly until: number
}

/**
 * How long a plugin hook waits for all its locks together, in milliseconds. The host kills a hook
 * after 10 seconds (`hooks.json`), and the hook has its own work to do besides waiting, so half of
 * that is spent at most.
 */
export const HOOK_WAIT_MS = 5_000

/** A {@link Deadline} `ms` milliseconds from now. */
export const deadlineIn = (ms: number) =>
  Effect.map(Clock.currentTimeMillis, (now): Deadline => ({ until: now + ms }))

/**
 * The patience of a caller whose lock is held across a git commit, which takes a while on Windows
 * or in a large tree: the state lock, and the migration that takes it. One definition, so that the
 * callers that default to it stay in step.
 */
export const STATE_PATIENCE: Patience = "short"

/**
 * The patience of a caller whose lock is held by work as slow as a checkout of a large repository
 * (the worktree lock) or left behind by a holder that died (the exclude lock).
 */
export const WORKTREE_PATIENCE: Patience = "long"

/**
 * Each named patience polls every `delay` milliseconds for at most `limit` milliseconds. With
 * `stuck`, a lock that a live process took longer ago than the limit is respected at once: its
 * holder is stuck, not busy, and a contender that waited on it would only wait the whole limit.
 */
const WAITS = {
  short: { delay: 25, limit: 30_000, stuck: true },
  long: { delay: 50, limit: 60_000, stuck: false },
} as const

/** A deadline polls like `short`, and takes a lock held for longer than the hook's wait as stuck. */
const DEADLINE_WAIT = { delay: 25, limit: HOOK_WAIT_MS, stuck: true } as const

/** True unless the lock was taken by a live process more than `limit` milliseconds ago. */
const holderBusy = (file: string, limit: number) =>
  Effect.gen(function* () {
    const owner = yield* readOwner(file)
    return owner === undefined || (yield* Clock.currentTimeMillis) - owner.acquiredAt < limit
  })

const acquire = <E, R>(file: string, patience: Patience, authorize: Effect.Effect<void, E, R>) => {
  const named = typeof patience === "string"
  const { delay, limit, stuck } = named ? WAITS[patience] : DEADLINE_WAIT
  return authorize.pipe(
    Effect.andThen(claim(file, authorize)),
    Effect.catchTag("StateLocked", (locked) =>
      authorize.pipe(
        Effect.andThen(breakIfStale(file, authorize)),
        Effect.andThen(Effect.fail(locked)),
      ),
    ),
    Effect.retry({
      schedule: Schedule.spaced(delay),
      ...(named ? { times: limit / delay } : {}),
      while: (error) =>
        Effect.gen(function* () {
          if (!(error instanceof StateLocked)) return false
          if (!named && (yield* Clock.currentTimeMillis) >= patience.until) return false
          return stuck ? yield* holderBusy(file, limit) : true
        }),
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
 * a minute with `"long"` for a holder that does slow work, or until a {@link Deadline} for a caller
 * under a hook timeout, which shares it among all its locks. With `"short"` and a deadline, a lock
 * a live process has held longer than the limit (the whole wait for a deadline) fails at once,
 * since its holder is stuck; `"long"` never does and waits the whole limit. The folder of the file
 * is made when it is missing.
 */
export const withFileLock = <A, E, R, F = never, G = never>(
  file: string,
  use: Effect.Effect<A, E, R>,
  patience: Patience = STATE_PATIENCE,
  authorize: Effect.Effect<void, F, G> = Effect.void,
) =>
  Effect.acquireUseRelease(
    authorize.pipe(
      Effect.andThen(io(file, () => mkdir(dirname(file), { recursive: true }))),
      Effect.andThen(acquire(file, patience, authorize)),
    ),
    () => use,
    (token) => release(file, token),
  )

/**
 * Runs `use` while holding the state lock (`local/lock` of the state folder), so two processes
 * never interleave their reads and writes. `patience` is as for {@link withFileLock}.
 */
export const withStateLock = <A, E, R, F = never>(
  directory: string,
  use: Effect.Effect<A, E, R>,
  patience: Patience = STATE_PATIENCE,
  authorize: Effect.Effect<void, F> = Effect.void,
) =>
  Effect.acquireUseRelease(
    ensureLocalDirectory(directory, authorize).pipe(
      Effect.andThen(acquire(localFile(directory, "lock"), patience, authorize)),
    ),
    () => use,
    (token) => release(localFile(directory, "lock"), token),
  )
