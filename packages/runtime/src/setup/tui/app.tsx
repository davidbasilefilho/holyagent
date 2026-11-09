import { RGBA } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { createMemo, createSignal, For, Show } from "solid-js"

import {
  type Command,
  type Context,
  finished,
  initialState,
  type Line,
  press,
  reviewed,
  reviewFailed,
  rowsOf,
  type State,
  view,
} from "./model.ts"
import { BOLD_TONES, lookFor, TERMINAL_THEME } from "./theme.ts"
import type { TuiInput, TuiOutcome } from "./types.ts"

/** The props of {@link SetupApp}. */
export interface SetupAppProps {
  readonly input: TuiInput
  /** Called once, with how the interface ended; the caller then closes the renderer. */
  readonly done: (outcome: TuiOutcome) => void
}

/**
 * Runs a promise-returning call of the command inside an Effect and reports its result or its
 * message; the one place the interface touches a promise.
 */
const settle = <A,>(
  run: () => Promise<A>,
  onResult: (result: { readonly value: A } | { readonly message: string }) => void,
) =>
  Effect.runFork(
    Effect.tryPromise({
      try: run,
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.match({
        onFailure: (message) => onResult({ message }),
        onSuccess: (value) => onResult({ value }),
      }),
    ),
  )

/**
 * The setup screen: the choose, review, applying and result screens of {@link view} in one Solid
 * component, driven by the pure transitions of `press`. A review or apply reply that comes after
 * the person moved on (back to the choices, or a newer review) is dropped.
 */
export const SetupApp = (props: SetupAppProps) => {
  const dimensions = useTerminalDimensions()
  const look = lookFor(props.input.env)
  const rows = rowsOf(props.input.offer)
  const [state, setState] = createSignal<State>(initialState(props.input.initial))
  const abort = new AbortController()
  let ticket = 0

  const lines = createMemo((): ReadonlyArray<Line> => {
    const context: Context = {
      rows,
      offer: props.input.offer,
      dryRun: props.input.dryRun,
      width: dimensions().width,
      height: dimensions().height,
      look,
    }
    return view(state(), context)
  })

  const run = (command: Command) => {
    const current = state()
    if (command === "cancel") return props.done({ _tag: "Cancelled" })
    if (command === "close") {
      const applied = current.applied
      return props.done(
        applied === undefined ? { _tag: "Cancelled" } : { _tag: "Applied", applied },
      )
    }
    if (command === "interrupt") {
      abort.abort()
      return props.done({ _tag: "Interrupted" })
    }
    ticket += 1
    const mine = ticket
    if (command === "review") {
      settle(
        () => props.input.review(current.choices),
        (result) => {
          if (mine !== ticket) return
          setState((now) =>
            "value" in result ? reviewed(now, result.value) : reviewFailed(now, result.message),
          )
        },
      )
      return
    }
    settle(
      () => props.input.apply(current.choices, abort.signal),
      (result) => {
        if (mine !== ticket) return
        setState((now) =>
          finished(
            now,
            "value" in result ? result.value : { ok: false, lines: [`! setup: ${result.message}`] },
          ),
        )
      },
    )
  }

  useKeyboard((event) => {
    // A key that goes back to the choices makes any review reply still on its way stale.
    const before = state()
    const next = press(before, rows, { name: event.name, ctrl: event.ctrl })
    if (next.state.screen !== before.screen && next.state.screen === "choose") ticket += 1
    setState(next.state)
    if (next.command !== undefined) run(next.command)
  })

  // Added colour is dropped under NO_COLOR, so a segment then draws in the terminal's own
  // foreground (OpenTUI's default would be white); bold stays.
  const colorOf = (tone: Line[number]["tone"]) =>
    tone !== undefined && look.color ? TERMINAL_THEME[tone] : RGBA.defaultForeground()

  return (
    <box flexDirection="column">
      <For each={lines()}>
        {(line) => (
          <text fg={RGBA.defaultForeground()}>
            {line.length === 0 ? (
              " "
            ) : (
              <For each={line as Array<Line[number]>}>
                {(part) => (
                  <Show
                    when={part.tone !== undefined && BOLD_TONES.has(part.tone)}
                    fallback={<span style={{ fg: colorOf(part.tone) }}>{part.text}</span>}>
                    <b style={{ fg: colorOf(part.tone) }}>{part.text}</b>
                  </Show>
                )}
              </For>
            )}
          </text>
        )}
      </For>
    </box>
  )
}
