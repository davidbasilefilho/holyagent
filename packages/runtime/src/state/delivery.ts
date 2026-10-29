// `open` with the `wx` flag is the atomic create-if-absent: Bun has no exclusive-create API, and
// the hooks of parallel tool calls run at the same time, so a check followed by a write could
// deliver twice.
import { mkdir, open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

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
 * the machine, which the system clears on its own, so nothing accumulates.
 */
const markers = () => join(tmpdir(), "holyagent-sessions")

const markerOf = (sessionId: string) => join(markers(), sessionId)

/** Makes the marker of a session with the given open flag; `wx` fails when it exists. */
const mark = (sessionId: string, flag: "w" | "wx") =>
  io(markers(), () => mkdir(markers(), { recursive: true })).pipe(
    Effect.andThen(
      io(markerOf(sessionId), () => open(markerOf(sessionId), flag).then((file) => file.close())),
    ),
  )

/**
 * Records that the root rules reached a session, for a caller that delivered them without asking
 * first (SessionStart). The caller checks the id with {@link isSessionId}.
 */
export const markRulesDelivered = (sessionId: string) => mark(sessionId, "w")

/**
 * Claims the delivery of the root rules to a session: true for the first caller and false for every
 * later one, even when callers race. The caller checks the id with {@link isSessionId}.
 */
export const claimRulesDelivery = (sessionId: string) =>
  mark(sessionId, "wx").pipe(
    Effect.as(true),
    // Only the marker itself existing means "already claimed"; EEXIST from the folder is a failure.
    Effect.catchIf(
      (error) => error.path === markerOf(sessionId) && hasCode(error.cause, "EEXIST"),
      () => Effect.succeed(false),
    ),
  )
