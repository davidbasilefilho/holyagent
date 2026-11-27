import { PassThrough } from "node:stream"

import { CliRenderer, RGBA, TextAttributes } from "@opentui/core"
import { render } from "@opentui/solid"
import { Effect } from "effect"
import { For } from "solid-js"

import { terminalSpan } from "./terminal-output.ts"
import { backgroundFromColorfgbg, lookFor, paletteOf } from "./theme.ts"
import type { PublicHelpInput } from "./types.ts"

const LABEL_WIDTH = 18
const TWO_COLUMNS = 82

const Help = ({ commands, width, env }: PublicHelpInput) => {
  const look = lookFor(env, backgroundFromColorfgbg(env))
  const palette = paletteOf(look)
  const fg = (value: keyof typeof palette) =>
    look.color ? palette[value] : RGBA.defaultForeground()
  const wide = width >= TWO_COLUMNS
  const indent = width >= 24 ? 2 : 0
  const available = width - indent
  return (
    <box width={width} flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text fg={fg("heading")}>
          <b>HolyAgent</b>
        </text>
        <text fg={fg("argument")} wrapMode="word">
          Manage your HolyAgent installation.
        </text>
      </box>
      <box flexDirection="column">
        <text fg={fg("heading")}>Get started</text>
        <box flexDirection="column" marginLeft={indent} width={available}>
          <text fg={fg("focus")} wrapMode="word">
            <b>holyagent setup</b>
          </text>
          <text fg={fg("argument")} wrapMode="word">
            Choose which integrations to configure.
          </text>
        </box>
      </box>
      <box flexDirection="column">
        <text fg={fg("heading")}>Other commands</text>
        <For each={commands}>
          {({ name, summary }, index) => (
            <box
              flexDirection={wide ? "row" : "column"}
              marginTop={!wide && index() > 0 ? 1 : 0}
              marginLeft={indent}
              width={available}>
              <text fg={fg("option")} width={wide ? LABEL_WIDTH : available} wrapMode="word">
                holyagent {name}
              </text>
              <text
                fg={fg("argument")}
                width={available - (wide ? LABEL_WIDTH : 0)}
                wrapMode="word">
                {summary}
              </text>
            </box>
          )}
        </For>
      </box>
      <text fg={fg("hint")} wrapMode="word">
        Run holyagent help [command] for details.
      </text>
    </box>
  )
}

const capture = (renderer: CliRenderer, color: boolean): string => {
  const lines = renderer.currentRenderBuffer.getSpanLines()
  const last = lines.findLastIndex(({ spans }) => spans.some(({ text }) => text.trim() !== ""))
  if (last < 0) throw new Error("The public help renderer produced no text")
  return (
    lines
      .slice(0, last + 1)
      .map(({ spans }) => {
        const end = spans.findLastIndex(({ text }) => text.trim() !== "")
        return spans
          .slice(0, end + 1)
          .map(({ text, fg, attributes }, index) => {
            const visible = index === end ? text.trimEnd() : text
            return color && visible.trim() !== ""
              ? terminalSpan(visible, fg, (attributes & TextAttributes.BOLD) !== 0)
              : visible
          })
          .join("")
      })
      .join("\n") + "\n"
  )
}

const memoryRenderer = (input: PublicHelpInput) => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()
  const descriptionSize = input.commands.reduce((size, command) => size + command.summary.length, 0)
  const contentWidth = input.width - (input.width >= TWO_COLUMNS ? LABEL_WIDTH + 2 : 2)
  // Leave room for the word wrap without tying a static document to the terminal's viewport height.
  const height = 24 + 2 * Math.ceil(descriptionSize / Math.max(1, contentWidth))
  return new CliRenderer(
    stdin as unknown as NodeJS.ReadStream,
    stdout as unknown as NodeJS.WriteStream,
    input.width,
    height,
    {
      bufferedOutput: "memory",
      screenMode: "main-screen",
      externalOutputMode: "passthrough",
      exitSignals: [],
      consoleMode: "disabled",
      useMouse: false,
      useKittyKeyboard: null,
    },
  )
}

/** Renders one Solid help document offscreen, then appends its painted text without terminal setup. */
export const renderPublicHelp = (input: PublicHelpInput): Promise<string> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.try(() => memoryRenderer(input)),
      (renderer) =>
        Effect.tryPromise(() => render(() => <Help {...input} />, renderer)).pipe(
          Effect.andThen(Effect.tryPromise(() => renderer.idle())),
          Effect.map(() => capture(renderer, lookFor(input.env).color)),
        ),
      (renderer) =>
        Effect.sync(() => renderer.destroy()).pipe(
          Effect.andThen(Effect.tryPromise(() => renderer.closed)),
          Effect.ignore,
        ),
    ),
  )
