/**
 * The Pi events the HolyAgent integration consumes, written out as JSONL fixtures for the installed
 * Pi host. Every event is built from Pi 1.x's own type declarations (`satisfies` on its exported
 * event types), so a Pi update that renames or retypes a field the event spells out fails the
 * type-check (a `Pick` covers only the picked fields); the JSONL files are what `contract.test.ts`
 * reads. Nothing here starts Pi.
 *
 * Re-record after `mise run deps:update` moves Pi: `bun
 * packages/integrations/pi/tests/fixtures/record.ts`.
 */
import { dirname, join } from "node:path"

import type {
  BeforeAgentStartUserEvent,
  JsonAgentSessionEvent,
  MessageEndEvent,
  RpcExtensionUIRequest,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent"
import { Schema } from "effect"

/** The npm package that is the Pi host the fixtures are built for. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent"

/** The command that writes the fixtures again, for the message of a stale fixture. */
export const RERECORD_COMMAND = "bun packages/integrations/pi/tests/fixtures/record.ts"

/** The folder the fixtures live in. */
export const FIXTURES_DIRECTORY = import.meta.dir

/** The first line of a fixture file: what it is and the Pi version it was built for. */
export const FixtureHeader = Schema.Struct({
  /** The package the fixture was built for, always {@link PI_PACKAGE}. */
  package: Schema.String,
  /** The exact version of that package, from its installed `package.json`. */
  piVersion: Schema.String,
  /** The fixture's file name without the extension. */
  name: Schema.String,
  /** Where the events come from in Pi: the JSON or RPC stdout protocol, or an extension event. */
  source: Schema.Literals(["json-mode", "extension-api", "rpc-mode"]),
  /** What the events show, for a reader of the file. */
  description: Schema.String,
})

/** The first line of a fixture file, as a type. */
export type FixtureHeader = typeof FixtureHeader.Type

/** One fixture: a header's description and the events of the file, in order. */
export interface PiFixture {
  /** The file name without the extension. */
  readonly name: string
  /** Where the events come from in Pi. */
  readonly source: FixtureHeader["source"]
  /** What the events show. */
  readonly description: string
  /** The lines after the header. */
  readonly events: ReadonlyArray<object>
}

type Wire = JsonAgentSessionEvent
type AgentMessage = Extract<Wire, { type: "message_end" }>["message"]
type Assistant = Extract<AgentMessage, { role: "assistant" }>
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>

const AT = 1_700_000_000_000
const USAGE: Assistant["usage"] = {
  input: 120,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 160,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: AT })

const assistant = (
  stopReason: Assistant["stopReason"],
  content: Assistant["content"],
  errorMessage?: string,
): Assistant => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "kimi-coding",
  model: "k3.1-pro",
  usage: USAGE,
  stopReason,
  timestamp: AT + 1,
  ...(errorMessage === undefined ? {} : { errorMessage }),
})

const text = (value: string) => ({ type: "text", text: value }) as const

const toolResult = (toolCallId: string, isError: boolean, output: string): ToolResult => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [text(output)],
  isError,
  timestamp: AT + 2,
})

/** The session header JSON mode prints before the first event. */
const HEADER = {
  type: "session",
  version: 3,
  id: "0198a2b0-0000-7000-8000-000000000001",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/work/project",
} as const

/** A run: `agent_start`, one turn that ends on `last`, `agent_end` and `agent_settled`. */
const finishedRun = (
  last: Assistant,
  settled: { readonly aborted: boolean },
  during: ReadonlyArray<Wire> = [],
): ReadonlyArray<Wire> => [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: user("Review the change.") },
  { type: "message_end", message: user("Review the change.") },
  { type: "message_start", message: assistant("pending", []) },
  ...during,
  { type: "message_end", message: last },
  { type: "turn_end", message: last, toolResults: [] },
  { type: "agent_end", messages: [user("Review the change."), last], willRetry: false },
  { type: "agent_settled", aborted: settled.aborted },
]

const REPORT = "Report: the change is correct; no findings."

/** The fixtures, each the events one Pi surface sends. */
export const FIXTURES: ReadonlyArray<PiFixture> = [
  {
    name: "json-run-ok",
    source: "json-mode",
    description:
      "A specialist run in JSON mode: one tool call, then a final text report, then agent_settled with aborted false.",
    events: [
      HEADER,
      ...([
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_start", message: user("Review the change.") },
        { type: "message_end", message: user("Review the change.") },
        {
          type: "message_update",
          usage: USAGE,
          assistantMessageEvent: {
            type: "toolcall_start",
            contentIndex: 0,
            id: "call-1",
            toolName: "read",
          },
        },
        {
          type: "message_end",
          message: assistant("toolUse", [
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "README.md" },
            },
          ]),
        },
        {
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "read",
          args: { path: "README.md" },
        },
        {
          type: "tool_execution_update",
          toolCallId: "call-1",
          toolName: "read",
          args: { path: "README.md" },
          partialResult: { content: [text("# Hol")] },
        },
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "read",
          result: { content: [text("# HolyAgent")] },
          isError: false,
          durationMs: 3,
        },
        { type: "message_end", message: toolResult("call-1", false, "# HolyAgent") },
        {
          type: "turn_end",
          message: assistant("toolUse", []),
          toolResults: [toolResult("call-1", false, "# HolyAgent")],
        },
        { type: "turn_start" },
        {
          type: "message_update",
          usage: USAGE,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: REPORT },
        },
        { type: "message_end", message: assistant("stop", [text(REPORT)]) },
        { type: "turn_end", message: assistant("stop", [text(REPORT)]), toolResults: [] },
        {
          type: "agent_end",
          messages: [user("Review the change."), assistant("stop", [text(REPORT)])],
          willRetry: false,
        },
        { type: "agent_settled", aborted: false },
      ] satisfies ReadonlyArray<Wire>),
    ],
  },
  {
    name: "json-tool-events",
    source: "json-mode",
    description:
      "Tool execution events: a failed call (isError true) and a call a codemode script made, which carries parentToolCallId.",
    events: [
      ...([
        {
          type: "tool_execution_start",
          toolCallId: "call-2",
          toolName: "codemode",
          args: { code: "await tools.read({ path: 'missing.md' })" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "call-2/1",
          toolName: "read",
          args: { path: "missing.md" },
          parentToolCallId: "call-2",
        },
        {
          type: "tool_execution_end",
          toolCallId: "call-2/1",
          toolName: "read",
          result: { content: [text("ENOENT: missing.md")] },
          isError: true,
          durationMs: 1,
          parentToolCallId: "call-2",
        },
        {
          type: "tool_execution_end",
          toolCallId: "call-2",
          toolName: "codemode",
          result: { content: [text("1 call failed")] },
          isError: false,
          durationMs: 4,
        },
      ] satisfies ReadonlyArray<Wire>),
    ],
  },
  {
    name: "json-run-aborted",
    source: "json-mode",
    description:
      "A run that was aborted (the package's hard abort after the turn limit): the final message stops on aborted and agent_settled has aborted true.",
    events: [
      HEADER,
      ...([
        ...finishedRun(assistant("aborted", [], "Request was aborted"), { aborted: true }),
      ] satisfies ReadonlyArray<Wire>),
    ],
  },
  {
    name: "json-run-error",
    source: "json-mode",
    description:
      "A provider failure: the final message stops on error, auto_retry_end reports failure, and the run still settles with aborted false.",
    events: [
      HEADER,
      ...([
        ...finishedRun(assistant("error", [], "provider overloaded"), { aborted: false }).slice(
          0,
          -1,
        ),
        {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 1,
          delayMs: 2000,
          errorMessage: "provider overloaded",
        },
        { type: "auto_retry_end", success: false, attempt: 1, finalError: "provider overloaded" },
        { type: "agent_settled", aborted: false },
      ] satisfies ReadonlyArray<Wire>),
    ],
  },
  {
    name: "json-run-length",
    source: "json-mode",
    description:
      "A final message cut off at the output token limit: stopReason length with partial text.",
    events: [
      HEADER,
      ...([
        ...finishedRun(assistant("length", [text("Report: the change")]), { aborted: false }),
      ] satisfies ReadonlyArray<Wire>),
    ],
  },
  {
    name: "json-run-empty",
    source: "json-mode",
    description: "A final message that stops normally with no text.",
    events: [
      HEADER,
      ...([
        ...finishedRun(assistant("stop", [{ type: "thinking", thinking: "hm" }]), {
          aborted: false,
        }),
      ] satisfies ReadonlyArray<Wire>),
    ],
  },
  {
    name: "extension-events",
    source: "extension-api",
    description:
      "The events the extension registers handlers for: session_start (every reason), before_agent_start, message_end, tool_call, session_compact and session_shutdown.",
    events: [
      ...(["startup", "reload", "new", "resume", "fork"] as const).map(
        (reason) => ({ type: "session_start", reason }) satisfies SessionStartEvent,
      ),
      {
        type: "before_agent_start",
        messageType: "user",
        prompt: "Review the change.",
        systemPrompt: "Pi's own system prompt.",
      } satisfies Pick<
        BeforeAgentStartUserEvent,
        "type" | "messageType" | "prompt" | "systemPrompt"
      >,
      {
        type: "message_end",
        message: assistant("stop", [text(REPORT)]),
      } satisfies MessageEndEvent,
      { type: "message_end", message: assistant("stop", []) } satisfies MessageEndEvent,
      {
        type: "message_end",
        message: assistant("length", [text("cut")]),
      } satisfies MessageEndEvent,
      {
        type: "tool_call",
        toolCallId: "call-agent-ok",
        toolName: "Agent",
        input: { subagent_type: "reviewer-code", prompt: "Review the change." },
      } satisfies ToolCallEvent,
      {
        type: "tool_call",
        toolCallId: "call-agent-general",
        toolName: "Agent",
        input: { subagent_type: "general-purpose", prompt: "Do anything." },
      } satisfies ToolCallEvent,
      {
        type: "tool_call",
        toolCallId: "call-workflow-ok",
        toolName: "SubagentWorkflow",
        input: {
          script:
            "export const meta = { name: 'w', description: 'd' }\nreturn await agent('review', { agentType: 'reviewer-code' })",
        },
      } satisfies ToolCallEvent,
      {
        type: "tool_call",
        toolCallId: "call-workflow-open",
        toolName: "SubagentWorkflow",
        input: {
          script:
            "export const meta = { name: 'w', description: 'd' }\nreturn await agent('anything', { label: 'x' })",
        },
      } satisfies ToolCallEvent,
      {
        type: "tool_call",
        toolCallId: "call-bash",
        toolName: "bash",
        input: { command: "ls" },
      } satisfies ToolCallEvent,
      {
        type: "session_compact",
        reason: "threshold",
        willRetry: false,
        fromExtension: false,
      } satisfies Pick<SessionCompactEvent, "type" | "reason" | "willRetry" | "fromExtension">,
      { type: "session_shutdown", reason: "quit" } satisfies SessionShutdownEvent,
    ],
  },
  {
    name: "rpc-extension-ui",
    source: "rpc-mode",
    description:
      "The extension_ui_request messages of RPC mode that T3 Code renders: the four dialogs, notify and setStatus.",
    events: [
      {
        type: "extension_ui_request",
        id: "ui-select",
        method: "select",
        title: "Pick a model",
        options: ["k3.1-pro", "k3.1-flash"],
        timeout: 30_000,
      },
      {
        type: "extension_ui_request",
        id: "ui-confirm",
        method: "confirm",
        title: "Allow the write?",
        message: "The specialist wants to write README.md.",
        timeout: 30_000,
      },
      {
        type: "extension_ui_request",
        id: "ui-input",
        method: "input",
        title: "Branch name",
        placeholder: "release/0.3.0/feat/x",
      },
      {
        type: "extension_ui_request",
        id: "ui-editor",
        method: "editor",
        title: "Edit the Intent",
        prefill: "Objective: ",
      },
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
    ] satisfies ReadonlyArray<RpcExtensionUIRequest>,
  },
]

/** The version of the installed Pi host, read from its `package.json`. */
export const installedPiVersion = async (): Promise<string> => {
  const entry = Bun.resolveSync(PI_PACKAGE, FIXTURES_DIRECTORY)
  let directory = dirname(entry)
  while (!(await Bun.file(join(directory, "package.json")).exists())) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`no package.json above ${entry}`)
    directory = parent
  }
  const { version } = (await Bun.file(join(directory, "package.json")).json()) as {
    version: string
  }
  return version
}

/** The text of a fixture file for a Pi version: the header, then one event per line. */
export const renderFixture = (fixture: PiFixture, piVersion: string): string => {
  const header: FixtureHeader = {
    package: PI_PACKAGE,
    piVersion,
    name: fixture.name,
    source: fixture.source,
    description: fixture.description,
  }
  return `${[{ holyagentFixture: header }, ...fixture.events].map((line) => JSON.stringify(line)).join("\n")}\n`
}

if (import.meta.main) {
  const version = await installedPiVersion()
  for (const fixture of FIXTURES)
    await Bun.write(
      join(FIXTURES_DIRECTORY, `${fixture.name}.jsonl`),
      renderFixture(fixture, version),
    )
  console.log(`recorded ${FIXTURES.length} fixtures for ${PI_PACKAGE} ${version}`)
}
