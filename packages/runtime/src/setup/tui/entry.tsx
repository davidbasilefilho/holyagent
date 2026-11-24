import { type CliRenderer, createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { Effect } from "effect"

import { SetupApp } from "./app.tsx"
import { detectBackground } from "./background.ts"
import type { TuiInput, TuiOutcome } from "./types.ts"

/**
 * Shows the setup interface on the renderer `acquire` creates and resolves with how it ended. The
 * renderer is closed before this resolves, so the shell is back to normal when the command prints
 * its report. OpenTUI destroys the renderer itself when the terminal hangs up (SIGHUP) or the
 * process is signalled (SIGTERM, SIGINT, SIGQUIT); the interface has not ended then, so a destroyed
 * renderer ends it as `Interrupted`, or the process would wait for a screen that is gone. The first
 * screen waits for {@link detectBackground}, which is bounded, to pick its palette.
 */
export const showSetup = <E,>(
  acquire: Effect.Effect<CliRenderer, E>,
  input: TuiInput,
): Effect.Effect<TuiOutcome, E> =>
  Effect.acquireUseRelease(
    acquire,
    (renderer) =>
      detectBackground(input.env, renderer).pipe(
        Effect.flatMap((background) =>
          Effect.callback<TuiOutcome>((resume) => {
            const finish = (outcome: TuiOutcome) => resume(Effect.succeed(outcome))
            const destroyed = () => finish({ _tag: "Interrupted" })
            if (renderer.isDestroyed) return destroyed()
            renderer.once("destroy", destroyed)
            Effect.runFork(
              Effect.tryPromise({
                try: () =>
                  render(
                    () => <SetupApp input={input} background={background} done={finish} />,
                    renderer,
                  ),
                catch: (cause) => cause,
              }).pipe(Effect.catch((cause) => Effect.sync(() => resume(Effect.die(cause))))),
            )
            return Effect.sync(() => renderer.off("destroy", destroyed))
          }),
        ),
      ),
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
 * its report. The promise rejects when the renderer cannot start, such as when its platform's
 * native library is missing.
 */
export const runSetupTui = (input: TuiInput): Promise<TuiOutcome> =>
  Effect.runPromise(
    showSetup(
      Effect.tryPromise({
        try: () =>
          createCliRenderer({ exitOnCtrlC: false, useMouse: false, clearOnShutdown: true }),
        catch: (cause) => cause,
      }),
      input,
    ),
  )
