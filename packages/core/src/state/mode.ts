import { Effect, Schema } from "effect"

import { StateIo } from "./errors.ts"

/**
 * Where a clone keeps its Intent, Assignment and state records: `branch` on a branch of its own in
 * one shared worktree (for projects whose PRs stack), `work` in the work tree's `.holyagent/`,
 * committed with the work, or `local` in the same folder, kept out of git.
 */
export const StateMode = Schema.Literals(["branch", "work", "local"])
/** Where a clone keeps its state records. */
export type StateMode = typeof StateMode.Type

/** The mode of a clone that chose none, which keeps every earlier clone working as it did. */
export const DEFAULT_STATE_MODE: StateMode = "branch"

/**
 * The git config key that holds the mode. Only git config does: the files of the repository are
 * content another person may have written, and a mode they name would decide where the commands
 * write and what they commit.
 */
export const STATE_MODE_KEY = "holyagent.stateMode"

/** Reads the text of the config key (absent or blank is the default) as a mode. */
export const parseStateMode = (value: string | undefined) =>
  value === undefined || value.trim() === ""
    ? Effect.succeed(DEFAULT_STATE_MODE)
    : Schema.decodeUnknownEffect(StateMode)(value.trim()).pipe(
        Effect.mapError(
          () =>
            new StateIo({
              path: STATE_MODE_KEY,
              cause: `"${value.trim()}" is not a state mode; set ${STATE_MODE_KEY} in git config to branch, work or local`,
            }),
        ),
      )
