import { cells, clip, clipStart, pad, wrap, wrapItems } from "./text.ts"
import { glyphs, type Look, type Tone } from "./theme.ts"
import type { Applied, Choices, Offer, Review, ReviewLine } from "./types.ts"

/** One run of text in one tone; the screen draws it as a span. */
export interface Segment {
  readonly text: string
  readonly tone?: Tone
}

/** One screen line. */
export type Line = ReadonlyArray<Segment>

/** A row of the choose screen. */
export type RowId = "pi" | "deviceAccess" | "worktrees"

/** The screens, in the order a run goes through them. */
export type Screen = "choose" | "review" | "applying" | "done"

/** What the screens show and the keys change; every transition below is a pure function of it. */
export interface State {
  readonly screen: Screen
  /** The focused row of the choose screen, an index into the rows. */
  readonly focus: number
  /** The focused action of the review screen, an index into {@link reviewActions}. */
  readonly action: number
  readonly choices: Choices
  /** The review for the current choices; `undefined` while it is being read. */
  readonly review: Review | undefined
  /** Why the review could not be read. */
  readonly failure: string | undefined
  readonly applied: Applied | undefined
}

/** What a key asks the screen to do beside changing the state. */
export type Command = "review" | "apply" | "cancel" | "interrupt" | "close"

/** A key press, reduced to what the screens read. */
export interface Key {
  readonly name: string
  readonly ctrl: boolean
}

/** An action of the review screen. */
export type ReviewAction = "apply" | "back" | "cancel"

const LABELS: Readonly<Record<RowId, string>> = {
  pi: "Pi provider",
  deviceAccess: "Agent device access",
  worktrees: "New threads in worktrees",
}

/** The rows the machine allows: the Pi provider, the device row only with a host, worktrees. */
export const rowsOf = (offer: Offer): ReadonlyArray<RowId> => [
  "pi",
  ...(offer.device === undefined ? [] : (["deviceAccess"] as const)),
  ...(offer.worktrees ? (["worktrees"] as const) : []),
]

/** The state a run starts in. */
export const initialState = (choices: Choices): State => ({
  screen: "choose",
  focus: 0,
  action: 0,
  choices,
  review: undefined,
  failure: undefined,
  applied: undefined,
})

/** The actions the review screen offers: Apply only once the review was read. */
export const reviewActions = (state: State): ReadonlyArray<ReviewAction> =>
  state.review === undefined ? ["back", "cancel"] : ["apply", "back", "cancel"]

const isCancel = (key: Key) => key.name === "escape" || (key.ctrl && key.name === "c")
const isQuit = (key: Key) => isCancel(key) || (!key.ctrl && key.name === "q")
const isEnter = (key: Key) => key.name === "return" || key.name === "enter"
const stepOf = (key: Key): -1 | 1 | 0 =>
  key.ctrl
    ? 0
    : key.name === "up" || key.name === "k"
      ? -1
      : key.name === "down" || key.name === "j"
        ? 1
        : 0

const wrapped = (index: number, step: number, length: number) =>
  (((index + step) % length) + length) % length

const toggled = (choices: Choices, row: RowId): Choices =>
  row === "deviceAccess"
    ? { ...choices, deviceAccess: !choices.deviceAccess }
    : row === "worktrees"
      ? { ...choices, worktrees: !choices.worktrees }
      : choices

/** The state after a key, and the command the key asks for, if any. */
export const press = (
  state: State,
  rows: ReadonlyArray<RowId>,
  key: Key,
): { readonly state: State; readonly command?: Command } => {
  if (state.screen === "choose") {
    if (isQuit(key)) return { state, command: "cancel" }
    const step = stepOf(key)
    if (step !== 0) return { state: { ...state, focus: wrapped(state.focus, step, rows.length) } }
    if (!key.ctrl && key.name === "space") {
      const row = rows[state.focus]
      return row === undefined
        ? { state }
        : { state: { ...state, choices: toggled(state.choices, row) } }
    }
    if (isEnter(key))
      return {
        state: { ...state, screen: "review", action: 0, review: undefined, failure: undefined },
        command: "review",
      }
    return { state }
  }
  if (state.screen === "review") {
    if (isQuit(key)) return { state, command: "cancel" }
    const actions = reviewActions(state)
    const step = stepOf(key)
    if (step !== 0)
      return { state: { ...state, action: wrapped(state.action, step, actions.length) } }
    if (isEnter(key)) {
      const action = actions[state.action]
      if (action === "apply") return { state: { ...state, screen: "applying" }, command: "apply" }
      if (action === "back")
        return { state: { ...state, screen: "choose", review: undefined, failure: undefined } }
      return { state, command: "cancel" }
    }
    return { state }
  }
  if (state.screen === "applying")
    return key.ctrl && key.name === "c" ? { state, command: "interrupt" } : { state }
  return isQuit(key) || isEnter(key) || key.name === "space"
    ? { state, command: "close" }
    : { state }
}

/** The state once the review of the current choices was read. */
export const reviewed = (state: State, review: Review): State =>
  state.screen === "review" ? { ...state, review, failure: undefined, action: 0 } : state

/** The state once the review could not be read: the screen offers Back and Cancel only. */
export const reviewFailed = (state: State, failure: string): State =>
  state.screen === "review" ? { ...state, review: undefined, failure, action: 0 } : state

/** The state once the apply finished. */
export const finished = (state: State, applied: Applied): State => ({
  ...state,
  screen: "done",
  applied,
})

/** What the screen draws in: the rows, the facts the text names, and the room there is. */
export interface Context {
  readonly rows: ReadonlyArray<RowId>
  readonly offer: Offer
  readonly dryRun: boolean
  readonly width: number
  readonly height: number
  readonly look: Look
}

const KEY_GAP = "   "

const segment = (text: string, tone?: Tone): Segment =>
  tone === undefined ? { text } : { text, tone }

const title = (look: Look): Line => [segment(`HolyAgent  ${glyphs(look).dot}  setup`, "heading")]

const keyLines = (items: ReadonlyArray<string>, width: number): ReadonlyArray<Line> =>
  wrapItems(items, width, KEY_GAP).map((text) => [segment(text, "option")])

const heading = (text: string): Line => [segment(text.toUpperCase(), "heading")]

const blank: Line = []

const hintLines = (text: string, width: number): ReadonlyArray<Line> =>
  wrap(text, width).map((part) => [segment(part, "hint")])

const hintOf = (row: RowId, offer: Offer): string =>
  row === "pi"
    ? "Pi runs in T3 Code as its own provider; it stays on while pi.enable is true, so there is nothing to choose."
    : row === "deviceAccess"
      ? `Lets agents use the iOS simulator or an Android emulator. Found: ${offer.device ?? "no device host"}.`
      : "New T3 Code threads start in their own git worktree instead of the local checkout."

const checkbox = (row: RowId, choices: Choices): { box: string; word: string } =>
  row === "pi"
    ? { box: "[x]", word: "fixed" }
    : (row === "deviceAccess" ? choices.deviceAccess : choices.worktrees)
      ? { box: "[x]", word: "enabled" }
      : { box: "[ ]", word: "disabled" }

const chooseLines = (state: State, context: Context): ReadonlyArray<Line> => {
  const { rows, offer, width, look } = context
  const g = glyphs(look)
  const values = rows.map((row) => {
    const { box, word } = checkbox(row, state.choices)
    return `${box} ${word}`
  })
  const valueWidth = Math.max(...values.map(cells))
  const labelWidth = Math.min(
    Math.max(...rows.map((row) => cells(LABELS[row]))),
    Math.max(4, width - 2 - 2 - valueWidth),
  )
  const body = rows.map((row, index): Line => {
    const focused = index === state.focus
    const label = pad(clip(LABELS[row], labelWidth, g.ellipsis), labelWidth)
    const value = values[index] ?? ""
    if (focused) return [segment(`${g.focus} ${label}  ${value}`, "focus")]
    return [
      segment(`  ${label}  `, "argument"),
      segment(
        value,
        row === "pi"
          ? "hint"
          : (row === "deviceAccess" ? state.choices.deviceAccess : state.choices.worktrees)
            ? "enabled"
            : "disabled",
      ),
    ]
  })
  const focused = rows[state.focus]
  return [
    ...keyLines([`${g.arrows} focus`, "Space toggle", "Enter review", "Esc cancel"], width),
    blank,
    heading("T3 Code"),
    ...body,
    blank,
    ...(focused === undefined ? [] : hintLines(hintOf(focused, offer), width)),
  ]
}

const MARK_TONES: Readonly<Record<ReviewLine["mark"], Tone>> = {
  "+": "success",
  "=": "hint",
  "~": "warning",
  "-": "hint",
}

/** The least width a review line's detail gets; narrower, the detail is left out. */
const MIN_DETAIL = 12

const reviewLine = (line: ReviewLine, nameWidth: number, width: number, ellipsis: string): Line => {
  const head = `  ${line.mark} ${pad(line.name, nameWidth)}  `
  const room = width - cells(head)
  // A detail with less room than this says nothing; the mark and the name carry the line.
  const detail = room >= MIN_DETAIL ? clip(line.detail, room, ellipsis) : ""
  return [
    segment(`  ${line.mark} `, MARK_TONES[line.mark]),
    segment(pad(line.name, nameWidth), "argument"),
    ...(detail === "" ? [] : [segment(`  ${detail}`, "hint")]),
  ]
}

const reviewLines = (state: State, context: Context): ReadonlyArray<Line> => {
  const { width, look } = context
  const g = glyphs(look)
  const top: ReadonlyArray<Line> = [
    ...keyLines([`${g.arrows} focus`, "Enter select", "Esc cancel"], width),
    blank,
    heading(context.dryRun ? "Review (dry run, nothing is written)" : "Review"),
  ]
  const actionLines = (): ReadonlyArray<Line> =>
    reviewActions(state).map((action, index): Line => {
      const text =
        action === "apply"
          ? context.dryRun
            ? "Apply (dry run)"
            : "Apply"
          : action === "back"
            ? "Back"
            : "Cancel"
      if (index === state.action) return [segment(`${g.focus} ${text}`, "focus")]
      const tone: Tone = action === "apply" ? "enabled" : action === "cancel" ? "error" : "argument"
      return [segment(`  ${text}`, tone)]
    })
  if (state.failure !== undefined) {
    return [
      ...top,
      ...wrap(state.failure, width - 2).map((part): Line => [segment(`  ${part}`, "error")]),
      blank,
      ...actionLines(),
    ]
  }
  if (state.review === undefined) {
    return [...top, [segment("  Reading what will change", "hint")], blank, ...actionLines()]
  }
  const { review } = state
  const nameWidth = Math.max(
    ...[...review.choices, ...review.always].map((line) => cells(line.name)),
  )
  const make = (shown: number): ReadonlyArray<Line> => {
    const more = review.always.length - shown
    return [
      ...top,
      [segment(`  ${clipStart(review.file, width - 2, g.ellipsis)}`, "hint")],
      blank,
      heading("Your choices"),
      ...review.choices.map((line) => reviewLine(line, nameWidth, width, g.ellipsis)),
      blank,
      heading("Always applied"),
      ...review.always
        .slice(0, shown)
        .map((line) => reviewLine(line, nameWidth, width, g.ellipsis)),
      ...(more > 0 ? [[segment(`  ${g.ellipsis} ${more} more`, "hint")] as Line] : []),
      blank,
      ...actionLines(),
    ]
  }
  // As many always-applied lines as fit under the title; the rest become a count.
  let shown = review.always.length
  while (shown > 0 && 1 + make(shown).length > context.height) shown -= 1
  return make(shown)
}

const reportTone = (line: string): Tone =>
  line.startsWith("+ ")
    ? "success"
    : line.startsWith("! ")
      ? "error"
      : line.startsWith("~ ")
        ? "warning"
        : "hint"

const doneLines = (state: State, context: Context): ReadonlyArray<Line> => {
  const { width, height, look } = context
  const g = glyphs(look)
  const applied = state.applied
  const lines = applied?.lines ?? []
  const make = (shown: number): ReadonlyArray<Line> => {
    const more = lines.length - shown
    return [
      ...keyLines(["Enter close", "Esc close"], width),
      blank,
      heading(context.dryRun ? "Result (dry run)" : "Result"),
      applied?.ok === false
        ? [segment("Setup finished with failures; the lines marked ! failed.", "error")]
        : [segment("Setup finished.", "success")],
      blank,
      ...lines
        .slice(0, shown)
        .map((line): Line => [segment(clip(line, width, g.ellipsis), reportTone(line))]),
      ...(more > 0
        ? [[segment(`${g.ellipsis} ${more} more, printed after you close`, "hint")] as Line]
        : []),
    ]
  }
  let shown = lines.length
  while (shown > 0 && 1 + make(shown).length > height) shown -= 1
  return make(shown)
}

/** Cuts a line to `width` cells, segment by segment, ending in `ellipsis` when it was cut. */
const fitLine = (line: Line, width: number, ellipsis: string): Line => {
  const total = line.reduce((sum, { text }) => sum + cells(text), 0)
  if (total <= width) return line
  const kept: Array<Segment> = []
  let used = 0
  for (const part of line) {
    const room = width - used
    if (room <= 0) break
    const size = cells(part.text)
    if (size <= room) {
      kept.push(part)
      used += size
      continue
    }
    kept.push({ ...part, text: clip(part.text, room, ellipsis) })
    break
  }
  return kept
}

/** The lines of the screen the state is on, every one cut to the width. */
export const view = (state: State, context: Context): ReadonlyArray<Line> => {
  const body =
    state.screen === "choose"
      ? chooseLines(state, context)
      : state.screen === "review"
        ? reviewLines(state, context)
        : state.screen === "applying"
          ? [
              [segment("Press Ctrl-C to stop", "option")] as Line,
              blank,
              heading("Applying"),
              [segment("Applying setup; this can take a moment.", "argument")] as Line,
            ]
          : doneLines(state, context)
  return [title(context.look), ...body].map((line) =>
    fitLine(line, context.width, glyphs(context.look).ellipsis),
  )
}
