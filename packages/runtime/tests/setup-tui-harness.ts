import solidPlugin from "@opentui/solid/bun-plugin"

import type { T3Preview } from "../src/setup/t3-settings.ts"
import { capabilityReview, reviewOf } from "../src/setup/tui/session.ts"
import type { Background } from "../src/setup/tui/theme.ts"
import type {
  CapabilityOffer,
  Choices,
  Review,
  TuiInput,
  TuiOutcome,
} from "../src/setup/tui/types.ts"

// The interface's JSX needs the Solid transform, which `bun test` does not apply on its own: load
// the plugin, then import the sources, so the tests need no bunfig preload.
await Bun.plugin(solidPlugin)
const { testRender } = await import("@opentui/solid")
const { SetupApp } = await import("../src/setup/tui/app.tsx")

/**
 * What the T3 step would do on a machine where Android's SDK is found, T3's file lacks most keys,
 * the branch rule is set and a cleanup value is the user's own.
 */
export const PREVIEW: T3Preview = {
  file: "/home/user/.t3/userdata/settings.json",
  device: "the Android SDK (/home/user/Android/Sdk)",
  worktreesAllowed: true,
  units: [
    {
      name: "Pi provider",
      choice: "pi",
      added: ['providerInstances.pi.driver "pi"', "providerInstances.pi.enabled true"],
      present: [],
      kept: [],
    },
    {
      name: "device access",
      choice: "deviceAccess",
      added: ["enableDeviceSupport true", "enableAgentDeviceAccess true"],
      present: [],
      kept: [],
    },
    {
      name: "worktrees",
      choice: "worktrees",
      added: ['defaultThreadEnvMode "worktree"'],
      present: [],
      kept: [],
    },
    {
      name: "background activity",
      added: [
        "backgroundActivity.schemaVersion 1",
        'backgroundActivity.profile "custom"',
        'backgroundActivity.baseProfile "balanced"',
        "backgroundActivity.overrides.pauseWhenHostLocked false",
      ],
      present: [],
      kept: [],
    },
    {
      name: "source control writing",
      added: ['sourceControlWritingStyle.mode "conventional_commits"'],
      present: [],
      kept: [],
    },
    {
      name: "threads and git",
      added: ["autoResumeLimitedThreads true", "snoozeLimitedThreads true"],
      present: [],
      kept: [],
    },
    { name: "branch naming", added: [], present: ["branchNamingMode"], kept: [] },
    {
      name: "storage cleanup",
      added: ["storageCleanup.worktreeOnMerge true"],
      present: [],
      kept: ["storageCleanup.logsAfterDays 7"],
    },
  ],
}

/** What a mounted interface reads from the test and reports back. */
export interface Mount {
  readonly width: number
  readonly height: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly device?: string | undefined
  readonly worktrees?: boolean
  /** Whether the T3 rows are offered; true when absent. */
  readonly t3?: boolean
  readonly combined?: boolean
  readonly codexHome?: string
  readonly onlyCodex?: boolean
  readonly codexDesktop?: NonNullable<TuiInput["offer"]["harnesses"]>["codexDesktop"]
  /** The capability rows, all switched on at the start; none when absent. */
  readonly capabilities?: ReadonlyArray<CapabilityOffer>
  readonly browserUseEnabled?: boolean
  readonly browserIds?: ReadonlyArray<string>
  readonly browse?: TuiInput["offer"]["browse"]
  readonly dryRun?: boolean
  /** The terminal background the palette is picked for; dark when absent. */
  readonly background?: Background
  readonly review?: (choices: Choices) => Promise<Review>
  readonly apply?: TuiInput["apply"]
}

const NORMAL = { form: "normal", source: "default", reason: "no form was asked for" } as const

/** One mounted interface on the headless renderer, with the calls it made. */
export const mount = async (options: Mount) => {
  const reviews: Array<Choices> = []
  const applies: Array<Choices> = []
  const signals: Array<AbortSignal> = []
  const outcomes: Array<TuiOutcome> = []
  const input: TuiInput = {
    env: options.env ?? { TERM: "xterm-256color" },
    offer: {
      t3: options.t3 ?? true,
      device:
        "device" in options ? options.device : "Xcode (/Applications/Xcode.app/Contents/Developer)",
      worktrees: options.worktrees ?? true,
      capabilities: options.capabilities ?? [],
      ...(options.browse === undefined ? {} : { browse: options.browse }),
      form: "normal (detected: a graphical session is available)",
      ...(options.combined === true
        ? {
            harnesses: {
              piAvailable: true,
              scope: "user",
              ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
              ...(options.onlyCodex === true ? { onlyCodex: true } : {}),
              ...(options.codexDesktop === undefined ? {} : { codexDesktop: options.codexDesktop }),
            },
            providers: ["kimi-coding-global", "openai-codex"],
          }
        : {}),
    },
    initial: {
      worktrees: true,
      deviceAccess: true,
      ...(options.combined === true
        ? {
            harnesses: {
              pi: true,
              claude: false,
              ...(options.codexHome === undefined ? {} : { codex: options.onlyCodex === true }),
            },
            piProviders: { providers: ["kimi-coding-global"] },
          }
        : {}),
      capabilities: Object.fromEntries(
        (options.capabilities ?? []).map(({ feature }) => [
          feature,
          feature === "browserUse" ? (options.browserUseEnabled ?? true) : true,
        ]),
      ),
      ...(options.browse?.action === undefined ? {} : { browseSetup: true }),
      ...(options.browserIds === undefined ? {} : { browseBrowserIds: options.browserIds }),
    },
    dryRun: options.dryRun ?? false,
    review: (choices) => {
      reviews.push(choices)
      return options.review === undefined
        ? Promise.resolve(
            reviewOf(
              options.t3 === false ? undefined : PREVIEW,
              choices,
              capabilityReview(input.initial.capabilities, choices.capabilities, NORMAL),
            ),
          )
        : options.review(choices)
    },
    apply: (choices, signal, report) => {
      applies.push(choices)
      signals.push(signal)
      return options.apply === undefined
        ? Promise.resolve({ ok: true, lines: ["+ t3 settings: added defaultThreadEnvMode"] })
        : options.apply(choices, signal, report)
    },
  }
  const setup = await testRender(
    () =>
      SetupApp({
        input,
        ...(options.background === undefined ? {} : { background: options.background }),
        done: (outcome) => void outcomes.push(outcome),
      }),
    { width: options.width, height: options.height, exitOnCtrlC: false, useMouse: true },
  )
  await setup.renderOnce()
  /** Lets a settled promise reach the screen, then draws. */
  const settle = async () => {
    await Bun.sleep(5)
    await setup.renderOnce()
  }
  /** Presses keys one after the other, drawing after each. */
  const keys = async (...names: ReadonlyArray<string>) => {
    for (const name of names) {
      if (name === "enter") setup.mockInput.pressEnter()
      else if (name === "escape") {
        setup.mockInput.pressEscape()
        // The key parser holds a lone Escape back until no escape sequence can follow.
        await Bun.sleep(80)
      } else if (name === "ctrl-c") setup.mockInput.pressCtrlC()
      else if (name === "pagedown") setup.mockInput.pressKey("\u001B[6~")
      else if (name === "pageup") setup.mockInput.pressKey("\u001B[5~")
      else if (name === "end") setup.mockInput.pressKey("\u001B[F")
      else if (name === "up" || name === "down" || name === "left" || name === "right")
        setup.mockInput.pressArrow(name)
      else setup.mockInput.pressKey(name)
      await settle()
    }
  }
  const frame = () => setup.captureCharFrame()
  return {
    keys,
    click: async (x: number, y: number) => {
      await setup.mockMouse.click(x, y)
      await settle()
    },
    wheel: async (x: number, y: number, direction: "up" | "down") => {
      await setup.mockMouse.scroll(x, y, direction)
      await settle()
    },
    frame,
    lines: () =>
      frame()
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => line.trimEnd()),
    spans: () => setup.captureSpans(),
    settle,
    reviews,
    applies,
    signals,
    outcomes,
    destroy: () => setup.renderer.destroy(),
    resize: async (width: number, height: number) => {
      setup.resize(width, height)
      await settle()
    },
  }
}

/** A mounted interface. */
export type Mounted = Awaited<ReturnType<typeof mount>>

const hex = (value: number) => Math.round(value).toString(16).padStart(2, "0")

/**
 * The colour spans of a frame as text: one line per screen row that has any, each span as its
 * foreground (`#rrggbb`, or `default` for the terminal's own), `bold` when bold, and its text.
 * Spans of spaces only are left out.
 */
export const spanListing = (mounted: Mounted): string =>
  mounted
    .spans()
    .lines.flatMap((line, row) => {
      const parts = line.spans
        .filter((span) => span.text.trim() !== "")
        .map((span) => {
          const fg = span.fg
          const color =
            fg.intent === "default"
              ? "default"
              : `#${hex(fg.r * 255)}${hex(fg.g * 255)}${hex(fg.b * 255)}`
          return `${color}${span.attributes % 2 === 1 ? " bold" : ""} ${JSON.stringify(span.text.trimEnd())}`
        })
      return parts.length === 0
        ? []
        : [`row ${String(row + 1).padStart(2, "0")}: ${parts.join(" | ")}`]
    })
    .join("\n")
