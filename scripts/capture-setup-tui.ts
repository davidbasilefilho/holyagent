import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

import type { Applied } from "../packages/runtime/src/setup/tui/types.ts"
import {
  mount,
  type Mounted,
  PREVIEW,
  spanListing,
} from "../packages/runtime/tests/setup-tui-harness.ts"

/**
 * Renders the setup interface in OpenTUI's headless test renderer and saves every state at three
 * sizes as text: the character frame (`captureCharFrame`), then the colour spans. Usage: `bun
 * scripts/capture-setup-tui.ts <directory>`; the files are `<state>-<cols>x<rows>.txt`.
 */
const directory = Bun.argv[2]
if (directory === undefined) throw new Error("usage: bun scripts/capture-setup-tui.ts <directory>")

const SIZES = [
  [80, 24],
  [40, 20],
  [120, 40],
] as const

const SUCCESS: Applied = {
  ok: true,
  lines: [
    "~ scope: user (default)",
    "- ctx7: skipped by flag",
    '+ t3 settings /home/user/.t3/userdata/settings.json: added defaultThreadEnvMode "worktree", autoResumeLimitedThreads true',
    "= user settings /home/user/.claude/settings.json: already set",
  ],
}
const FAILURE: Applied = {
  ok: false,
  lines: [
    "~ scope: user (default)",
    "! t3 settings: /home/user/.t3/userdata/settings.json changed while setup was working on it, so nothing was written. Close T3 Code and run setup again",
    "+ user settings /home/user/.claude/settings.json: added 10",
  ],
}

interface Scene {
  readonly name: string
  readonly options?: Partial<Parameters<typeof mount>[0]>
  readonly keys?: ReadonlyArray<string>
  /** Resizes the screen to this size after the keys, before the frame; the scene starts at 80x24. */
  readonly resize?: readonly [number, number]
}

const never = new Promise<never>(() => {})

const SCENES: ReadonlyArray<Scene> = [
  { name: "initial" },
  { name: "focus-pi", keys: [] },
  { name: "focus-device", keys: ["down"] },
  { name: "focus-worktrees", keys: ["down", "down"] },
  { name: "focus-wrap-j-k", keys: ["k", "j", "j"] },
  { name: "pi-fixed-space-ignored", keys: [" "] },
  { name: "device-off", keys: ["down", " "] },
  { name: "worktrees-off", keys: ["down", "down", " "] },
  { name: "both-off", keys: ["down", " ", "down", " "] },
  { name: "no-device-host", options: { device: undefined } },
  { name: "no-device-host-focus-worktrees", options: { device: undefined }, keys: ["down"] },
  { name: "review", keys: ["enter"] },
  { name: "review-choices-off", keys: ["down", " ", "down", " ", "enter"] },
  { name: "review-dry-run", options: { dryRun: true }, keys: ["enter"] },
  { name: "review-loading", options: { review: () => never }, keys: ["enter"] },
  {
    name: "review-failed",
    options: {
      review: () =>
        Promise.reject(new Error("/home/user/.t3/userdata/settings.json is not a JSON object")),
    },
    keys: ["enter"],
  },
  { name: "review-back-action", keys: ["enter", "down"] },
  { name: "review-cancel-action", keys: ["enter", "down", "down"] },
  { name: "cancel-escape", keys: ["escape"] },
  { name: "cancel-ctrl-c", keys: ["ctrl-c"] },
  { name: "cancel-from-review", keys: ["enter", "escape"] },
  { name: "applying", options: { apply: () => never }, keys: ["enter", "enter"] },
  {
    name: "applying-interrupted",
    options: { apply: () => never },
    keys: ["enter", "enter", "ctrl-c"],
  },
  {
    name: "apply-success",
    options: { apply: () => Promise.resolve(SUCCESS) },
    keys: ["enter", "enter"],
  },
  {
    name: "apply-failure",
    options: { apply: () => Promise.resolve(FAILURE) },
    keys: ["enter", "enter"],
  },
  {
    name: "apply-error",
    options: { apply: () => Promise.reject(new Error("the process was killed")) },
    keys: ["enter", "enter"],
  },
  {
    name: "apply-success-dry-run",
    options: { dryRun: true, apply: () => Promise.resolve(SUCCESS) },
    keys: ["enter", "enter"],
  },
  { name: "no-color", options: { env: { TERM: "xterm-256color", NO_COLOR: "1" } } },
  {
    name: "no-color-review",
    options: { env: { TERM: "xterm-256color", NO_COLOR: "1" } },
    keys: ["enter"],
  },
  { name: "resize-to-narrow", resize: [40, 20] },
  { name: "resize-to-narrow-review", keys: ["enter"], resize: [40, 20] },
  { name: "resize-to-wide", resize: [120, 40] },
  {
    name: "review-wide-characters",
    options: {
      review: () =>
        Promise.resolve({
          file: "/home/用户/日本語のフォルダ/.t3/userdata/settings.json",
          choices: [
            { mark: "+", name: "Pi provider", detail: "👨‍👩‍👧 providerInstances.pi.enabled true" },
          ],
          always: [
            {
              mark: "~",
              name: "Branch naming",
              detail: 'kept branchNameInstructions "ブランチ名" (yours wins)',
            },
          ],
        }),
    },
    keys: ["enter"],
  },
  { name: "ascii-locale", options: { env: { TERM: "xterm-256color", LANG: "C" } } },
  {
    name: "ascii-locale-review",
    options: { env: { TERM: "xterm-256color", LANG: "C" } },
    keys: ["enter"],
  },
]

await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })
let written = 0
for (const scene of SCENES) {
  for (const [width, height] of scene.resize === undefined ? SIZES : ([[80, 24]] as const)) {
    const mounted: Mounted = await mount({ width, height, ...scene.options })
    await mounted.keys(...(scene.keys ?? []))
    if (scene.resize !== undefined) await mounted.resize(...scene.resize)
    const outcome =
      mounted.outcomes.length === 0
        ? "none (the screen is still open)"
        : JSON.stringify(mounted.outcomes)
    const text = [
      `# ${scene.name} at ${width}x${height}`,
      `keys: ${(scene.keys ?? []).map((key) => (key === " " ? "space" : key)).join(" ") || "(none)"}${scene.resize === undefined ? "" : `, then resize to ${scene.resize.join("x")}`}`,
      `outcome: ${outcome}`,
      "",
      "## frame",
      ...mounted.lines().map((line, row) => `${String(row + 1).padStart(2, "0")}|${line}`),
      "",
      "## spans",
      spanListing(mounted),
      "",
    ].join("\n")
    await Bun.write(join(directory, `${scene.name}-${width}x${height}.txt`), text)
    mounted.destroy()
    written += 1
  }
}
console.log(`wrote ${written} captures to ${directory}; preview device: ${PREVIEW.device}`)
