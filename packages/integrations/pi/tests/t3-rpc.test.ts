import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Effect, Schema } from "effect"

import { defaultConfig } from "../../../runtime/src/config/schema.ts"
import { PI_PROJECT_FLAG } from "../../../runtime/src/hooks/pi-project.ts"
import { routedModels } from "../../../runtime/src/pi/provider.ts"
import { createExtension } from "../src/extension.ts"
import { DIST_DIRECTORY, REPOSITORY } from "../src/files.ts"
import { installedPiVersion, PI_PACKAGE } from "./fixtures/record.ts"
import {
  renderT3Fixture,
  T3_FIXTURES,
  T3_FIXTURES_DIRECTORY,
  T3_RERECORD_COMMAND,
  T3FixtureHeader,
} from "./fixtures/t3/record.ts"

// The fixtures in fixtures/t3 are synthesized T3 Code traffic for `pi --mode rpc`, built from the
// pinned Pi host's types (see fixtures/t3/record.ts). The tests below use them two ways. The
// extension tests run the real HolyAgent extension (createExtension) in RPC mode with the T3
// environment, feed it the session events of the fixtures and record which `ctx.ui` members it
// touches; that is the one check here that exercises extension code. The others pin the shape of
// the fixtures themselves (header, staleness, launch, message shapes) and are not evidence about
// the extension. The late-completion fixture documents an assumed turn behaviour and proves
// nothing: that needs @tintinweb/pi-subagents and T3 Code. Nothing starts Pi or T3.

const HeaderLine = Schema.fromJsonString(Schema.Struct({ holyagentFixture: T3FixtureHeader }))

/** A fixture file read back: its header and its lines. */
interface Loaded {
  readonly header: T3FixtureHeader
  readonly events: ReadonlyArray<Record<string, unknown>>
}

const fixturePath = (name: string) => join(T3_FIXTURES_DIRECTORY, `${name}.jsonl`)

const load = async (name: string): Promise<Loaded> => {
  const [first = "", ...rest] = (await Bun.file(fixturePath(name)).text()).split("\n")
  const { holyagentFixture } = await Effect.runPromise(
    Schema.decodeUnknownEffect(HeaderLine)(first, { onExcessProperty: "error" }),
  )
  return {
    header: holyagentFixture,
    events: rest
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

const loadAll = async (): Promise<ReadonlyArray<Loaded>> =>
  Promise.all(T3_FIXTURES.map(({ name }) => load(name)))

/**
 * The failure message of a fixture built for another Pi than the installed one, or undefined when
 * they agree.
 */
const staleMessage = (header: T3FixtureHeader, installed: string): string | undefined =>
  header.piVersion === installed && header.package === PI_PACKAGE
    ? undefined
    : `T3 fixture ${header.name} was built for ${header.package} ${header.piVersion}, but ${PI_PACKAGE} ${installed} is installed. Pi's RPC traffic may have changed: re-record the fixtures with \`${T3_RERECORD_COMMAND}\`, review the diff of packages/integrations/pi/tests/fixtures/t3, and commit it (docs/development.md, Re-recording the Pi fixtures).`

describe("the T3 fixtures", () => {
  test("every fixture is marked synthesized, with its sources, for the installed Pi host", async () => {
    const installed = await installedPiVersion()
    for (const { header } of await loadAll()) {
      expect(header.synthesized).toBe(true)
      expect(header.source).toBe("rpc-mode")
      expect(header.description).toStartWith("Synthesized:")
      expect(header.sources.length).toBeGreaterThan(0)
      expect(staleMessage(header, installed)).toBeUndefined()
    }
  })

  test("a fixture of another Pi version is reported with how to re-record it", async () => {
    const { header } = await load("t3-session-start")
    const message = staleMessage(header, "99.0.0")
    expect(message).toContain(T3_RERECORD_COMMAND)
    expect(message).toContain(header.piVersion)
    expect(message).toContain("99.0.0")
  })

  test("the files are what record.ts writes, so none was edited by hand", async () => {
    for (const fixture of T3_FIXTURES) {
      const { header } = await load(fixture.name)
      expect(await Bun.file(fixturePath(fixture.name)).text()).toBe(
        renderT3Fixture(fixture, header.piVersion),
      )
    }
    const files = [...new Bun.Glob("*.jsonl").scanSync(T3_FIXTURES_DIRECTORY)].toSorted()
    expect(files).toEqual(T3_FIXTURES.map(({ name }) => `${name}.jsonl`).toSorted())
  })
})

describe("a T3 RPC session start", () => {
  test("T3 launches Pi in RPC mode, names its mode in T3_PI_RUNTIME_MODE and injects its bridge", async () => {
    const { events } = await load("t3-session-start")
    const launch = events.find((event) => event["type"] === "t3_launch") as
      { args: Array<string>; env: Record<string, string> } | undefined
    expect(launch).toBeDefined()
    expect(launch?.args.slice(0, 2)).toEqual(["--mode", "rpc"])
    expect(launch?.args).not.toContain("--no-extensions")
    const extension = launch?.args[launch.args.indexOf("--extension") + 1]
    expect(launch?.env["T3_PI_MCP_EXTENSION_PATH"]).toBe(extension)
    expect(["approval-required", "auto-accept-edits", "full-access"]).toContain(
      launch?.env["T3_PI_RUNTIME_MODE"] ?? "",
    )
    expect(launch?.env["T3_MCP_URL"]).toStartWith("http://127.0.0.1:")
    // The bearer token is a secret: no fixture carries it.
    expect(Object.keys(launch?.env ?? {})).not.toContain("T3_MCP_BEARER_TOKEN")
  })

  test("the extension's session_start follows the launch, and the first prompt is accepted by the same id", async () => {
    const { events } = await load("t3-session-start")
    expect(events.map((event) => event["type"])).toEqual([
      "t3_launch",
      "session_start",
      "prompt",
      "response",
    ])
    expect(events[1]).toEqual({ type: "session_start", reason: "startup" })
    const [prompt, response] = [events[2], events[3]]
    expect(typeof prompt?.["id"]).toBe("string")
    expect(response).toMatchObject({
      id: prompt?.["id"],
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    })
  })
})

// ---- extension_ui_request: only what T3 Code renders ---------------------------------------------

/** The dialogs T3 turns into composer requests: they wait for an extension_ui_response. */
const DIALOGS = ["select", "confirm", "input", "editor"] as const
/** The methods T3 renders without a response: a work-log notice and the composer status. */
const NOTICES = ["notify", "setStatus"] as const
/** What T3 renders, and so all the integration may use of `ctx.ui`. */
const RENDERED: ReadonlyArray<string> = [...DIALOGS, ...NOTICES]
/**
 * The `ctx.ui` members T3 does not render: RPC mode drops or no-ops them (`custom` resolves with
 * undefined and sends nothing).
 */
const IGNORED = [
  "custom",
  "setWidget",
  "setFooter",
  "setHeader",
  "setTitle",
  "setTheme",
  "setEditorText",
] as const

describe("the extension_ui_request messages in the fixtures", () => {
  test("the six rendered methods are all covered, each with a unique id", async () => {
    const { events } = await load("t3-ui-dialogs")
    const requests = events.filter((event) => event["type"] === "extension_ui_request")
    expect(requests.map((event) => event["method"])).toEqual([...DIALOGS, ...NOTICES])
    expect(new Set(requests.map((event) => event["id"])).size).toBe(requests.length)
  })

  test("each dialog gets one response by its id, in the shape Pi reads for that method", async () => {
    const { events } = await load("t3-ui-dialogs")
    const responses = events.filter((event) => event["type"] === "extension_ui_response")
    expect(responses.map((event) => event["id"])).toEqual(DIALOGS.map((method) => `ui-${method}`))
    for (const request of events.filter((event) => event["type"] === "extension_ui_request")) {
      const method = String(request["method"])
      const matching = responses.filter((response) => response["id"] === request["id"])
      if (NOTICES.some((notice) => notice === method)) {
        expect(matching).toEqual([])
        continue
      }
      expect(matching).toHaveLength(1)
      const [response = {}] = matching
      if (response["cancelled"] === true) continue
      expect(Object.keys(response).toSorted()).toEqual(
        method === "confirm" ? ["confirmed", "id", "type"] : ["id", "type", "value"],
      )
      if (method === "confirm") expect(typeof response["confirmed"]).toBe("boolean")
      else expect(typeof response["value"]).toBe("string")
      if (method === "select") expect(request["options"]).toContain(response["value"])
    }
  })

  test("the request fields T3 reads are present for each method", async () => {
    const { events } = await load("t3-ui-dialogs")
    const by = Object.fromEntries(
      events
        .filter((event) => event["type"] === "extension_ui_request")
        .map((event) => [String(event["method"]), event]),
    )
    for (const method of ["select", "confirm", "input", "editor"])
      expect(typeof by[method]?.["title"]).toBe("string")
    expect(by["select"]?.["options"]).toEqual(expect.arrayContaining([expect.any(String)]))
    expect(typeof by["confirm"]?.["message"]).toBe("string")
    expect(typeof by["notify"]?.["message"]).toBe("string")
    expect(["info", "warning", "error"]).toContain(String(by["notify"]?.["notifyType"]))
    expect(typeof by["setStatus"]?.["statusKey"]).toBe("string")
    expect(typeof by["setStatus"]?.["statusText"]).toBe("string")
  })
})

// ---- the real extension under T3 Code ------------------------------------------------------------

/** The commands `pi --list-models` and `pi auth` answer for a provider that is ready. */
const DEFAULTS = await Effect.runPromise(defaultConfig)
const CATALOG = [
  "provider     model   context  max-out  thinking  images",
  ...routedModels(DEFAULTS).map(
    ({ provider, model }) => `${provider}  ${model}  256K  32K  yes  no`,
  ),
].join("\n")
const STATUS =
  "intents[1]{id,revision,objective,running,unaccepted}:\n  intent-a,1,Ship the thing,0,0\n"
const RECONCILE =
  "running[1]{id,role,agent,startedAt}:\n  assignment-1,Worker.implementation,agent-1,null\n"
const PACKAGE_ROOT = join(REPOSITORY, DIST_DIRECTORY)
const BUN = join("/stub/bin", "bun")
const SESSION_CWD = "/work/project/src"
/** The T3 tools the root keeps and the ones it drops, so the extension's T3 handling has work to do. */
const T3_TOOLS = ["mcp__t3-code__html_render", "mcp__t3-code__delegate_task"] as const

/** What the commands the extension starts answer: a healthy install with a ready provider. */
const answer = (command: string, args: ReadonlyArray<string>): Partial<ExecResult> => {
  if (command === "pi") return args[0] === "auth" ? {} : { stdout: `${CATALOG}\n` }
  if (command === "git") return { stdout: "/work/project\n" }
  const at = args.indexOf(PI_PROJECT_FLAG)
  switch (at === -1 ? undefined : args[at + 2]) {
    case "config":
      return { stdout: `${JSON.stringify(DEFAULTS)}\n` }
    case "status":
      return { stdout: STATUS }
    case "reconcile":
      return { stdout: RECONCILE }
    case "state":
      return { stdout: "mode: work\nconfigured: true\ndirectory: /missing\n" }
    default:
      return { code: 2, stderr: "error: Usage: unexpected\n" }
  }
}

/** One call the extension made on `ctx.ui`. */
interface UiCall {
  readonly method: string
  readonly args: ReadonlyArray<unknown>
}

/**
 * A `ctx.ui` that records every member read from it, through any alias or destructuring (all of
 * them go through the proxy), and every call made on it.
 */
const recordingUi = () => {
  const accessed: Array<string> = []
  const calls: Array<UiCall> = []
  const ui = new Proxy(
    {},
    {
      get: (_target, key) => {
        accessed.push(String(key))
        return (...args: Array<unknown>) => void calls.push({ method: String(key), args })
      },
      has: (_target, key) => {
        accessed.push(String(key))
        return true
      },
    },
  )
  return { ui, accessed, calls }
}

/** The members of `ctx.ui` in a list that T3 does not render. */
const unrendered = (accessed: ReadonlyArray<string>): ReadonlyArray<string> =>
  accessed.filter((member) => !RENDERED.includes(member))

type Emitted = readonly [event: string, payload: object]

/** What an extension handler is: Pi hands it the event and the context. */
type Handler = (event: object, ctx: ExtensionContext) => unknown

/**
 * Starts the real extension on a fake Pi API in RPC mode with the given environment, emits the
 * events in order (a handler's rejection fails the test), and returns what it did to `ctx.ui`.
 * `plant` registers more handlers on the same API, to prove the recording catches a stray call.
 */
const drive = async (
  env: Record<string, string | undefined>,
  events: ReadonlyArray<Emitted>,
  plant?: (pi: ExtensionAPI) => void,
) => {
  const handlers = new Map<string, Array<Handler>>()
  const touched: Array<string> = []
  const recorded = recordingUi()
  const active = ["read", "bash", "write", "edit", ...T3_TOOLS]
  const pi = {
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerToolRenderer: () => undefined,
    getSessionName: () => undefined,
    getActiveTools: () => [...active],
    getAllTools: () => active.map((name) => ({ name })),
    setActiveTools: (names: ReadonlyArray<string>) =>
      void active.splice(0, active.length, ...names),
    sendMessage: () => undefined,
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => undefined
    },
    exec: (command: string, args: Array<string>): Promise<ExecResult> =>
      Promise.resolve({
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
        truncated: false,
        ...answer(command, args),
      }),
  } as unknown as ExtensionAPI
  createExtension({
    packageRoot: PACKAGE_ROOT,
    env,
    platform: "linux",
    bunSearch: {
      env: { PATH: "/stub/bin" },
      exists: (path) => path === BUN,
      executable: () => true,
    },
  })(pi)
  plant?.(pi)
  // Any member of the context but cwd, mode and ui fails the test, as in extension.test.ts.
  const ctx = new Proxy(
    { cwd: SESSION_CWD },
    {
      get: (target, key) => {
        if (key === "cwd") return target.cwd
        if (key === "mode") return "rpc"
        if (key === "ui") return recorded.ui
        touched.push(String(key))
        throw new Error(`the extension used ctx.${String(key)}`)
      },
    },
  ) as unknown as ExtensionContext
  for (const [event, payload] of events)
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx)
  return { ...recorded, touched, registered: [...handlers.keys()] }
}

/**
 * The extension events a fixture's session produces in Pi: its `session_start` (one is added at the
 * front when the fixture has none), `before_agent_start` for each prompt and each started turn, and
 * then the events a T3 session goes on to produce whatever the fixture shows: the session tree
 * changing, tool calls, a compaction and the shutdown.
 */
const extensionEvents = (
  events: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Emitted> => {
  const fromFixture = events.flatMap((event): ReadonlyArray<Emitted> => {
    switch (event["type"]) {
      case "session_start":
        return [["session_start", { reason: String(event["reason"]) }]]
      case "prompt":
        return [["before_agent_start", { prompt: String(event["message"]), systemPrompt: "p" }]]
      case "agent_start":
        return [["before_agent_start", { prompt: "turn", systemPrompt: "p" }]]
      default:
        return []
    }
  })
  const started = events.some((event) => event["type"] === "session_start")
  return [
    ...(started ? [] : [["session_start", { reason: "startup" }] as const]),
    ...fromFixture,
    ["session_tree", {}],
    ...T3_TOOLS.map((toolName): Emitted => [
      "tool_call",
      { toolName, toolCallId: "c/1", input: {} },
    ]),
    ["session_compact", { reason: "manual" }],
    ["before_agent_start", { prompt: "after compaction", systemPrompt: "p" }],
    ["session_shutdown", {}],
  ]
}

const MODES = ["full-access", "approval-required", "auto-accept-edits"] as const

describe("the extension under T3 Code in RPC mode", () => {
  test("it touches only the ctx.ui members T3 renders, in every access mode and every fixture session", async () => {
    const { events: launchEvents } = await load("t3-session-start")
    const launch = launchEvents.find((event) => event["type"] === "t3_launch") as
      { env: Record<string, string> } | undefined
    expect(launch?.env["T3_MCP_URL"]).toBeString()
    const { events: dialogs } = await load("t3-ui-dialogs")
    const statusKey = dialogs.find((event) => event["method"] === "setStatus")?.["statusKey"]
    expect(statusKey).toBeString()

    for (const { header, events } of await loadAll())
      for (const mode of MODES) {
        const label = `${header.name} at ${mode}`
        const { accessed, calls, touched, registered } = await drive(
          { ...launch?.env, T3_PI_RUNTIME_MODE: mode },
          extensionEvents(events),
        )
        // The extension ran: it registered its handlers on the session events it was fed.
        for (const event of ["session_start", "before_agent_start", "tool_call", "session_compact"])
          expect([label, registered.includes(event)]).toEqual([label, true])
        expect([label, unrendered(accessed)]).toEqual([label, []])
        expect([
          label,
          accessed.filter((member) => IGNORED.some((name) => name === member)),
        ]).toEqual([label, []])
        expect([label, touched]).toEqual([label, []])
        // Below Full access the one UI call is the status T3 shows near the composer, with the key
        // the fixture's setStatus request uses; at Full access there is none.
        expect([label, calls]).toEqual([
          label,
          mode === "full-access"
            ? []
            : [{ method: "setStatus", args: [statusKey, expect.any(String)] }],
        ])
      }
  })

  test("a stray ctx.ui call is caught, direct, through an alias or after destructuring ctx", async () => {
    const { events } = await load("t3-session-start")
    const planted = await drive(
      { T3_PI_RUNTIME_MODE: "approval-required", T3_MCP_URL: "http://127.0.0.1:1/mcp" },
      extensionEvents(events),
      (pi) => {
        pi.on("session_start", (_event, ctx) => {
          const { ui } = ctx
          ui.setWidget("holyagent", ["running"])
        })
        pi.on("session_tree", (_event, ctx) => {
          const alias = ctx.ui
          const again = alias
          void again.custom(() => ({ render: () => [], invalidate: () => undefined }))
        })
        pi.on("session_compact", (_event, ctx) => {
          ctx.ui.setTitle("holyagent")
        })
      },
    )
    expect(unrendered(planted.accessed)).toEqual(["setWidget", "custom", "setTitle"])
    expect(planted.calls.map(({ method }) => method)).toEqual([
      "setStatus",
      "setWidget",
      "custom",
      "setTitle",
    ])
  })
})

// ---- a completion after agent_settled: documentation, not a regression test ----------------------

/** One root turn as T3 sees it: from `agent_start` to `agent_settled`. */
interface Turn {
  /** The `role` of the first message of the turn, which is what started it. */
  readonly openedBy: string | undefined
  /** The `customType` of that first message, when it is a custom one. */
  readonly customType: string | undefined
  /** The index of the turn's `agent_start` in the replay. */
  readonly startedAt: number
  /** The index of its `agent_settled`, or undefined while it is open. */
  readonly settledAt: number | undefined
}

/**
 * The root turns of an RPC stream the way T3 Code is assumed to track them: a turn opens on
 * `agent_start` and is done on `agent_settled`. Used only to read the fixture, which is written to
 * be well-formed; it is not under test.
 */
const turnsOf = (events: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<Turn> => {
  const turns: Array<Turn> = []
  let open: Turn | undefined
  let opened = false
  events.forEach((event, index) => {
    const type = String(event["type"])
    if (type === "agent_start") {
      open = { openedBy: undefined, customType: undefined, startedAt: index, settledAt: undefined }
      opened = false
    } else if (type === "agent_settled") {
      if (open !== undefined) turns.push({ ...open, settledAt: index })
      open = undefined
    } else if (type === "message_start" && !opened && open !== undefined) {
      const message = event["message"] as { role?: string; customType?: string } | undefined
      open = { ...open, openedBy: message?.role, customType: message?.customType }
      opened = true
    }
  })
  return turns
}

// The fixture records what the docs assume: that @tintinweb/pi-subagents' completion notice starts
// a new root turn after the first one settled, and that T3 Code treats `agent_settled` as the end
// of a turn. Neither the package nor T3 runs here, so the tests read the fixture back and prove
// nothing about the extension, the package or T3; a change in either would not fail them.
describe("the documented assumption of a specialist completion after agent_settled", () => {
  test("the fixture records a second root turn that the notice opens after the first settled", async () => {
    const { events } = await load("t3-late-completion")
    const turns = turnsOf(events)
    expect(turns).toHaveLength(2)
    const [first, second] = turns
    expect(first?.openedBy).toBe("user")
    expect(second?.startedAt).toBeGreaterThan(first?.settledAt ?? Number.POSITIVE_INFINITY)
    expect(second?.openedBy).toBe("custom")
    expect(second?.customType).toBeString()
    expect(second?.settledAt).toBe(events.length - 1)
  })

  test("the fixture's notice carries the specialist's report and is shown, and the new turn answers it", async () => {
    const { events } = await load("t3-late-completion")
    const notice = events.flatMap((event) => {
      const message = event["message"] as
        { role?: string; content?: string; display?: boolean } | undefined
      return event["type"] === "message_end" && message?.role === "custom" ? [message] : []
    })
    expect(notice).toHaveLength(1)
    expect(notice[0]?.display).toBe(true)
    expect(notice[0]?.content).toContain("Report:")
    const afterNotice = events.slice(
      events.findIndex(
        (event) =>
          event["type"] === "message_end" &&
          (event["message"] as { role?: string }).role === "custom",
      ),
    )
    expect(
      afterNotice.some(
        (event) =>
          event["type"] === "message_end" &&
          (event["message"] as { role?: string }).role === "assistant",
      ),
    ).toBe(true)
  })
})
