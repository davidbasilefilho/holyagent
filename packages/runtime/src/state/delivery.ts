// `open` with the `wx` flag is the atomic create-if-absent: Bun has no exclusive-create API, and
// the hooks of parallel tool calls run at the same time, so a check followed by a write could
// deliver twice.
import { lstat, mkdir, open } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { StateIo } from "./errors.ts"
import { hasCode, io } from "./files.ts"

/** Ids the host makes are UUIDs or short words; anything else is not turned into a file name. */
const SAFE_SESSION = /^[\w.-]{1,80}$/

/**
 * True when the id is safe to use as the name of a marker file: word characters, dots and dashes,
 * and not a dot-only name such as `..`.
 */
export const isSessionId = (id: string | undefined): id is string =>
  id !== undefined && SAFE_SESSION.test(id) && !/^\.+$/.test(id)

/**
 * Where the markers live: outside every repository and state worktree, in the temporary folder of
 * the machine, which the system clears on its own, so nothing accumulates. The folder is per user,
 * because the temporary folder is shared on many hosts and another account must not be able to
 * create, own or lock the folder this one writes to.
 */
const markers = () =>
  join(
    tmpdir(),
    `holyagent-sessions-${(process.getuid?.() ?? userInfo().username).toString().replace(/[^\w.-]/g, "_")}`,
  )

const markerOf = (sessionId: string) => join(markers(), sessionId)

/**
 * Makes the marker folder private (mode 0700) when it is absent and checks, without following a
 * link, that it is a real directory owned by this user and closed to others. Anything else is an
 * error, so no marker is written into a folder another account controls. Where the system has no
 * user ids or modes (Windows), only the real-directory check applies.
 */
const ensureMarkers = () => {
  const folder = markers()
  const uid = process.getuid?.()
  return io(folder, () => mkdir(folder, { recursive: true, mode: 0o700 })).pipe(
    Effect.andThen(io(folder, () => lstat(folder))),
    Effect.filterOrFail(
      (found) =>
        found.isDirectory() &&
        (uid === undefined || (found.uid === uid && (found.mode & 0o022) === 0)),
      () =>
        new StateIo({
          path: folder,
          cause: new Error("not a private directory owned by the current user"),
        }),
    ),
  )
}

/**
 * Makes the marker of a session with the exclusive-create flag, which never follows a link: true
 * when this call made it and false when it already existed. The caller checks the id with
 * {@link isSessionId}.
 */
const create = (sessionId: string) =>
  ensureMarkers().pipe(
    Effect.andThen(
      io(markerOf(sessionId), () => open(markerOf(sessionId), "wx").then((file) => file.close())),
    ),
    Effect.as(true),
    // Only the marker itself existing means "already there"; EEXIST from the folder is a failure.
    Effect.catchIf(
      (error) => error.path === markerOf(sessionId) && hasCode(error.cause, "EEXIST"),
      () => Effect.succeed(false),
    ),
  )

/**
 * Records that the root rules reached a session, for a caller that delivered them without asking
 * first (SessionStart). A marker that exists already is the goal reached. The caller checks the id
 * with {@link isSessionId}.
 */
export const markRulesDelivered = (sessionId: string) => create(sessionId).pipe(Effect.asVoid)

/**
 * Claims the delivery of the root rules to a session: true for the first caller and false for every
 * later one, even when callers race. Fails when the marker folder is unusable. The caller checks
 * the id with {@link isSessionId}.
 */
export const claimRulesDelivery = create
