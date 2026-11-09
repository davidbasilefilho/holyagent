import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { Effect, Schema } from "effect"

import { installedPiVersion, PI_PACKAGE } from "./fixtures/record.ts"
import {
  renderT3Fixture,
  T3_FIXTURES,
  T3_FIXTURES_DIRECTORY,
  T3_RERECORD_COMMAND,
  T3FixtureHeader,
} from "./fixtures/t3/record.ts"

// These tests replay the synthesized traffic of T3 Code driving `pi --mode rpc` (see
// fixtures/t3/record.ts) against the pinned Pi host's types. They pin what the integration relies
// on under T3: the launch marker, the extension_ui_request methods T3 renders and no others, the
// responses T3 sends, and a specialist's completion after `agent_settled` starting a new root
// turn. Nothing starts Pi or T3.

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
/** What T3 renders, and so all the integration may send. */
const RENDERED: ReadonlyArray<string> = [...DIALOGS, ...NOTICES]

/**
 * The first problem of an extension_ui_request in a replay, or undefined when it uses a method T3
 * renders. `setWidget`, `setTitle` and `set_editor_text` are RPC methods T3 ignores, and `custom`
 * is not an RPC method (Pi resolves it with undefined and sends nothing).
 */
const uiProblem = (event: Record<string, unknown>): string | undefined =>
  event["type"] !== "extension_ui_request" || RENDERED.includes(String(event["method"]))
    ? undefined
    : `extension_ui_request ${String(event["id"])} uses ${String(event["method"])}, which T3 Code does not render`

describe("the extension_ui_request messages under T3 Code", () => {
  test("every message in every fixture uses a method T3 renders", async () => {
    for (const { header, events } of await loadAll())
      for (const event of events)
        expect([header.name, uiProblem(event)]).toEqual([header.name, undefined])
  })

  test("the six rendered methods are all covered, each with a unique id", async () => {
    const { events } = await load("t3-ui-dialogs")
    const requests = events.filter((event) => event["type"] === "extension_ui_request")
    expect(requests.map((event) => event["method"])).toEqual([...DIALOGS, ...NOTICES])
    expect(new Set(requests.map((event) => event["id"])).size).toBe(requests.length)
  })

  test("a method T3 ignores, or custom, fails the check", () => {
    for (const method of ["setWidget", "setTitle", "set_editor_text", "custom", "setHeader"])
      expect(uiProblem({ type: "extension_ui_request", id: "ui-x", method })).toContain(method)
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

  test("the extension's source calls only ctx.ui methods T3 renders", async () => {
    const sources = [...new Bun.Glob("*.ts").scanSync(join(import.meta.dir, "..", "src"))]
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      const source = await Bun.file(join(import.meta.dir, "..", "src", file)).text()
      const called = [...source.matchAll(/\bui\s*\.\s*(\w+)/g)].map((match) => match[1] ?? "")
      expect([file, called.filter((method) => !RENDERED.includes(method))]).toEqual([file, []])
    }
  })
})

// ---- a completion after agent_settled ------------------------------------------------------------

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
 * The root turns of an RPC stream the way T3 Code tracks them: a turn opens on `agent_start` and is
 * done on `agent_settled`. A message outside a turn, or a turn that opens inside another, is a
 * problem: T3 would not show the first, and would merge the second.
 */
const turnsOf = (
  events: ReadonlyArray<Record<string, unknown>>,
): { readonly turns: ReadonlyArray<Turn>; readonly problems: ReadonlyArray<string> } => {
  const turns: Array<Turn> = []
  const problems: Array<string> = []
  let open: Turn | undefined
  let opened = false
  events.forEach((event, index) => {
    const type = String(event["type"])
    if (type === "agent_start") {
      if (open !== undefined) problems.push(`agent_start at ${index} inside an open turn`)
      open = { openedBy: undefined, customType: undefined, startedAt: index, settledAt: undefined }
      opened = false
    } else if (type === "agent_settled") {
      if (open === undefined) problems.push(`agent_settled at ${index} with no open turn`)
      else turns.push({ ...open, settledAt: index })
      open = undefined
    } else if (type === "message_start" && !opened) {
      const message = event["message"] as { role?: string; customType?: string } | undefined
      if (open === undefined) problems.push(`message_start at ${index} outside a root turn`)
      else open = { ...open, openedBy: message?.role, customType: message?.customType }
      opened = true
    } else if (type === "message_start" && open === undefined) {
      problems.push(`message_start at ${index} outside a root turn`)
    }
  })
  if (open !== undefined) problems.push("a turn never settled")
  return { turns, problems }
}

describe("a specialist completion after agent_settled", () => {
  test("starts a new root turn that the first turn's settle did not end early", async () => {
    const { events } = await load("t3-late-completion")
    const { turns, problems } = turnsOf(events)
    expect(problems).toEqual([])
    expect(turns).toHaveLength(2)
    const [first, second] = turns
    expect(first?.openedBy).toBe("user")
    // The notice arrives after the first turn settled, and opens the second turn.
    expect(second?.startedAt).toBeGreaterThan(first?.settledAt ?? Number.POSITIVE_INFINITY)
    expect(second?.openedBy).toBe("custom")
    expect(second?.customType).toBeString()
    expect(second?.settledAt).toBe(events.length - 1)
  })

  test("the notice carries the specialist's report and is shown, and the new turn answers it", async () => {
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

  test("without the new turn the notice would sit outside any turn, which the check reports", async () => {
    const { events } = await load("t3-late-completion")
    const second = events.findLastIndex((event) => event["type"] === "agent_start")
    const withoutStart = events.filter((_event, index) => index !== second)
    const { problems } = turnsOf(withoutStart)
    expect(problems.length).toBeGreaterThan(0)
  })

  test("a turn that never settles is reported", async () => {
    const { events } = await load("t3-late-completion")
    expect(turnsOf(events.slice(0, -1)).problems).toContain("a turn never settled")
  })
})
