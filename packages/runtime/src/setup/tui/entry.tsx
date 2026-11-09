import { type CliRenderer, createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { Effect } from "effect"

import { SetupApp } from "./app.tsx"
import type { TuiInput, TuiOutcome } from "./types.ts"

/**
 * Shows the setup interface on the renderer `acquire` creates and resolves with how it ended. The
 * renderer is closed before this resolves, so the shell is back to normal when the command prints
 * its report. OpenTUI destroys the renderer itself when the terminal hangs up (SIGHUP) or the
 * process is signalled (SIGTERM, SIGINT, SIGQUIT); the interface has not ended then, so a destroyed
 * renderer ends it as `Interrupted`, or the process would wait for a screen that is gone.
 */
export const showSetup = <E,>(
  acquire: Effect.Effect<CliRenderer, E>,
  input: TuiInput,
): Effect.Effect<TuiOutcome, E> =>
  Effect.acquireUseRelease(
    acquire,
    (renderer) =>
      Effect.callback<TuiOutcome>((resume) => {
        const finish = (outcome: TuiOutcome) => resume(Effect.succeed(outcome))
        const destroyed = () => finish({ _tag: "Interrupted" })
        if (renderer.isDestroyed) return destroyed()
        renderer.once("destroy", destroyed)
        Effect.runFork(
          Effect.tryPromise(() =>
            render(() => <SetupApp input={input} done={finish} />, renderer),
          ).pipe(Effect.catch((cause) => Effect.sync(() => resume(Effect.die(cause))))),
        )
        return Effect.sync(() => renderer.off("destroy", destroyed))
      }),
    // `closed` settles once the terminal is restored; the command prints its report only after
    // that, or the report would land on the screen the renderer is about to leave.
    (renderer) =>
      Effect.sync(() => renderer.destroy()).pipe(
        Effect.andThen(Effect.tryPromise(() => renderer.closed)),
        Effect.ignore,
      ),
  )

/**
 * Shows the setup interface on the terminal of the process and resolves with how it ended. The
 * renderer is closed before this resolves, so the shell is back to normal when the command prints
 * its report; a renderer that cannot start (no native library for the platform) rejects, and the
 * command falls back to the line-based setup.
 */
export const runSetupTui = (input: TuiInput): Promise<TuiOutcome> =>
  Effect.runPromise(
    showSetup(
      Effect.tryPromise(() =>
        createCliRenderer({ exitOnCtrlC: false, useMouse: false, clearOnShutdown: true }),
      ),
      input,
    ),
  )
