/**
 * The traffic of T3 Code driving `pi --mode rpc`, written out as JSONL fixtures for the installed
 * Pi host. T3 Code is not run and no Pi session starts: every Pi message is built from Pi 1.x's
 * exported types (`satisfies` on `RpcCommand`, `RpcResponse`, `RpcExtensionUIRequest`,
 * `RpcExtensionUIResponse`, the session event types), so a Pi update that renames or retypes a
 * field fails the type-check. The parts that are T3's or a package's, not Pi's, are marked
 * `synthesized` in the header with their sources: the launch (`t3_launch`) follows T3's
 * `buildPiRpcLaunch`, and the completion notice follows `@tintinweb/pi-subagents`' new-turn
 * trigger.
 *
 * Re-record after `mise run deps:update` moves Pi: `bun
 * packages/integrations/pi/tests/fixtures/t3/record.ts`.
 */
import { join } from "node:path"

import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { Schema } from "effect"

import { FixtureHeader, installedPiVersion, PI_PACKAGE } from "../record.ts"

/** The command that writes the T3 fixtures again, for the message of a stale fixture. */
export const T3_RERECORD_COMMAND = "bun packages/integrations/pi/tests/fixtures/t3/record.ts"

/** The folder the T3 fixtures live in. */
export const T3_FIXTURES_DIRECTORY = import.meta.dir

/** Where the T3 behavior in the fixtures was read, for the header of every file. */
const T3_SOURCES: ReadonlyArray<string> = [
  "T3 Code main on 2026-11-09 (latest release v0.1.7): packages/provider-pi/src/server/mcpInjection.ts (buildPiRpcLaunch)",
  "T3 Code main: docs/user/providers-pi.md and the Pi adapter's handleExtensionUiRequest (select, confirm, input, editor and notify are rendered, setStatus is shown near the composer, everything else is ignored)",
  "Pi 1.5.0: dist/modes/rpc/rpc-types.d.ts, dist/modes/rpc/rpc-mode.js, dist/core/agent-session.d.ts",
]

/** The first line of a T3 fixture file: the Pi header plus the mark that the traffic is synthesized. */
export const T3FixtureHeader = Schema.Struct({
  ...FixtureHeader.fields,
  /** Always true: the file is built from types and T3's source, not recorded from a T3 session. */
  synthesized: Schema.Literal(true),
  /** What the synthesized traffic follows, one entry per source. */
  sources: Schema.Array(Schema.String),
})

/** The first line of a T3 fixture file, as a type. */
export type T3FixtureHeader = typeof T3FixtureHeader.Type

/** One T3 fixture: a header's description and sources, and the lines of the file in order. */
export interface T3Fixture {
  /** The file name without the extension. */
  readonly name: string
  /** What the lines show. */
  readonly description: string
  /** What the synthesized lines follow, after the shared T3 and Pi sources. */
  readonly sources?: ReadonlyArray<string>
  /** The lines after the header. */
  readonly events: ReadonlyArray<object>
}

type Wire = JsonAgentSessionEvent
type AgentMessage = Extract<Wire, { type: "message_end" }>["message"]
type Assistant = Extract<AgentMessage, { role: "assistant" }>

const AT = 1_700_000_000_000

const text = (value: string) => ({ type: "text", text: value }) as const

const user = (value: string): AgentMessage => ({ role: "user", content: value, timestamp: AT })

const assistant = (value: string): Assistant => ({
  role: "assistant",
  content: [text(value)],
  api: "openai-completions",
  provider: "kimi-coding",
  model: "k3.1-pro",
  usage: {
    input: 120,
    output: 40,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 160,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: AT + 1,
})

/** The notice `@tintinweb/pi-subagents` sends when a background specialist ends. */
const completion: AgentMessage = {
  role: "custom",
  customType: "subagent-notification",
  content: "Specialist reviewer-code finished (assignment-0001). Report: the change is correct.",
  display: true,
  timestamp: AT + 10,
}

/** A turn of the root: `agent_start`, the opening message, one reply, `agent_end`, `agent_settled`. */
const rootTurn = (opening: AgentMessage, reply: Assistant): ReadonlyArray<Wire> => [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: opening },
  { type: "message_end", message: opening },
  { type: "message_start", message: reply },
  { type: "message_end", message: reply },
  { type: "turn_end", message: reply, toolResults: [] },
  { type: "agent_end", messages: [opening, reply], willRetry: false },
  { type: "agent_settled", aborted: false },
]

/** The T3 fixtures, each the traffic of one behavior. */
export const T3_FIXTURES: ReadonlyArray<T3Fixture> = [
  {
    name: "t3-session-start",
    description:
      "Synthesized: T3 Code starts pi --mode rpc with T3_PI_RUNTIME_MODE set, the extension's session_start fires, and T3 sends the first prompt, which Pi accepts.",
    events: [
      {
        // T3's side of the launch (not a Pi message): the argument list and the environment it sets.
        type: "t3_launch",
        args: [
          "--mode",
          "rpc",
          "--session",
          "/home/user/.t3/pi/sessions/thread-1.jsonl",
          "--extension",
          "/home/user/.t3/cache/pi-t3-mcp-extension.ts",
        ],
        env: {
          T3_PI_RUNTIME_MODE: "full-access",
          T3_PI_MCP_EXTENSION_PATH: "/home/user/.t3/cache/pi-t3-mcp-extension.ts",
          T3_MCP_URL: "http://127.0.0.1:41234/mcp",
        },
      },
      { type: "session_start", reason: "startup" } satisfies SessionStartEvent,
      {
        id: "t3-1",
        type: "prompt",
        message: "Plan the change.",
      } satisfies RpcCommand,
      {
        id: "t3-1",
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      } satisfies RpcResponse,
    ],
  },
  {
    name: "t3-ui-dialogs",
    description:
      "Synthesized: the six extension_ui_request methods T3 Code renders (select, confirm, input, editor, notify, setStatus) and T3's extension_ui_response to each dialog; notify and setStatus take no response.",
    events: [
      ...([
        {
          type: "extension_ui_request",
          id: "ui-select",
          method: "select",
          title: "Pick a model",
          options: ["k3.1-pro", "k3.1-flash"],
          timeout: 30_000,
        },
        { type: "extension_ui_response", id: "ui-select", value: "k3.1-pro" },
        {
          type: "extension_ui_request",
          id: "ui-confirm",
          method: "confirm",
          title: "Allow the write?",
          message: "The specialist wants to write README.md.",
          timeout: 30_000,
        },
        { type: "extension_ui_response", id: "ui-confirm", confirmed: true },
        {
          type: "extension_ui_request",
          id: "ui-input",
          method: "input",
          title: "Branch name",
          placeholder: "release/0.3.0/feat/x",
        },
        { type: "extension_ui_response", id: "ui-input", value: "release/0.3.0/feat/t3" },
        {
          type: "extension_ui_request",
          id: "ui-editor",
          method: "editor",
          title: "Edit the Intent",
          prefill: "Objective: ",
        },
        { type: "extension_ui_response", id: "ui-editor", cancelled: true },
        {
          type: "extension_ui_request",
          id: "ui-notify",
          method: "notify",
          message: "holyagent: provider not ready",
          notifyType: "warning",
        },
        {
          type: "extension_ui_request",
          id: "ui-status",
          method: "setStatus",
          statusKey: "holyagent",
          statusText: "1 running",
        },
      ] satisfies ReadonlyArray<RpcExtensionUIRequest | RpcExtensionUIResponse>),
    ],
  },
  {
    name: "t3-late-completion",
    description:
      "Synthesized: a root turn settles while a background specialist still runs; the specialist's completion notice then arrives after agent_settled and starts a new root turn (agent_start) with the notice as its opening message.",
    sources: [
      "@tintinweb/pi-subagents 0.23.1: the completion is a steering message with triggerTurn true (docs/pi/caching-and-subagents.md); the notice's customType is an assumption, as the package source was not read",
      "T3 Code treats a turn as done on agent_settled (docs/pi/t3-code.md, Specialists and completion notices)",
    ],
    events: [
      ...rootTurn(
        user("Review the change in the background."),
        assistant("Started reviewer-code."),
      ),
      ...rootTurn(completion, assistant("The review found no problems.")),
    ],
  },
]

/** The text of a T3 fixture file for a Pi version: the header, then one line per event. */
export const renderT3Fixture = (fixture: T3Fixture, piVersion: string): string => {
  const header: T3FixtureHeader = {
    package: PI_PACKAGE,
    piVersion,
    name: fixture.name,
    source: "rpc-mode",
    description: fixture.description,
    synthesized: true,
    sources: [...T3_SOURCES, ...(fixture.sources ?? [])],
  }
  return `${[{ holyagentFixture: header }, ...fixture.events].map((line) => JSON.stringify(line)).join("\n")}\n`
}

if (import.meta.main) {
  const version = await installedPiVersion()
  for (const fixture of T3_FIXTURES)
    await Bun.write(
      join(T3_FIXTURES_DIRECTORY, `${fixture.name}.jsonl`),
      renderT3Fixture(fixture, version),
    )
  console.log(`recorded ${T3_FIXTURES.length} T3 fixtures for ${PI_PACKAGE} ${version}`)
}
