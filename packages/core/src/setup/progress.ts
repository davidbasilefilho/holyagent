import { Context, Effect } from "effect"

/** The active phase of one harness's plan and, when available, its current operation. */
export interface SetupProgressUpdate {
  readonly index: number
  readonly total: number
  readonly label: string
  readonly activity?: string
}

/** Optional in-process observer for setup progress; headless setup needs no observer. */
export const SetupProgress = Context.Reference<((update: SetupProgressUpdate) => void) | undefined>(
  "holyagent/setup/SetupProgress",
  { defaultValue: () => undefined },
)

const SetupActivity = Context.Reference<((activity: string) => void) | undefined>(
  "holyagent/setup/SetupActivity",
  { defaultValue: () => undefined },
)

/** Runs a phase with an observer for the actual operations it starts. */
export const withSetupPhase = <A, E, R>(
  phase: Omit<SetupProgressUpdate, "activity">,
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(SetupProgress, (report) =>
    report === undefined
      ? run
      : Effect.sync(() => report(phase)).pipe(
          Effect.andThen(
            Effect.provideService(run, SetupActivity, (activity) => report({ ...phase, activity })),
          ),
        ),
  )

/** Reports the operation about to execute, without changing setup's result or shell output. */
export const reportSetupActivity = (activity: string): Effect.Effect<void> =>
  Effect.flatMap(SetupActivity, (report) => Effect.sync(() => report?.(activity)))
