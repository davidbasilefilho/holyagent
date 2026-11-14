import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Effect, Schema } from "effect"

import { defaultConfig } from "../../../runtime/src/config/schema.ts"
import { parseOutput } from "../../../runtime/src/hooks/pi-context.ts"
import { PI_PROJECT_FLAG } from "../../../runtime/src/hooks/pi-project.ts"
import { assignmentStatusOf, type PiOutcome } from "../../../runtime/src/pi/journal.ts"
import { routedModels } from "../../../runtime/src/pi/provider.ts"
import {
  type BunSearch,
  CONTEXT_MESSAGE,
  createExtension,
  CUT_OFF_REPORT,
  EMPTY_REPORT,
  failedFinalMessage,
  runtimeArgs,
} from "../src/extension.ts"
import { DIST_DIRECTORY, REPOSITORY } from "../src/files.ts"
import {
  FixtureHeader,
  FIXTURES,
  FIXTURES_DIRECTORY,
  installedPiVersion,
  PI_PACKAGE,
  renderFixture,
  RERECORD_COMMAND,
} from "./fixtures/record.ts"
import { removeTemporary } from "./temp-folder.ts"

// These tests pin the Pi events the integration consumes to the Pi version the fixtures were
// built for. The fixtures come from Pi's exported types (see fixtures/record.ts), not from a Pi
// run. The extension events run through the extension's handlers and the outcome helpers, the
// JSON run streams through a reader local to this file (the real one lives in
// @tintinweb/pi-subagents), and the extension_ui_request messages are pinned by type only. A Pi
// update that moves the version fails the first describe until the fixtures are built again.

const FixtureHeaderLine = Schema.fromJsonString(Schema.Struct({ holyagentFixture: FixtureHeader }))

/** A fixture file read back: its header and its events. */
interface Loaded {
  readonly header: FixtureHeader
  readonly events: ReadonlyArray<Record<string, unknown>>
}

const fixturePath = (name: string) => join(FIXTURES_DIRECTORY, `${name}.jsonl`)

const load = async (name: string): Promise<Loaded> => {
  const [first = "", ...rest] = (await Bun.file(fixturePath(name)).text()).split("\n")
  const { holyagentFixture } = await Effect.runPromise(
    Schema.decodeUnknownEffect(FixtureHeaderLine)(first, { onExcessProperty: "error" }),
  )
  return {
    header: holyagentFixture,
    events: rest
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

/**
 * The failure message of a fixture recorded for another Pi than the installed one, or undefined
 * when they agree.
 */
const staleMessage = (header: FixtureHeader, installed: string): string | undefined =>
  header.piVersion === installed && header.package === PI_PACKAGE
    ? undefined
    : `fixture ${header.name} was recorded for ${header.package} ${header.piVersion}, but ${PI_PACKAGE} ${installed} is installed. Pi's events may have changed: re-record the fixtures with \`${RERECORD_COMMAND}\`, review the diff of packages/integrations/pi/tests/fixtures, and commit it (docs/development.md, Re-recording the Pi fixtures).`

describe("the recorded Pi version", () => {
  test("every fixture was recorded for the installed Pi host", async () => {
    const installed = await installedPiVersion()
    for (const { name } of FIXTURES)
      expect(staleMessage((await load(name)).header, installed)).toBeUndefined()
  })

  test("a fixture of another Pi version is reported with how to re-record it", async () => {
    const { header } = await load("json-run-ok")
    const message = staleMessage(header, "99.0.0")
    expect(message).toContain("re-record")
    expect(message).toContain(RERECORD_COMMAND)
    expect(message).toContain(`${header.piVersion}`)
    expect(message).toContain("99.0.0")
    expect(staleMessage({ ...header, piVersion: "0.1.0" }, header.piVersion)).toContain("re-record")
  })

  test("the files are what record.ts writes, so none was edited by hand", async () => {
    for (const fixture of FIXTURES) {
      const { header } = await load(fixture.name)
      expect(await Bun.file(fixturePath(fixture.name)).text()).toBe(
        renderFixture(fixture, header.piVersion),
      )
    }
    // Every file in the folder is one record.ts writes.
    const files = [...new Bun.Glob("*.jsonl").scanSync(FIXTURES_DIRECTORY)].toSorted()
    expect(files).toEqual(FIXTURES.map(({ name }) => `${name}.jsonl`).toSorted())
  })
})

// ---- the extension, on a stub of Pi's API ------------------------------------------------------

const PACKAGE_ROOT = join(REPOSITORY, DIST_DIRECTORY)
// What the extension starts Bun with: the bundled CLI, never the `sh` wrapper.
const RUNTIME = runtimeArgs(PACKAGE_ROOT)
// A machine with Bun on its PATH: the program the extension starts is the full path it found,
// joined with the test process's own path module (a `\` on Windows), so the stub's is too.
const BUN = join("/stub/bin", "bun")
const BUN_SEARCH: BunSearch = {
  env: { PATH: "/stub/bin" },
  exists: (path) => path === BUN,
  executable: () => true,
}
const DEFAULTS = await Effect.runPromise(defaultConfig)
const CATALOG = [
  "provider     model   context  max-out  thinking  images",
  ...routedModels(DEFAULTS).map(
    ({ provider, model }) => `${provider}  ${model}  256K  32K  yes  no`,
  ),
].join("\n")

/** The holyagent subcommands the extension ran, in order. */
type Ran = Array<string>

/** An extension on a stub Pi API that answers the wrapper's commands as a healthy install does. */
const start = (directory: string, sessionName?: string, cwd = "/work/project/src") => {
  const ran: Ran = []
  const handlers = new Map<string, Array<(event: object, ctx: ExtensionContext) => unknown>>()
  const answer = (command: string, args: ReadonlyArray<string>): Partial<ExecResult> => {
    if (command === "git") return { stdout: "/work/project\n" }
    if (command === "pi") return args[0] === "auth" ? { code: 0 } : { stdout: `${CATALOG}\n` }
    if (command !== BUN || args[0] !== "--no-env-file" || args[RUNTIME.length] !== PI_PROJECT_FLAG)
      return { code: 2 }
    const [subcommand = ""] = args.slice(RUNTIME.length + 2)
    ran.push(subcommand)
    switch (subcommand) {
      case "config":
        return { stdout: `${JSON.stringify(DEFAULTS)}\n` }
      case "status":
        return {
          stdout:
            "intents[1]{id,revision,objective,running,unaccepted}:\n  intent-a,1,Ship the thing,0,0\n",
        }
      case "reconcile":
        return {
          stdout:
            "running[1]{id,role,agent,startedAt}:\n  assignment-1,Worker.implementation,agent-1,null\n",
        }
      case "state":
        return { stdout: `mode: work\nconfigured: true\ndirectory: ${directory}\n` }
      default:
        return { code: 2, stderr: "error: Usage: unexpected\n" }
    }
  }
  const api = {
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerToolRenderer: () => undefined,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    getSessionName: () => sessionName,
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => undefined,
    on: (event: string, handler: (event: object, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => undefined
    },
    sendMessage: () => undefined,
    exec: (command: string, args: Array<string>): Promise<ExecResult> =>
      Promise.resolve({
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
        truncated: false,
        ...answer(command, args),
      }),
  }
  // Only `cwd` of the context is read; any other member, the TUI's `ui` included, fails the test.
  const context = new Proxy(
    { cwd },
    {
      get: (target, key) => {
        if (key === "cwd") return target.cwd
        // The auto-review gate reads the active model's provider; no model keeps it inert.
        if (key === "model") return undefined
        throw new Error(`the extension used ctx.${String(key)}`)
      },
    },
  ) as unknown as ExtensionContext
  // A POSIX machine, whatever the platform the tests run on.
  createExtension({
    packageRoot: PACKAGE_ROOT,
    env: { HOME: cwd },
    platform: "linux",
    bunSearch: BUN_SEARCH,
    coreServices: {
      config: () => Effect.succeed(DEFAULTS),
      directory: () => Effect.succeed(directory),
      status: () => {
        ran.push("status")
        return parseOutput(
          "status",
          "intents[1]{id,revision,objective,running,unaccepted}:\n  intent-a,1,Ship the thing,0,0\n",
        )
      },
      reconcile: () => {
        ran.push("reconcile")
        return parseOutput(
          "reconcile",
          "running[1]{id,role,agent,startedAt}:\n  assignment-1,Worker.implementation,agent-1,null\n",
        )
      },
    },
  })(api as unknown as ExtensionAPI)
  /** Delivers a fixture event to the handlers registered for its type; the results are returned. */
  const deliver = async (event: Record<string, unknown>): Promise<Array<unknown>> => {
    const results: Array<unknown> = []
    for (const handler of handlers.get(String(event["type"])) ?? [])
      results.push(await handler(event, context))
    return results
  }
  return { ran, deliver }
}

const withDirectory = async <A>(use: (directory: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-contract-"))
  try {
    return await use(directory)
  } finally {
    await removeTemporary(directory)
  }
}

const ofType = (events: Loaded["events"], type: string) =>
  events.filter((event) => event["type"] === type)

describe("the extension's handlers on the recorded extension events", () => {
  test("session_start runs status for every reason, and reconcile only after a resume", async () => {
    const { events } = await load("extension-events")
    const starts = ofType(events, "session_start")
    expect(starts.map((event) => event["reason"])).toEqual([
      "startup",
      "reload",
      "new",
      "resume",
      "fork",
    ])
    await withDirectory(async (directory) => {
      for (const event of starts) {
        const { ran, deliver } = start(directory)
        await deliver(event)
        expect(ran).toContain("status")
        expect(ran.includes("reconcile")).toBe(event["reason"] === "resume")
      }
    })
  })

  test("before_agent_start delivers the status once, and the system prompt keeps Pi's own", async () => {
    const { events } = await load("extension-events")
    const [before] = ofType(events, "before_agent_start")
    await withDirectory(async (directory) => {
      const { deliver } = start(directory)
      await deliver({ type: "session_start", reason: "startup" })
      const [first] = (await deliver(before ?? {})) as Array<
        { message?: { customType: string; content: string }; systemPrompt?: string } | undefined
      >
      expect(first?.message?.customType).toBe(CONTEXT_MESSAGE)
      expect(first?.message?.content).toContain("Ship the thing")
      expect(first?.systemPrompt).toContain(String(before?.["systemPrompt"]))
      const [second] = (await deliver(before ?? {})) as Array<{ message?: unknown } | undefined>
      expect(second?.message).toBeUndefined()
    })
  })

  test("session_compact collects the status again, and session_shutdown settles", async () => {
    const { events } = await load("extension-events")
    const [compact] = ofType(events, "session_compact")
    const [shutdown] = ofType(events, "session_shutdown")
    await withDirectory(async (directory) => {
      const { ran, deliver } = start(directory)
      await deliver({ type: "session_start", reason: "startup" })
      await deliver({ type: "before_agent_start", prompt: "first", systemPrompt: "p" })
      ran.length = 0
      await deliver(compact ?? {})
      const [delivered] = (await deliver({
        type: "before_agent_start",
        prompt: "second",
        systemPrompt: "p",
      })) as Array<{ message?: { content: string } } | undefined>
      expect(ran).toContain("status")
      expect(ran).toContain("reconcile")
      expect(delivered?.message?.content).toContain("holyagent reconcile:")
      expect(await deliver(shutdown ?? {})).toEqual([undefined])
    })
  })

  test("message_end: a child's empty or cut-off final message fails, the root's is left alone", async () => {
    const { events } = await load("extension-events")
    const ends = ofType(events, "message_end")
    const expected = [undefined, EMPTY_REPORT, CUT_OFF_REPORT]
    expect(ends.length).toBe(expected.length)
    await withDirectory(async (directory) => {
      const child = start(directory, "worker-debugging#a1b2c3d4")
      const root = start(directory)
      for (const [at, event] of ends.entries()) {
        const [replaced] = (await child.deliver(event)) as Array<
          { message: { stopReason: string; errorMessage: string } } | undefined
        >
        if (expected[at] === undefined) expect(replaced).toBeUndefined()
        else
          expect(replaced?.message).toMatchObject({
            stopReason: "error",
            errorMessage: expected[at],
          })
        expect(await root.deliver(event)).toEqual([undefined])
      }
    })
  })

  test("tool_call: the gate blocks a non-specialist Agent or workflow and lets the rest through", async () => {
    const { events } = await load("extension-events")
    const calls = new Map(
      ofType(events, "tool_call").map((event) => [String(event["toolCallId"]), event]),
    )
    const expected: Record<string, boolean> = {
      "call-agent-ok": false,
      "call-agent-general": true,
      "call-workflow-ok": false,
      "call-workflow-open": true,
      "call-bash": false,
    }
    expect([...calls.keys()].toSorted()).toEqual(Object.keys(expected).toSorted())
    await withDirectory(async (directory) => {
      expect(spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"]).status).not.toBe(0)
      const { deliver } = start(directory, undefined, directory)
      for (const [id, blocked] of Object.entries(expected)) {
        const [result] = (await deliver(calls.get(id) ?? {})) as Array<
          { block?: boolean; reason?: string } | undefined
        >
        if (blocked) {
          expect(result?.block).toBe(true)
          expect(typeof result?.reason).toBe("string")
        } else expect(result).toBeUndefined()
      }
    })
  })
})

// ---- the JSON stream of a specialist run -------------------------------------------------------

type AssistantMessage = Extract<Parameters<typeof failedFinalMessage>[0], { role: "assistant" }>

/** The messages and signals of one run's JSON stream that the Assignment status depends on. */
interface Run {
  readonly header: Record<string, unknown> | undefined
  readonly final: AssistantMessage | undefined
  readonly settled: { readonly aborted: boolean } | undefined
  readonly types: ReadonlyArray<string>
}

const readRun = (events: Loaded["events"]): Run => {
  const messages = events.filter(
    (event) =>
      event["type"] === "message_end" &&
      (event["message"] as { role?: string } | undefined)?.role === "assistant",
  )
  const settled = events.find((event) => event["type"] === "agent_settled")
  return {
    header: events.find((event) => event["type"] === "session"),
    final: (messages.at(-1) as { message: AssistantMessage } | undefined)?.message,
    settled: settled === undefined ? undefined : { aborted: settled["aborted"] === true },
    types: events.map((event) => String(event["type"])),
  }
}

/**
 * The outcome of a run as the table of events in docs/pi/orchestration.md reads it: no settle is an
 * `exit`, `agent_settled.aborted` or a final `aborted` is `aborted`, a final `error` is `error`,
 * and a final message the extension fails (cut off, or empty) is `length` or `empty`.
 */
const outcomeOf = (run: Run): PiOutcome => {
  const final = run.final
  if (run.settled === undefined || final === undefined) return "exit"
  if (run.settled.aborted || final.stopReason === "aborted") return "aborted"
  if (final.stopReason === "error") return "error"
  const failed = failedFinalMessage(final)
  if (failed === undefined) return "ok"
  return final.stopReason === "length" ? "length" : "empty"
}

describe("the JSON stream of a specialist run, read as the Assignment status does", () => {
  const cases = [
    { name: "json-run-ok", outcome: "ok", status: "done", close: "success" },
    { name: "json-run-aborted", outcome: "aborted", status: "failed", close: "errored" },
    { name: "json-run-error", outcome: "error", status: "failed", close: "errored" },
    { name: "json-run-length", outcome: "length", status: "failed", close: "errored" },
    { name: "json-run-empty", outcome: "empty", status: "failed", close: "errored" },
  ] as const

  for (const { name, outcome, status, close } of cases)
    test(`${name} is ${outcome}, so the Assignment is ${status} and closes ${close}`, async () => {
      const { events } = await load(name)
      const run = readRun(events)
      expect(run.header).toMatchObject({ type: "session", cwd: "/work/project" })
      expect(run.settled).toBeDefined()
      expect(run.types.at(-1)).toBe("agent_settled")
      expect(outcomeOf(run)).toBe(outcome)
      expect(assignmentStatusOf(outcomeOf(run))).toEqual({ status, close })
    })

  test("the settled run holds the report as its final message's text", async () => {
    const { events } = await load("json-run-ok")
    const { final, settled } = readRun(events)
    expect(settled).toEqual({ aborted: false })
    const text = final?.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
    expect(text?.join("")).toContain("Report:")
  })

  test("a stream cut off before agent_settled is an exit", async () => {
    const { events } = await load("json-run-ok")
    expect(outcomeOf(readRun(events.filter((event) => event["type"] !== "agent_settled")))).toBe(
      "exit",
    )
  })

  test("the run's error is carried by the final message and the retry events", async () => {
    const { events } = await load("json-run-error")
    expect(readRun(events).final).toMatchObject({
      stopReason: "error",
      errorMessage: "provider overloaded",
    })
    expect(
      ofType(events, "auto_retry_end").map((event) => [event["success"], event["finalError"]]),
    ).toEqual([[false, "provider overloaded"]])
  })
})

describe("the tool execution events of the stream", () => {
  test("each call starts and ends once, by the same id and name, and the end says if it failed", async () => {
    const { events } = await load("json-run-ok")
    const started = ofType(events, "tool_execution_start")
    const ended = ofType(events, "tool_execution_end")
    expect(started.map((event) => [event["toolCallId"], event["toolName"]])).toEqual([
      ["call-1", "read"],
    ])
    expect(
      ended.map((event) => [event["toolCallId"], event["toolName"], event["isError"]]),
    ).toEqual([["call-1", "read", false]])
    expect(ofType(events, "tool_execution_update")).toHaveLength(1)
  })

  test("a call a script made carries its parent's id, and a failed call is marked", async () => {
    const { events } = await load("json-tool-events")
    const nested = events.filter((event) => event["parentToolCallId"] !== undefined)
    expect(nested.length).toBeGreaterThan(0)
    for (const event of nested) {
      expect(String(event["toolCallId"])).toStartWith(`${String(event["parentToolCallId"])}/`)
    }
    expect(ofType(events, "tool_execution_end").map((event) => event["isError"])).toEqual([
      true,
      false,
    ])
  })
})

// ---- extension_ui_request, which T3 Code renders -------------------------------------------------

describe("the extension_ui_request messages of RPC mode", () => {
  test("every method T3 Code renders has a message with the fields it reads", async () => {
    const { events } = await load("rpc-extension-ui")
    expect(events.map((event) => event["method"])).toEqual([
      "select",
      "confirm",
      "input",
      "editor",
      "notify",
      "setStatus",
    ])
    for (const event of events) {
      expect(event["type"]).toBe("extension_ui_request")
      expect(typeof event["id"]).toBe("string")
    }
    expect(new Set(events.map((event) => event["id"])).size).toBe(events.length)
    const by = Object.fromEntries(events.map((event) => [String(event["method"]), event]))
    expect(by["select"]?.["options"]).toEqual(expect.arrayContaining([expect.any(String)]))
    expect(typeof by["select"]?.["title"]).toBe("string")
    expect(typeof by["confirm"]?.["message"]).toBe("string")
    expect(typeof by["input"]?.["title"]).toBe("string")
    expect(typeof by["editor"]?.["title"]).toBe("string")
    expect(["info", "warning", "error"]).toContain(String(by["notify"]?.["notifyType"]))
    expect(typeof by["setStatus"]?.["statusKey"]).toBe("string")
  })

  test("the extension asks nothing through the UI, so none of these messages comes from it", async () => {
    // The stub's context fails on any member but `cwd`, `ctx.ui` included.
    const { events } = await load("extension-events")
    await withDirectory(async (directory) => {
      const { deliver } = start(directory)
      for (const event of events) await deliver(event)
    })
  })
})
