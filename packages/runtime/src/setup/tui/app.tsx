import { RGBA } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import {
  type Command,
  type Context,
  type Control,
  controlAt,
  finished,
  initialState,
  type Key,
  type Line,
  press,
  pressControl,
  reviewed,
  reviewFailed,
  rowsOf,
  scrollOf,
  type State,
  view,
} from "./model.ts"
import { type Background, BOLD_TONES, lookFor, paletteOf } from "./theme.ts"
import type { TuiInput, TuiOutcome } from "./types.ts"

/** The props of {@link SetupApp}. */
export interface SetupAppProps {
  readonly input: TuiInput
  /** The terminal's background, which picks the palette; dark when it is not known. */
  readonly background?: Background
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
  const look = lookFor(props.input.env, props.background)
  const palette = paletteOf(look)
  const [state, setState] = createSignal<State>(initialState(props.input.initial))
  const abort = new AbortController()
  // The renderer is destroyed (a hangup, a signal, the end of the run) with an apply possibly still
  // going: stop it, as Ctrl-C does.
  onCleanup(() => abort.abort())
  let ticket = 0
  let pointer: { x: number; y: number; state: State; control: Control } | undefined

  const context = (): Context => ({
    rows: rowsOf(props.input.offer, state()),
    offer: props.input.offer,
    dryRun: props.input.dryRun,
    width: dimensions().width,
    height: dimensions().height,
    look,
  })

  const lines = createMemo((): ReadonlyArray<Line> => view(state(), context()))

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

  const advance = (before: State, next: ReturnType<typeof press>) => {
    // Going back to the choices makes any review reply still on its way stale.
    if (next.state.screen !== before.screen && next.state.screen === "choose") ticket += 1
    setState(next.state)
    if (next.command !== undefined) run(next.command)
  }
  const keypress = (key: Key) => {
    const before = state()
    const current = context()
    advance(before, press(before, current.rows, key, scrollOf(before, current)))
  }
  useKeyboard((event) => keypress({ name: event.name, ctrl: event.ctrl }))

  // Added colour is dropped under NO_COLOR, so a segment then draws in the terminal's own
  // foreground (OpenTUI's default would be white); bold stays.
  const colorOf = (tone: Line[number]["tone"]) =>
    tone !== undefined && look.color ? palette[tone] : RGBA.defaultForeground()

  return (
    <box
      flexDirection="column"
      onMouseScroll={(event) => {
        const direction = event.scroll?.direction
        if (direction === "up" || direction === "down")
          keypress({ name: direction === "up" ? "pageup" : "pagedown", ctrl: false })
      }}>
      <For each={lines()}>
        {(line) => (
          <text
            fg={RGBA.defaultForeground()}
            onMouseDown={(event) => {
              const control = controlAt(line, event.x - (event.currentTarget?.x ?? 0))
              pointer =
                event.button === 0 && control !== undefined
                  ? { x: event.x, y: event.y, state: state(), control }
                  : undefined
            }}
            onMouseUp={(event) => {
              const down = pointer
              pointer = undefined
              const before = state()
              if (
                event.button === 0 &&
                down !== undefined &&
                down.x === event.x &&
                down.y === event.y &&
                down.state === before
              )
                advance(
                  before,
                  pressControl(before, context().rows, down.control, scrollOf(before, context())),
                )
            }}>
            {line.length === 0 ? (
              " "
            ) : (
              <For each={line as Array<Line[number]>}>
                {(part) => (
                  <Show
                    when={part.activeTab}
                    fallback={
                      <Show
                        when={part.tone !== undefined && BOLD_TONES.has(part.tone)}
                        fallback={<span style={{ fg: colorOf(part.tone) }}>{part.text}</span>}>
                        <b style={{ fg: colorOf(part.tone) }}>{part.text}</b>
                      </Show>
                    }>
                    <Show
                      when={look.color}
                      fallback={
                        <b>
                          <u>{part.text}</u>
                        </b>
                      }>
                      <b
                        style={{
                          fg: look.background === "light" ? "#e1e2e7" : "#1a1b26",
                          bg: palette.focus,
                        }}>
                        {part.text}
                      </b>
                    </Show>
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
