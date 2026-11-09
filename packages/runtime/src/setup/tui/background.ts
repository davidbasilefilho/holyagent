import { Effect } from "effect"

import { type Background, backgroundFromColorfgbg, colorEnabled } from "./theme.ts"

/** How long the terminal gets to answer the background query, in milliseconds. */
export const BACKGROUND_TIMEOUT_MS = 300

/** The part of a renderer that learns the terminal's background (OSC 11, as OpenTUI reports it). */
export interface BackgroundQuery {
  /**
   * Resolves with the background the terminal reported, or `null` when it does not within
   * `timeoutMs`.
   */
  readonly waitForThemeMode: (timeoutMs: number) => Promise<Background | null>
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * Finds whether the terminal's background is light or dark, defaulting to dark. `COLORFGBG` decides
 * when it names a background, with no query; otherwise the terminal is asked once (OSC 11) and
 * given `timeoutMs` to answer, and a terminal that stays silent, a failed query or a missing answer
 * is dark. Nothing is asked when colour is off, as the screen then draws in the terminal's own
 * foreground whatever the background is.
 */
export const detectBackground = (
  env: Env,
  renderer: BackgroundQuery,
  timeoutMs: number = BACKGROUND_TIMEOUT_MS,
): Effect.Effect<Background> => {
  if (!colorEnabled(env, true)) return Effect.succeed("dark")
  const named = backgroundFromColorfgbg(env)
  if (named !== undefined) return Effect.succeed(named)
  // The renderer's own wait is bounded by `timeoutMs`; the Effect timeout is a second bound for a
  // renderer that never settles.
  return Effect.tryPromise(() => renderer.waitForThemeMode(timeoutMs)).pipe(
    Effect.timeout(timeoutMs + 50),
    Effect.map((mode): Background => (mode === "light" ? "light" : "dark")),
    Effect.catch(() => Effect.succeed<Background>("dark")),
  )
}
