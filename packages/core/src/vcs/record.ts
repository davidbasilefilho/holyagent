import { Clock, Effect } from "effect"

import { resolveIntent, type Unauthorized } from "../api/context.ts"
import type { Snapshot, StateChange, updateState } from "../state/store.ts"

/** Trusted state adapter used to record a completed VCS operation. */
export type VcsState = {
  readonly directory: string
  /** Optional host-provided state reader; absent uses the normal state store. */
  readonly read?: () => ReturnType<typeof readOpenState>
  readonly update: <A extends StateChange, E>(
    transition: (snapshot: Snapshot) => Effect.Effect<A, E>,
  ) => ReturnType<typeof updateState<A, E | Unauthorized>>
}
const nowIso = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()))
const describeFailure = (error: unknown) => ({
  message: String(
    typeof error === "object" && error !== null && "message" in error ? error.message : error,
  )
    .replace(/\s+/g, " ")
    .trim(),
})
import { newId } from "../domain/ids.ts"
import { linkBranch, linkPull } from "../domain/links.ts"
import { readOpenState } from "../state/store.ts"

/**
 * What recording a step on the Intent in use came to: the Intent that now holds the record, a
 * reason it could not be recorded (the step itself had already happened), or nothing when no Intent
 * is in use.
 */
export type Recorded =
  { readonly intent: string } | { readonly unrecorded: string } | Record<never, never>

/**
 * Runs a recorder against the Intent in use and folds its failure into the result. Nothing is
 * written when the project has no Intent to attach to, so a repository that does not use holyagent
 * state is left alone.
 */
const onIntentInUse = (
  call: Pick<VcsState, "directory" | "read">,
  record: (intent: string) => Effect.Effect<string, unknown>,
): Effect.Effect<Recorded> =>
  (call.read === undefined ? readOpenState(call.directory) : call.read()).pipe(
    Effect.flatMap(resolveIntent),
    Effect.map(({ id }): string | undefined => id),
    Effect.catchTag("NoActiveIntent", () => Effect.succeed(undefined)),
    Effect.flatMap((id) =>
      id === undefined
        ? Effect.succeed<Recorded>({})
        : record(id).pipe(Effect.map((intent): Recorded => ({ intent }))),
    ),
    Effect.catch((error) =>
      Effect.succeed<Recorded>({ unrecorded: describeFailure(error).message }),
    ),
  )

/** Records the branch a commit went on, and its commit, on the Intent in use. */
export const recordBranch = (
  call: VcsState,
  commit: { readonly branch: string; readonly commit: string },
) =>
  onIntentInUse(call, (intentId) =>
    Effect.gen(function* () {
      const id = yield* newId("branch")
      const committedAt = yield* nowIso
      yield* call.update((snapshot) =>
        linkBranch(snapshot.project, {
          id,
          intentId,
          branch: commit.branch,
          commit: commit.commit,
          committedAt,
        }),
      )
      return intentId
    }),
  )

/** Records the pull request `vcs pr` created or updated on the Intent in use. */
export const recordPull = (
  call: VcsState,
  pull: {
    readonly number: number
    readonly url: string
    readonly branch: string
    readonly base: string | undefined
    readonly created: boolean
  },
) =>
  onIntentInUse(call, (intentId) =>
    Effect.gen(function* () {
      const id = yield* newId("pull")
      const recordedAt = yield* nowIso
      yield* call.update((snapshot) =>
        linkPull(snapshot.project, {
          id,
          intentId,
          number: pull.number,
          url: pull.url,
          branch: pull.branch,
          ...(pull.base === undefined ? {} : { base: pull.base }),
          created: pull.created,
          recordedAt,
        }),
      )
      return intentId
    }),
  )
