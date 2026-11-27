import type { PiProvider } from "../../config/schema.ts"
import { resultHeadline, summarizeResult } from "./result.ts"
import { cells, clip, pad, wrap, wrapItems } from "./text.ts"
import { glyphs, type Look, type Tone } from "./theme.ts"
import type {
  Applied,
  BrowserOption,
  Choices,
  Offer,
  Review,
  ReviewLine,
  SetupDisplayProgress,
} from "./types.ts"

const CAPABILITY_ROW = "capability:"
const BROWSER_USE = "capability:browserUse"
type SettingsPage = "browser-use" | "codex-iab" | "codex-extension"
type SettingsOption =
  | "capability"
  | "extension-skip"
  | "back"
  | `browser:${string}`
  | `extension:${string}`

/** One run of text in one tone; the screen draws it as a span. */
export interface Segment {
  readonly text: string
  readonly tone?: Tone
  readonly activeTab?: boolean
  readonly click?: Control
}

/** One screen line. */
export type Line = ReadonlyArray<Segment>

/** A row of the choose screen: a T3 row, or `capability:<pi.features key>`. */
export type RowId =
  | `provider:${PiProvider}`
  | "deviceAccess"
  | "worktrees"
  | "enablePi"
  | "enableClaude"
  | "enableCodex"
  | "codexInAppBrowser"
  | "codexBrowserExtension"
  | `capability:${string}`

const tabs = ["pi", "claude", "codex"] as const
type Tab = (typeof tabs)[number]
const tabLabels: Record<Tab, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex" }

/** The screens, in the order a run goes through them. */
export type Screen = "choose" | "settings" | "review" | "applying" | "done"

/** What the screens show and the keys change; every transition below is a pure function of it. */
export interface State {
  readonly screen: Screen
  readonly tab: Tab
  /** The focused row of the choose screen, an index into the rows. */
  readonly focus: number
  /** The focused action of the review screen, an index into {@link reviewActions}. */
  readonly action: number
  /** The named configuration page, when one is open. The choose page keeps its row focus. */
  readonly settings?: SettingsPage
  /** The first line shown of a review or result longer than the screen; `view` clamps it. */
  readonly scroll: number
  readonly choices: Choices
  /** The review for the current choices; `undefined` while it is being read. */
  readonly review: Review | undefined
  /** Why the review could not be read. */
  readonly failure: string | undefined
  readonly applied: Applied | undefined
  readonly details: boolean
}

/** What a key asks the screen to do beside changing the state. */
export type Command = "review" | "apply" | "cancel" | "interrupt" | "close"

/** How far a long review or result scrolls: the lines one page moves and the last first line. */
export interface Scroll {
  readonly page: number
  readonly max: number
}

/** A key press, reduced to what the screens read. */
export interface Key {
  readonly name: string
  readonly ctrl: boolean
}

/** An action of the review screen. */
export type ReviewAction = "apply" | "keep-conflicts" | "replace-conflicts" | "back" | "cancel"

/** A visible control on the choose, review or result screen. */
export type Control =
  | "close"
  | "details"
  | "choose-review"
  | "choose-cancel"
  | { readonly row: RowId }
  | { readonly settingsOption: SettingsOption }
  | { readonly action: ReviewAction }
  | { readonly tab: Tab }
  | { readonly scrollTo: number }

const LABELS = {
  deviceAccess: "T3 Device Simulator",
  worktrees: "New threads in worktrees",
  enablePi: "Configure Pi",
  enableClaude: "Configure Claude Code",
  enableCodex: "Configure Codex",
  codexInAppBrowser: "Codex In-App Browser",
  codexBrowserExtension: "ChatGPT browser extension",
} as const

/** The capability a row switches, or `undefined` for a T3 row. */
const capabilityOf = (row: RowId, offer: Offer) =>
  row.startsWith(CAPABILITY_ROW)
    ? offer.capabilities.find(
        (capability) => capability.feature === row.slice(CAPABILITY_ROW.length),
      )
    : undefined

const providerName: Record<PiProvider, string> = {
  "kimi-coding-global": "Kimi for Coding (global)",
  "openai-codex": "OpenAI Codex (ChatGPT)",
}

const providerOf = (row: RowId, offer: Offer) =>
  offer.providers?.find((provider) => row === `provider:${provider}`)

const labelOf = (row: RowId, offer: Offer): string => {
  if (row === BROWSER_USE) return "browser-use"
  const provider = providerOf(row, offer)
  if (provider !== undefined) return providerName[provider]
  return row.startsWith(CAPABILITY_ROW)
    ? (capabilityOf(row, offer)?.name ?? row)
    : LABELS[row as keyof typeof LABELS]
}

/**
 * The rows the machine allows: with T3 work, the Pi provider, the device row only with a host and
 * worktrees; then one row for each capability.
 */
export const rowsOf = (offer: Offer, state?: State): ReadonlyArray<RowId> => {
  const selected = state?.choices.harnesses
  if (selected !== undefined && offer.harnesses !== undefined) {
    if (state?.tab === "codex")
      return offer.harnesses.codexHome === undefined
        ? []
        : [
            ...(offer.harnesses.onlyCodex === true ? [] : (["enableCodex"] as const)),
            ...(selected.codex !== true || offer.harnesses.codexDesktop === undefined
              ? []
              : ([
                  "codexInAppBrowser",
                  ...((offer.harnesses.codexDesktop.extensionBrowsers?.length ?? 0) > 0
                    ? (["codexBrowserExtension"] as const)
                    : []),
                ] as const)),
          ]
    if (state?.tab === "claude") return ["enableClaude"]
    if (!offer.harnesses.piAvailable) return []
    if (!selected.pi) return ["enablePi"]
  }
  return [
    ...(selected === undefined ? [] : (["enablePi"] as const)),
    ...(offer.providers ?? []).map((provider): RowId => `provider:${provider}`),
    ...(offer.t3 && offer.device !== undefined ? (["deviceAccess"] as const) : []),
    ...(offer.t3 && offer.worktrees ? (["worktrees"] as const) : []),
    ...offer.capabilities.map((capability): RowId => `${CAPABILITY_ROW}${capability.feature}`),
  ]
}

/** The state a run starts in. */
export const initialState = (choices: Choices, onlyCodex = false): State => ({
  screen: "choose",
  tab: onlyCodex ? "codex" : "pi",
  focus: 0,
  action: 0,
  scroll: 0,
  choices,
  review: undefined,
  failure: undefined,
  applied: undefined,
  details: false,
})

/** The actions the review screen offers: Apply only once the review was read. */
export const reviewActions = (state: State): ReadonlyArray<ReviewAction> => {
  if (state.review === undefined) return ["back", "cancel"]
  if ((state.review.conflicts?.length ?? 0) === 0) return ["apply", "back", "cancel"]
  return [
    "apply",
    state.choices.keepManagedConflicts === true ? "replace-conflicts" : "keep-conflicts",
    "back",
    "cancel",
  ]
}

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

const toggleProvider = (choices: Choices, id: PiProvider): Choices => {
  const selection = choices.piProviders
  if (selection === undefined) return choices
  const providers = selection.providers.includes(id)
    ? selection.providers.filter((p) => p !== id)
    : [...selection.providers, id]
  return { ...choices, piProviders: { providers } }
}

const toggled = (choices: Choices, row: RowId): Choices => {
  if (row === "provider:kimi-coding-global" || row === "provider:openai-codex")
    return toggleProvider(
      choices,
      row === "provider:openai-codex" ? "openai-codex" : "kimi-coding-global",
    )
  if (
    choices.harnesses !== undefined &&
    (row === "enablePi" || row === "enableClaude" || row === "enableCodex")
  ) {
    const key = row === "enablePi" ? "pi" : row === "enableClaude" ? "claude" : "codex"
    return { ...choices, harnesses: { ...choices.harnesses, [key]: !choices.harnesses[key] } }
  }
  if (row === "deviceAccess") return { ...choices, deviceAccess: !choices.deviceAccess }
  if (row === "worktrees") return { ...choices, worktrees: !choices.worktrees }
  if (!row.startsWith(CAPABILITY_ROW) || row === BROWSER_USE) return choices
  const feature = row.slice(CAPABILITY_ROW.length)
  return {
    ...choices,
    capabilities: { ...choices.capabilities, [feature]: choices.capabilities[feature] !== true },
  }
}

const settingsFor = (row: RowId): SettingsPage | undefined => {
  if (row === BROWSER_USE) return "browser-use"
  if (row === "codexInAppBrowser") return "codex-iab"
  if (row === "codexBrowserExtension") return "codex-extension"
  return undefined
}

const browserOptions = (offer: Offer | undefined): ReadonlyArray<BrowserOption> =>
  offer?.browse?.browsers ?? []
const extensionBrowsers = (offer: Offer | undefined) =>
  offer?.harnesses?.codexDesktop?.extensionBrowsers ?? []

const browserEnabled = (choices: Choices) => choices.capabilities["browserUse"] === true

const settingsOptions = (state: State, offer: Offer | undefined): ReadonlyArray<SettingsOption> =>
  state.settings === "codex-extension"
    ? [
        ...(extensionBrowsers(offer).length === 0 ? [] : (["extension-skip"] as const)),
        ...extensionBrowsers(offer).map(({ id }): SettingsOption => `extension:${id}`),
        "back",
      ]
    : state.settings === "browser-use"
      ? [
          "capability",
          ...(browserEnabled(state.choices)
            ? browserOptions(offer).map(({ id }): SettingsOption => `browser:${id}`)
            : []),
          "back",
        ]
      : ["back"]

const settingsBack = (state: State): State => ({ ...state, screen: "choose", action: 0 })

const selectSetting = (state: State, option: SettingsOption, offer: Offer | undefined): State => {
  if (option === "back") return settingsBack(state)
  const choices = state.choices
  if (option === "extension-skip") {
    const { codexBrowserHandoff: _previous, ...kept } = choices
    return { ...state, choices: kept }
  }
  if (option.startsWith("extension:")) {
    const id = option.slice("extension:".length)
    return extensionBrowsers(offer).some((entry) => entry.id === id)
      ? { ...state, choices: { ...choices, codexBrowserHandoff: id } }
      : state
  }
  if (option.startsWith("browser:")) {
    const id = option.slice("browser:".length)
    if (!browserEnabled(choices) || !browserOptions(offer).some((entry) => entry.id === id))
      return state
    const marked = choices.browseBrowserIds ?? []
    return {
      ...state,
      choices: {
        ...choices,
        browseBrowserIds: marked.includes(id)
          ? marked.filter((entry) => entry !== id)
          : [...marked, id],
      },
    }
  }
  if (option !== "capability") return state
  const enabled = !browserEnabled(choices)
  return {
    ...state,
    choices: {
      ...choices,
      capabilities: { ...choices.capabilities, browserUse: enabled },
      browseSetup: enabled,
    },
  }
}

const pagedBy = (state: State, key: Key, scroll: Scroll): State | undefined => {
  if (key.ctrl) return undefined
  const direction = key.name === "pagedown" ? 1 : key.name === "pageup" ? -1 : 0
  if (direction === 0) return undefined
  const from = Math.min(state.scroll, scroll.max)
  return { ...state, scroll: Math.min(scroll.max, Math.max(0, from + direction * scroll.page)) }
}

/**
 * The state after a key, and the command the key asks for, if any. `scroll` (from {@link scrollOf})
 * bounds Page Up and Page Down on a review or result longer than the screen.
 */
export const press = (
  state: State,
  rows: ReadonlyArray<RowId>,
  key: Key,
  scroll: Scroll = { page: 1, max: 0 },
  offer?: Offer,
): { readonly state: State; readonly command?: Command } => {
  if (state.screen === "choose") {
    if (isQuit(key)) return { state, command: "cancel" }
    if (
      state.choices.harnesses !== undefined &&
      offer?.harnesses?.onlyCodex !== true &&
      !key.ctrl &&
      (key.name === "left" || key.name === "right")
    ) {
      const tab = tabs[wrapped(tabs.indexOf(state.tab), key.name === "left" ? -1 : 1, tabs.length)]
      return { state: { ...state, tab: tab ?? state.tab, focus: 0 } }
    }
    if (!key.ctrl && key.name === "end") return { state: { ...state, focus: rows.length } }
    const step = stepOf(key)
    if (step !== 0)
      return { state: { ...state, focus: wrapped(state.focus, step, rows.length + 1) } }
    if (isEnter(key) && !key.ctrl) {
      const row = rows[state.focus]
      if (row !== undefined) {
        const settings = settingsFor(row)
        if (settings !== undefined) {
          const opened: State = { ...state, screen: "settings", settings, action: 0 }
          const preferred: SettingsOption =
            state.choices.codexBrowserHandoff === undefined
              ? "extension-skip"
              : `extension:${state.choices.codexBrowserHandoff}`
          const focus = settingsOptions(opened, offer).indexOf(preferred)
          return { state: { ...opened, action: Math.max(0, focus) } }
        }
        return {
          state: {
            ...state,
            focus: row === "enablePi" ? 0 : state.focus,
            choices: toggled(state.choices, row),
          },
        }
      }
      return {
        state: {
          ...state,
          screen: "review",
          action: 0,
          scroll: 0,
          review: undefined,
          failure: undefined,
        },
        command: "review",
      }
    }
    return { state }
  }
  if (state.screen === "settings") {
    if (key.ctrl && key.name === "c") return { state, command: "cancel" }
    if (key.name === "escape" || (!key.ctrl && key.name === "backspace"))
      return { state: settingsBack(state) }
    const options = settingsOptions(state, offer)
    const step = stepOf(key)
    if (step !== 0)
      return { state: { ...state, action: wrapped(state.action, step, options.length) } }
    if (!key.ctrl && key.name === "end")
      return {
        state: { ...state, action: options.length - 1 },
      }
    if (!key.ctrl && isEnter(key)) {
      const option = options[state.action]
      if (option !== undefined) return { state: selectSetting(state, option, offer) }
    }
    return { state }
  }
  if (state.screen === "review") {
    if (isQuit(key)) return { state, command: "cancel" }
    const paged = pagedBy(state, key, scroll)
    if (paged !== undefined) return { state: paged }
    const actions = reviewActions(state)
    const step = stepOf(key)
    if (step !== 0)
      return { state: { ...state, action: wrapped(state.action, step, actions.length) } }
    if (isEnter(key)) {
      const action = actions[state.action]
      if (action === "apply") return { state: { ...state, screen: "applying" }, command: "apply" }
      if (action === "keep-conflicts" || action === "replace-conflicts")
        return {
          state: {
            ...state,
            action: 0,
            scroll: 0,
            review: undefined,
            failure: undefined,
            choices: { ...state.choices, keepManagedConflicts: action === "keep-conflicts" },
          },
          command: "review",
        }
      if (action === "back")
        return {
          state: { ...state, screen: "choose", scroll: 0, review: undefined, failure: undefined },
        }
      return { state, command: "cancel" }
    }
    return { state }
  }
  if (state.screen === "applying")
    return key.ctrl && key.name === "c" ? { state, command: "interrupt" } : { state }
  const paged = pagedBy(state, key, scroll)
  if (paged !== undefined) return { state: paged }
  if (!key.ctrl && key.name === "d")
    return { state: { ...state, details: !state.details, scroll: 0 } }
  return isQuit(key) || isEnter(key) ? { state, command: "close" } : { state }
}

/** Pointer controls use the same transitions and preconditions as the keyboard. */
export const pressControl = (
  state: State,
  rows: ReadonlyArray<RowId>,
  control: Control,
  scroll: Scroll = FIXED,
  offer?: Offer,
) => {
  const key = (name: string, from = state) => press(from, rows, { name, ctrl: false }, FIXED, offer)
  if (typeof control === "object") {
    if ("tab" in control)
      return state.screen === "choose" &&
        state.choices.harnesses !== undefined &&
        offer?.harnesses?.onlyCodex !== true
        ? { state: { ...state, tab: control.tab, focus: 0 } }
        : { state }
    if ("scrollTo" in control)
      return (state.screen === "review" || state.screen === "done") && scroll.max > 0
        ? { state: { ...state, scroll: Math.min(scroll.max, Math.max(0, control.scrollTo)) } }
        : { state }
    if ("settingsOption" in control) {
      const action = settingsOptions(state, offer).indexOf(control.settingsOption)
      return state.screen === "settings" && action >= 0
        ? key("enter", { ...state, action })
        : { state }
    }
    if ("row" in control) {
      const focus = rows.indexOf(control.row)
      return state.screen === "choose" && focus >= 0 ? key("enter", { ...state, focus }) : { state }
    }
    const action = reviewActions(state).indexOf(control.action)
    return state.screen === "review" && action >= 0 ? key("enter", { ...state, action }) : { state }
  }
  if (state.screen === "choose" && control === "choose-review")
    return key("enter", { ...state, focus: rows.length })
  if (state.screen === "choose" && control === "choose-cancel") return key("escape")
  if (state.screen === "done" && control === "details") return key("d")
  if (state.screen === "done" && control === "close") return key("q")
  return { state }
}

/** Hit-test only the visible cell range of a control, not the rest of its text line. */
export const controlAt = (line: Line, column: number): Control | undefined => {
  let offset = 0
  for (const part of line) {
    const end = offset + cells(part.text)
    if (column >= offset && column < end) return part.click
    offset = end
  }
  return undefined
}

/** The state once the review of the current choices was read. */
export const reviewed = (state: State, review: Review): State =>
  state.screen === "review" ? { ...state, review, failure: undefined, action: 0, scroll: 0 } : state

/** The state once the review could not be read: the screen offers Back and Cancel only. */
export const reviewFailed = (state: State, failure: string): State =>
  state.screen === "review" ? { ...state, review: undefined, failure, action: 0, scroll: 0 } : state

/** The state once the apply finished. */
export const finished = (state: State, applied: Applied): State => ({
  ...state,
  screen: "done",
  scroll: 0,
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
  readonly progress?: SetupDisplayProgress | undefined
  readonly elapsedSeconds?: number
}

const KEY_GAP = "   "

const segment = (text: string, tone?: Tone): Segment =>
  tone === undefined ? { text } : { text, tone }

const title = (look: Look): Line => [segment(`HolyAgent  ${glyphs(look).dot}  setup`, "heading")]

const keyLines = (items: ReadonlyArray<string>, width: number): ReadonlyArray<Line> =>
  wrapItems(items, width, KEY_GAP).map((text) => [segment(text, "option")])

const chooseKeys = (focus: string, width: number): ReadonlyArray<Line> =>
  wrapItems([focus, "Enter select", "Esc cancel"], width, KEY_GAP).map((line) =>
    line.split(KEY_GAP).flatMap((text, index): Line => {
      const item: Segment = {
        text,
        tone: "option",
        ...(text === "Esc cancel" ? { click: "choose-cancel" } : {}),
      }
      return index === 0 ? [item] : [segment(KEY_GAP), item]
    }),
  )

const heading = (text: string, width: number): ReadonlyArray<Line> =>
  wrap(text.toUpperCase(), width).map((part) => [segment(part, "heading")])

const blank: Line = []

const hintLines = (text: string, width: number): ReadonlyArray<Line> =>
  wrap(text, width).map((part) => [segment(part, "hint")])

const hintOf = (row: RowId, offer: Offer): string => {
  if (row === BROWSER_USE) return "Open browser-use settings."
  if (row === "enablePi") return "Include Pi and T3 Code in the combined review."
  if (row === "enableCodex")
    return "Prepare the native plugin and startup settings in a dedicated Codex home."
  if (row === "codexInAppBrowser")
    return "See where to use the built-in desktop browser without changing any settings."
  if (row === "codexBrowserExtension")
    return "Choose whether to open the official guide for your existing browser profile."
  if (row === "enableClaude")
    return "Include the existing Claude Code plugin in the combined review."
  if (providerOf(row, offer) !== undefined)
    return "Enable each provider you want HolyAgent to use. This does not choose a default model."
  if (row === "deviceAccess")
    return `Lets agents use the iOS simulator or an Android emulator. Found: ${offer.device ?? "no device host"}.`
  if (row === "worktrees")
    return "New T3 Code threads start in their own git worktree instead of the local checkout."
  const capability = capabilityOf(row, offer)
  if (capability === undefined) return ""
  return capability.unavailable === undefined
    ? `${capability.description}.`
    : `${capability.description}. Not offered in this form: ${capability.unavailable}; the choice is kept in the config.`
}

/** Whether a row is enabled in the current choices. */
const isOn = (row: RowId, choices: Choices): boolean =>
  row === "enablePi"
    ? choices.harnesses?.pi === true
    : row === "enableCodex"
      ? choices.harnesses?.codex === true
      : row === "enableClaude"
        ? choices.harnesses?.claude === true
        : row === "deviceAccess"
          ? choices.deviceAccess
          : row === "worktrees"
            ? choices.worktrees
            : row.startsWith(CAPABILITY_ROW) &&
              choices.capabilities[row.slice(CAPABILITY_ROW.length)] === true

const checkbox = (row: RowId, choices: Choices, offer: Offer): { box: string; word: string } => {
  if (row === "codexInAppBrowser") return { box: "", word: "Built-in" }
  if (row === "codexBrowserExtension")
    return choices.codexBrowserHandoff === undefined
      ? { box: "[ ]", word: "Skip" }
      : { box: "[x]", word: "Open guide" }
  const provider = providerOf(row, offer)
  if (provider !== undefined) {
    if (!choices.piProviders?.providers.includes(provider)) return { box: "[ ]", word: "disabled" }
    return { box: "[x]", word: "enabled" }
  }
  return isOn(row, choices) ? { box: "[x]", word: "enabled" } : { box: "[ ]", word: "disabled" }
}

/** The lines of a screen, and how far it scrolls. */
interface Layout {
  readonly lines: ReadonlyArray<Line>
  readonly scroll: Scroll
}

const FIXED: Scroll = { page: 1, max: 0 }

const chooseLines = (state: State, context: Context): ReadonlyArray<Line> => {
  const { rows, offer, width, look } = context
  const g = glyphs(look)
  const values = rows.map((row) => {
    if (row === BROWSER_USE) return ""
    const { box, word } = checkbox(row, state.choices, offer)
    return `${box} ${word}`
  })
  const labels = rows.map((row) => labelOf(row, offer))
  // Reserve the longest state even when all visible choices are enabled. On narrow terminals
  // changing one choice must not move every state column.
  const valueWidth = cells("[ ] disabled")
  const labelWidth = Math.min(
    Math.max(0, ...labels.map(cells)),
    Math.max(4, width - 2 - 2 - valueWidth),
  )
  const rowLine = (row: RowId, index: number): Line => {
    const focused = index === state.focus
    const label = pad(clip(labels[index] ?? "", labelWidth, g.ellipsis), labelWidth)
    const value = values[index] ?? ""
    const line = focused
      ? [segment(`${g.focus} ${label}  ${value}`, "focus")]
      : [
          segment(`  ${label}  `, "argument"),
          segment(value, value.startsWith("[ ]") ? "disabled" : "enabled"),
        ]
    return line.map((part) => ({ ...part, click: { row } }))
  }
  const group = (title: string, from: number, to: number): ReadonlyArray<Line> =>
    to <= from
      ? []
      : [
          ...heading(title, width),
          ...rows.slice(from, to).map((row, index) => rowLine(row, from + index)),
          blank,
        ]
  const configCount = rows.filter((row) => !row.startsWith(CAPABILITY_ROW)).length
  const providerStart = rows[0] === "enablePi" ? 1 : 0
  const providerEnd =
    providerStart + rows.filter((row) => providerOf(row, offer) !== undefined).length
  const button = [
    {
      text: `${state.focus === rows.length ? g.focus : " "} [Review choices]`,
      tone: state.focus === rows.length ? "focus" : "option",
      click: "choose-review",
    },
  ] satisfies Line
  const focused = rows[state.focus]
  const combined = state.choices.harnesses
  const tabsLine: ReadonlyArray<Line> =
    combined === undefined || offer.harnesses?.onlyCodex === true
      ? []
      : [
          tabs.flatMap((tab): Line => [
            {
              text: ` ${tabLabels[tab]} `,
              tone: "option",
              activeTab: state.tab === tab,
              click: { tab },
            },
            segment(" "),
          ]),
          ...hintLines(`${g.horizontalArrows} change harness`, width),
        ]
  const choiceHint = (text: string) =>
    combined === undefined
      ? hintLines(text, width)
      : wrap(text, width - 2).map((line): Line => [segment(`  ${line}`, "hint")])
  const unavailable =
    combined !== undefined && state.tab === "codex" && offer.harnesses?.codexHome === undefined
      ? "Codex setup is not available in this environment."
      : combined !== undefined && state.tab === "pi" && offer.harnesses?.piAvailable === false
        ? "Pi or T3 Code is unavailable on this host."
        : undefined
  return [
    ...tabsLine,
    ...chooseKeys(`${g.arrows} or j/k focus`, width),
    blank,
    ...(context.height < 20 ? [button, blank] : []),
    ...(providerEnd === providerStart
      ? group(combined === undefined ? "T3 Code" : tabLabels[state.tab], 0, configCount)
      : [
          ...group("Pi", 0, providerStart),
          ...group("Pi model providers", providerStart, providerEnd),
          ...group("T3 Code", providerEnd, configCount),
        ]),
    ...group("Capabilities", configCount, rows.length),
    ...(context.height >= 20 ? [button] : []),
    ...(unavailable === undefined ? [] : choiceHint(unavailable)),
    ...(combined?.claude === true && state.tab === "claude"
      ? choiceHint(
          `Existing plugin, ${offer.harnesses?.scope ?? "user"} scope; compatible settings are kept.`,
        )
      : []),
    ...(state.tab === "codex" && offer.harnesses?.codexHome !== undefined
      ? choiceHint(`Profile: ${offer.harnesses.codexHome}`)
      : []),
    ...(focused === undefined ? [] : choiceHint(hintOf(focused, offer))),
    ...choiceHint(`Environment: ${offer.form}`),
  ]
}

const settingsLines = (state: State, context: Context): ReadonlyArray<Line> => {
  const { width, look, offer } = context
  const g = glyphs(look)
  const browserPage = state.settings === "browser-use"
  const nativeBrowser = state.settings === "codex-iab"
  const browserExtension = state.settings === "codex-extension"
  const enabled = browserEnabled(state.choices)
  const box = (checked: boolean) => (checked ? "[x]" : "[ ]")
  const optionText = (option: SettingsOption): string => {
    if (option === "extension-skip")
      return `${box(state.choices.codexBrowserHandoff === undefined)} Skip`
    if (option.startsWith("extension:")) {
      const id = option.slice("extension:".length)
      const candidate = extensionBrowsers(offer).find((entry) => entry.id === id)
      const name = candidate?.name ?? ""
      return `Install in ${name}${state.choices.codexBrowserHandoff === id ? " (selected)" : ""}`
    }
    if (option === "capability") return enabled ? "Disable browser-use" : "Enable browser-use"
    if (option.startsWith("browser:")) {
      const candidate = browserOptions(offer).find(
        ({ id }) => id === option.slice("browser:".length),
      )
      if (candidate !== undefined)
        return `${box(state.choices.browseBrowserIds?.includes(candidate.id) === true)} ${candidate.name}`
    }
    return "Back"
  }
  const options = settingsOptions(state, offer).map((option, index) => ({ option, index }))
  const shortcuts = keyLines([`${g.arrows} or j/k focus`, "Enter select", "Esc back"], width)
  const capacity = Math.max(1, context.height - shortcuts.length - 9)
  const candidates = browserPage || browserExtension ? options.slice(1, -1) : []
  const start = Math.max(0, Math.min(candidates.length - capacity, state.action - capacity))
  const optionLines = ({ option, index }: (typeof options)[number]): ReadonlyArray<Line> =>
    (option.startsWith("browser:") || option.startsWith("extension:")
      ? [clip(optionText(option), width - 2, g.ellipsis)]
      : wrap(optionText(option), width - 2)
    ).map((part, line): Line => [
      {
        text: `${line === 0 && index === state.action ? g.focus : " "} ${part}`,
        tone: index === state.action ? "focus" : "option",
        click: { settingsOption: option },
      },
    ])
  const controls = [
    ...shortcuts,
    blank,
    ...heading(
      nativeBrowser
        ? "Codex In-App Browser"
        : browserExtension
          ? "ChatGPT browser extension"
          : "Browser Use",
      width,
    ),
    ...(browserPage
      ? [
          ...options.slice(0, 1).flatMap(optionLines),
          ...(enabled && offer.browse !== undefined
            ? [
                blank,
                ...heading("Browsers", width),
                ...candidates.slice(start, start + capacity).flatMap(optionLines),
                ...(candidates.length === 0
                  ? hintLines("No Chromium browsers detected.", width)
                  : []),
              ]
            : []),
          ...options.slice(-1).flatMap(optionLines),
        ]
      : browserExtension
        ? [
            ...options.slice(0, 1).flatMap(optionLines),
            ...candidates.slice(start, start + capacity).flatMap(optionLines),
            ...options.slice(-1).flatMap(optionLines),
          ]
        : options.flatMap(optionLines)),
  ]
  const hint = nativeBrowser
    ? hintLines(
        "Use @Browser in the ChatGPT desktop app. The built-in browser has its own profile, and setup does not change its permissions.",
        width,
      )
    : browserExtension
      ? hintLines(
          "After review and Apply, setup opens OpenAI’s guide in the chosen browser. Confirm availability and any connection in ChatGPT desktop. This does not install the extension, connect a profile or grant access.",
          width,
        )
      : []
  // Keep focusable controls visible before adding explanatory text in short terminals.
  const room = Math.max(0, context.height - controls.length - 2)
  return [...controls, ...(room === 0 ? [] : [blank, ...hint.slice(0, room)])]
}

const MARK_TONES: Readonly<Record<ReviewLine["mark"], Tone>> = {
  "+": "success",
  "=": "hint",
  "~": "warning",
  "-": "hint",
}

/** The least room a detail needs beside its name; narrower, it goes on its own lines below. */
const MIN_DETAIL = 24

/** One review entry as lines: name and detail side by side, or the detail stacked under the name. */
const reviewEntry = (line: ReviewLine, nameWidth: number, width: number): ReadonlyArray<Line> => {
  const mark = segment(`  ${line.mark} `, MARK_TONES[line.mark])
  const side = cells(mark.text) + nameWidth + 2
  const room = width - side
  if (room < MIN_DETAIL)
    return [
      [mark, segment(line.name, "argument")],
      ...wrap(line.detail, width - 4).map((part): Line => [segment(`    ${part}`, "hint")]),
    ]
  const parts = wrap(line.detail, room)
  return (parts.length === 0 ? [""] : parts).map((part, index): Line =>
    index === 0
      ? [
          mark,
          segment(pad(line.name, nameWidth), "argument"),
          ...(part === "" ? [] : [segment(`  ${part}`, "hint")]),
        ]
      : [segment(`${" ".repeat(side)}${part}`, "hint")],
  )
}

interface Page {
  readonly shown: ReadonlyArray<Line>
  /** The line saying which lines are shown; `undefined` when everything fits. */
  readonly indicator: Line | undefined
  readonly scroll: Scroll
}

/**
 * The part of `body` that fits `room` lines from line `from` on. When it does not all fit, `room`
 * loses one line to an indicator saying which lines are shown and which keys scroll.
 */
const pageOf = (
  body: ReadonlyArray<Line>,
  room: number,
  from: number,
  rail?: { readonly width: number; readonly look: Look },
): Page => {
  if (body.length <= Math.max(1, room)) return { shown: body, indicator: undefined, scroll: FIXED }
  const size = Math.max(1, room - 1)
  const max = body.length - size
  const start = Math.min(Math.max(0, from), max)
  const end = start + size
  const more =
    start === 0 ? "PgDn for more" : end === body.length ? "PgUp for earlier" : "PgUp/PgDn"
  const visible = body.slice(start, end)
  const shown = rail === undefined ? visible : scrollbar(visible, body.length, start, max, rail)
  return {
    shown,
    indicator: [segment(`Lines ${start + 1}-${end} of ${body.length}, ${more}`, "hint")],
    scroll: { page: Math.max(1, size - 1), max },
  }
}

/** A scrollable page gets a one-cell thumb and track, at the end of its content rows. */
const scrollbar = (
  shown: ReadonlyArray<Line>,
  total: number,
  start: number,
  max: number,
  { width, look }: { readonly width: number; readonly look: Look },
): ReadonlyArray<Line> => {
  const visible = shown.length
  const thumb = Math.max(1, Math.round((visible * visible) / total))
  const first = Math.round(((visible - thumb) * start) / max)
  return shown.map((line, index) => {
    const within = index >= first && index < first + thumb
    const target =
      visible === 1 ? (start === 0 ? max : 0) : Math.round((index * max) / (visible - 1))
    const body = fitLine(line, width - 2, glyphs(look).ellipsis)
    const used = body.reduce((sum, part) => sum + cells(part.text), 0)
    return [
      ...body,
      segment(" ".repeat(width - 1 - used)),
      {
        text: look.unicode ? (within ? "█" : "│") : within ? "#" : "|",
        tone: within ? "focus" : "option",
        click: { scrollTo: target },
      },
    ]
  })
}

const scrollRail = (scrolling: boolean, width: number, look: Look) =>
  scrolling && width >= 8 ? { width, look } : undefined

const REVIEW_RECOVERY =
  "Fix the cause, then choose Back and review again, or choose Cancel and run holyagent setup later."

const reviewLayout = (state: State, context: Context): Layout => {
  const { width, look } = context
  const g = glyphs(look)
  const heading_ = heading(
    context.dryRun ? "Review (dry run: would change, nothing is written)" : "Review",
    width,
  )
  const actionLines = (): ReadonlyArray<Line> =>
    reviewActions(state).map((action, index): Line => {
      const text =
        action === "apply"
          ? context.dryRun
            ? "Apply (dry run)"
            : (state.review?.conflicts?.length ?? 0) > 0
              ? state.choices.keepManagedConflicts === true
                ? "Apply and keep current files"
                : "Apply and replace conflicts"
              : state.review?.replacePiRegistration === true
                ? "Apply and replace Pi package"
                : "Apply"
          : {
              "keep-conflicts": "Keep current files",
              "replace-conflicts": "Replace conflicts",
              back: "Back",
              cancel: "Cancel",
            }[action]
      if (index === state.action)
        return [{ text: `${g.focus} ${text}`, tone: "focus", click: { action } }]
      const tone: Tone = action === "apply" ? "enabled" : action === "cancel" ? "error" : "argument"
      return [{ text: `  ${text}`, tone, click: { action } }]
    })
  const keys = (scrolling: boolean) =>
    keyLines(
      [
        `${g.arrows} or j/k focus`,
        ...(scrolling ? ["PgUp/PgDn scroll"] : []),
        "Enter select",
        "Esc cancel",
      ],
      width,
    )
  if (state.failure !== undefined) {
    const failure = state.failure
    const causeOf = (limit: number) =>
      wrap(failure, limit - 2).map((part): Line => [segment(`  ${part}`, "error")])
    const recovery = hintLines(REVIEW_RECOVERY, width)
    const actions = actionLines()
    // The recovery hint and the actions are what the person needs, so they always show; the cause
    // takes the lines left and scrolls when it is longer.
    const build = (spaced: boolean) => {
      const gap: ReadonlyArray<Line> = spaced ? [blank] : []
      const layout = (scrolling: boolean) => {
        const top = [...keys(scrolling), ...gap, ...heading_]
        const bottom = [...gap, ...recovery, ...gap, ...actions]
        const rail = scrollRail(scrolling, width, look)
        const cause = causeOf(rail === undefined ? width : width - 2)
        const page = pageOf(
          cause,
          context.height - 1 - top.length - bottom.length,
          state.scroll,
          rail,
        )
        return {
          lines: [
            ...top,
            ...page.shown,
            ...(page.indicator === undefined ? [] : [page.indicator]),
            ...bottom,
          ],
          scroll: page.scroll,
          fits: page.indicator === undefined,
          shown: page.shown.length,
        }
      }
      const plain = layout(false)
      return plain.fits ? plain : layout(true)
    }
    // The blank separators go first when the screen is too short to leave the cause three lines.
    const spaced = build(true)
    const chosen = spaced.shown >= Math.min(3, causeOf(width).length) ? spaced : build(false)
    return { lines: chosen.lines, scroll: chosen.scroll }
  }
  if (state.review === undefined) {
    return {
      lines: [
        ...keys(false),
        blank,
        ...heading_,
        [segment("  Reading what will change", "hint")],
        blank,
        ...actionLines(),
      ],
      scroll: FIXED,
    }
  }
  const { review } = state
  const bodyOf = (width: number) => {
    const conflicts = (review.conflicts ?? []).flatMap(({ harness, file, detail }) => [
      ...hintLines(`  ${harness} — ${file}`, width),
      ...hintLines(`    ${detail}`, width),
    ])
    const harnesses = (review.harnesses ?? []).flatMap(({ name, lines }) => [
      ...heading(name, width),
      ...lines.flatMap((line) => hintLines(`  ${line}`, width)),
      blank,
    ])
    const capabilities = review.capabilities ?? []
    const browse = (review.browse ?? []).flatMap((line) => hintLines(`  ${line}`, width))
    const nameWidth = Math.max(
      ...[...capabilities, ...review.choices, ...review.always].map((line) => cells(line.name)),
    )
    const entries = (lines: ReadonlyArray<ReviewLine>) =>
      lines.flatMap((line) => reviewEntry(line, nameWidth, width))
    const section = (title: string, lines: ReadonlyArray<ReviewLine>): ReadonlyArray<Line> =>
      lines.length === 0 ? [] : [...heading(title, width), ...entries(lines), blank]
    const t3 = [
      ...(review.file === undefined
        ? []
        : [
            ...wrap(review.file, width - 2).map((part): Line => [segment(`  ${part}`, "hint")]),
            blank,
          ]),
      ...section("Your choices", review.choices),
      ...section("Always applied", review.always),
    ]
    return [
      ...(conflicts.length === 0
        ? []
        : [...heading("Managed conflicts", width), ...conflicts, blank]),
      ...(browse.length === 0 ? [] : [...heading("Browser Use setup", width), ...browse, blank]),
      ...harnesses,
      ...section("Capabilities", capabilities),
      ...t3,
    ].slice(0, -1)
  }
  const actions = actionLines()
  // The title takes one line, and the line above the actions holds the scroll indicator, if any.
  const build = (scrolling: boolean): Layout & { readonly fits: boolean } => {
    const top = [...keys(scrolling), blank, ...heading_]
    const room = context.height - 1 - top.length - 1 - actions.length
    const rail = scrollRail(scrolling, width, look)
    const body = bodyOf(rail === undefined ? width : width - 2)
    const page = pageOf(body, room, state.scroll, rail)
    return {
      lines: [...top, ...page.shown, page.indicator ?? blank, ...actions],
      scroll: page.scroll,
      fits: page.indicator === undefined,
    }
  }
  const plain = build(false)
  return plain.fits ? plain : build(true)
}

const reportTone = (line: string): Tone =>
  line.startsWith("+ ")
    ? "success"
    : line.startsWith("! ")
      ? "error"
      : line.startsWith("~ ")
        ? "warning"
        : "hint"

const doneLayout = (state: State, context: Context): Layout => {
  const { width, height, look } = context
  const applied = state.applied ?? { ok: false, lines: [] }
  const bodyOf = (width: number) =>
    state.details
      ? applied.lines.flatMap((line) =>
          wrap(line, width, 2).map((part): Line => [segment(part, reportTone(line))]),
        )
      : summarizeResult(applied, context.dryRun).flatMap(({ title, lines }) => [
          ...heading(title, width),
          ...lines.flatMap((line) => hintLines(`  ${line}`, width)),
        ])
  const build = (scrolling: boolean): Layout & { readonly fits: boolean } => {
    const top: ReadonlyArray<Line> = [
      [{ text: "Close (Enter or q)", tone: "option", click: "close" }],
      [
        {
          text: state.details ? "Summary (d)" : "Full details (d)",
          tone: "option",
          click: "details",
        },
      ],
      ...(scrolling ? keyLines(["PgUp/PgDn scroll"], width) : []),
      ...heading(context.dryRun ? "Result (dry run)" : "Result", width),
      ...wrap(resultHeadline(applied.ok, context.dryRun), width).map((part): Line => [
        segment(part, applied.ok ? "success" : "error"),
      ]),
    ]
    const rail = scrollRail(scrolling, width, look)
    const body = bodyOf(rail === undefined ? width : width - 2)
    const page = pageOf(body, height - 1 - top.length, state.scroll, rail)
    return {
      lines: [...top, ...page.shown, ...(page.indicator === undefined ? [] : [page.indicator])],
      scroll: page.scroll,
      fits: page.indicator === undefined,
    }
  }
  const plain = build(false)
  return plain.fits ? plain : build(true)
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

const applyingLines = (context: Context): ReadonlyArray<Line> => {
  const phase = context.progress?.phase
  const harness = context.progress?.harness
  const elapsed = context.elapsedSeconds ?? 0
  return [
    [segment("Press Ctrl+C to stop", "option")],
    blank,
    ...heading("Applying", context.width),
    [segment(`Elapsed ${elapsed}s`, "hint")],
    ...(harness === undefined
      ? []
      : wrap(`Harness ${harness.index} of ${harness.total}: ${harness.label}`, context.width).map(
          (part): Line => [segment(part, "hint")],
        )),
    ...wrap(
      phase === undefined
        ? "Preparing setup…"
        : `Step ${phase.index} of ${phase.total}: ${phase.label}`,
      context.width,
    ).map((part): Line => [segment(part, "argument")]),
    ...(phase?.activity === undefined
      ? []
      : wrap(phase.activity, context.width).map((part): Line => [segment(part, "hint")])),
  ]
}

const layoutOf = (state: State, context: Context): Layout =>
  state.screen === "choose"
    ? { lines: chooseLines(state, context), scroll: FIXED }
    : state.screen === "settings"
      ? { lines: settingsLines(state, context), scroll: FIXED }
      : state.screen === "review"
        ? reviewLayout(state, context)
        : state.screen === "applying"
          ? { lines: applyingLines(context), scroll: FIXED }
          : doneLayout(state, context)

/** How far the screen the state is on scrolls, for {@link press}. */
export const scrollOf = (state: State, context: Context): Scroll => layoutOf(state, context).scroll

/** The lines of the screen the state is on, every one cut to the width. */
export const view = (state: State, context: Context): ReadonlyArray<Line> =>
  [title(context.look), ...layoutOf(state, context).lines].map((line) =>
    fitLine(line, context.width, glyphs(context.look).ellipsis),
  )
