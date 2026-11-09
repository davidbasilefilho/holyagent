import { stat } from "node:fs/promises"

import { Effect } from "effect"

import { hasCode, io } from "../state/files.ts"

/**
 * Whether the project has a `.holyagent` state folder at `directory`; a missing folder is false,
 * not a failure. The Claude `session-start` hook and the Pi extension share this check.
 */
export const hasStateFolder = (directory: string) =>
  io(directory, () => stat(directory)).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => hasCode(error.cause, "ENOENT"),
      () => Effect.succeed(false),
    ),
  )
