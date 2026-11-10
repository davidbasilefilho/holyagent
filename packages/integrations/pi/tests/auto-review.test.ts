import { describe, expect, test } from "bun:test"

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Effect, Schema } from "effect"

import { Config } from "../../../runtime/src/config/schema.ts"
import { MANUAL_APPROVAL_PREFIX } from "../../../runtime/src/pi/codex/auto-review/assessment.ts"
import { CODEX_RESPONSES_URL } from "../../../runtime/src/pi/codex/auto-review/client.ts"
import type { PolicyConfig } from "../../../runtime/src/pi/codex/auto-review/policy.ts"
import type {
  ReviewerClient,
  ReviewerRequest,
} from "../../../runtime/src/pi/codex/auto-review/review.ts"
import {
  AUTO_REVIEW_ON,
  autoReviewChoice,
  createAutoReviewSettings,
  registerAutoReview,
} from "../src/auto-review.ts"
import { codexSettings } from "../src/codex.ts"

const decode = (value: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })(value))

const answer = (outcome: "allow" | "deny", rationale = "Because.") =>
  JSON.stringify({
    risk_level: "low",
    user_authorization: "unknown",
    outcome,
    rationale,
  })

interface Block {
  readonly block?: boolean
  readonly reason?: string
  readonly terminate?: boolean
}

type Handler = (event: object, ctx: ExtensionContext) => unknown

interface Tool {
  readonly name: string
  readonly annotations?: object
  readonly namespace?: object
}

/** Starts the module on a stub Pi API; `held` is read on each event, as the extension reads it. */
const start = (
  held: { current: PolicyConfig | undefined },
  options: {
    readonly reviewer?: ReviewerClient
    readonly tools?: ReadonlyArray<Tool>
    readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>
    readonly token?: string | undefined
    readonly timeoutMs?: number
  } = {},
) => {
  const handlers = new Map<string, Array<Handler>>()
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>()
  const notices: Array<string> = []
  const state = { aborts: 0, lookups: 0, walks: 0 }
  const api = {
    on: (event: string, handler: Handler) =>
      void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => void commands.set(name, command.handler),
    getAllTools: () => options.tools ?? [],
  }
  registerAutoReview(api as unknown as ExtensionAPI, {
    settings: () => held.current,
    ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const context = (provider = "openai-codex") =>
    ({
      cwd: "/work/project",
      model: { provider },
      abort: () => {
        state.aborts++
      },
      ui: { notify: (text: string) => void notices.push(text) },
      modelRegistry: {
        getApiKeyForProvider: () => {
          state.lookups++
          return Promise.resolve("token" in options ? options.token : "secret-token")
        },
      },
      sessionManager: {
        getBranch: () => {
          state.walks++
          return [
            { type: "message", message: { role: "user", content: "clean the build output" } },
            { type: "label", id: "x" },
          ]
        },
      },
    }) as unknown as ExtensionContext
  const emit = async (event: string, payload: object, provider?: string) => {
    const results: Array<unknown> = []
    for (const handler of handlers.get(event) ?? [])
      results.push(await handler(payload, context(provider)))
    return results
  }
  const call = async (toolName: string, input: object, provider?: string): Promise<Block> => {
    const [result] = (await emit(
      "tool_call",
      { toolName, input, toolCallId: "c" },
      provider,
    )) as Array<Block | undefined>
    return result ?? {}
  }
  const command = (name: string, args = "") => {
    const handler = commands.get(name)
    if (handler === undefined) throw new Error(`no command ${name}`)
    return handler(args, context())
  }
  return { emit, call, command, notices, state, commands }
}

const recording = (...texts: Array<string>) => {
  const requests: Array<ReviewerRequest> = []
  let next = 0
  const reviewer: ReviewerClient = (request) => {
    requests.push(request)
    return Effect.succeed(texts[Math.min(next++, texts.length - 1)] ?? "")
  }
  return { reviewer, requests }
}

const RISKY = { command: "rm -rf build" }

describe("what decides the auto-review settings", () => {
  test("the user's config decides: on by default, its policy text, and off only when it says so", async () => {
    expect(autoReviewChoice(await decode({}))).toEqual({ settings: {} })
    expect(
      autoReviewChoice(
        await decode({ pi: { autoReview: { policy: "Own.", extraPolicy: "More." } } }),
      ),
    ).toEqual({ settings: { policy: "Own.", extraPolicy: "More." } })
    expect(autoReviewChoice(await decode({ pi: { features: { autoReview: false } } }))).toEqual({
      settings: undefined,
    })
    expect(autoReviewChoice(await decode({ pi: { enable: false } }))).toEqual({
      settings: undefined,
    })
  })

  test("a user config that could not be read leaves it on with the default policy", () => {
    expect(autoReviewChoice(undefined)).toEqual({ settings: {} })
    expect(AUTO_REVIEW_ON).toEqual({ settings: {} })
  })

  test("is not tied to the config's provider: the Codex module's settings no longer carry it", async () => {
    const codex = codexSettings(await decode({ pi: { provider: "openai-codex" } }))
    expect(codex).toBeDefined()
    expect(codex).not.toHaveProperty("autoReview")
    expect(autoReviewChoice(await decode({ pi: { provider: "kimi-coding-global" } }))).toEqual({
      settings: {},
    })
  })

  test("is fixed for the session by the first choice: a later one, from a rewritten config or a compaction, changes nothing", () => {
    const session = createAutoReviewSettings()
    // Before any config is read it is on with the default policy.
    expect(session.settings()).toEqual({})
    session.fix({ settings: { policy: "First." } })
    session.fix({ settings: undefined })
    session.fix(AUTO_REVIEW_ON)
    expect(session.settings()).toEqual({ policy: "First." })

    const off = createAutoReviewSettings()
    off.fix({ settings: undefined })
    off.fix({ settings: {} })
    expect(off.settings()).toBeUndefined()
  })
})

describe("the tool_call gate", () => {
  test("lets a safe call run and reviews a risky one, with the session's history", async () => {
    const { reviewer, requests } = recording(answer("allow"))
    const module = start({ current: {} }, { reviewer })
    expect(await module.call("bash", { command: "ls" })).toEqual({})
    expect(requests).toHaveLength(0)
    expect(await module.call("bash", RISKY)).toEqual({})
    expect(requests).toHaveLength(1)
    expect(requests[0]?.model).toBe("codex-auto-review")
    expect(requests[0]?.prompt).toContain("[1] user: clean the build output")
    expect(module.notices[0]).toContain("Automatic approval review approved")
  })

  test("a deny blocks the call with the rejection text and tells the user", async () => {
    const { reviewer } = recording(answer("deny", "Deletes data."))
    const module = start({ current: {} }, { reviewer })
    const result = await module.call("bash", RISKY)
    expect(result.block).toBe(true)
    expect(result.reason).toStartWith(
      "This action was rejected due to unacceptable risk.\nReason: Deletes data.",
    )
    expect(result.terminate).toBeUndefined()
    expect(module.notices[0]).toContain("Automatic approval review denied")
    expect(module.state.aborts).toBe(0)
  })

  test("the breaker interrupts the turn at the third denial, and a new agent run starts again", async () => {
    const { reviewer } = recording(answer("deny"))
    const module = start({ current: {} }, { reviewer })
    await module.call("bash", RISKY)
    await module.call("bash", RISKY)
    const third = await module.call("bash", RISKY)
    expect(third).toMatchObject({ block: true, terminate: true })
    expect(module.state.aborts).toBe(1)
    await module.emit("agent_start", {})
    expect((await module.call("bash", RISKY)).terminate).toBeUndefined()
    expect(module.state.aborts).toBe(1)
  })

  test("a timeout blocks without a denial", async () => {
    const module = start({ current: {} }, { reviewer: () => Effect.never, timeoutMs: 20 })
    const result = await module.call("bash", RISKY)
    expect(result.block).toBe(true)
    expect(result.reason).toContain("did not finish before its deadline")
    expect(module.state.aborts).toBe(0)
  })

  test("a call the registry marks as needing approval is reviewed; a read-only one is not", async () => {
    const { reviewer, requests } = recording(answer("allow"))
    const module = start(
      { current: {} },
      {
        reviewer,
        tools: [
          { name: "mcp__docs__publish", annotations: { destructiveHint: true }, namespace: {} },
          { name: "mcp__docs__search", annotations: { readOnlyHint: true }, namespace: {} },
          { name: "mcp__docs__other", namespace: {} },
        ],
      },
    )
    await module.call("mcp__docs__search", {})
    expect(requests).toHaveLength(0)
    await module.call("mcp__docs__publish", {})
    await module.call("mcp__docs__other", {})
    expect(requests).toHaveLength(2)
  })

  test("a write outside the project root, or into a protected folder of it, is reviewed", async () => {
    const { reviewer, requests } = recording(answer("allow"))
    const module = start({ current: {} }, { reviewer })
    await module.call("write", { path: "src/a.ts", content: "x" })
    expect(requests).toHaveLength(0)
    await module.call("write", { path: "/etc/hosts", content: "x" })
    await module.call("write", { path: "@/etc/hosts", content: "x" })
    await module.call("write", { path: "@~/.ssh/authorized_keys", content: "x" })
    await module.call("write", { path: ".git/hooks/pre-commit", content: "x" })
    await module.call("write", { path: ".holyagent/config.json", content: "{}" })
    expect(requests).toHaveLength(5)
  })

  test("a tool that is neither known read-only nor annotated read-only is reviewed, a process runner included", async () => {
    const { reviewer, requests } = recording(answer("allow"))
    const module = start(
      { current: {} },
      {
        reviewer,
        tools: [{ name: "process" }, { name: "read" }, { name: "mcp__x__y", namespace: {} }],
      },
    )
    await module.call("read", { path: "src/a.ts" })
    expect(requests).toHaveLength(0)
    await module.call("process", { command: "sh -c id" })
    await module.call("mcp__x__y", {})
    await module.call("codemode", { code: "run()" })
    expect(requests).toHaveLength(3)
  })

  test("a call that runs at once looks up no credentials and walks no history", async () => {
    const { reviewer } = recording(answer("allow"))
    const module = start({ current: {} }, { reviewer })
    const fetched: Array<string> = []
    const quiet = start(
      { current: {} },
      {
        fetcher: (url) => {
          fetched.push(url)
          return Promise.reject(new Error("no network in tests"))
        },
      },
    )
    for (const [tool, input] of [
      ["read", { path: "a.ts" }],
      ["ls", {}],
      ["bash", { command: "ls -la" }],
      ["bash", { command: "git status" }],
      ["write", { path: "src/a.ts", content: "x" }],
    ] as const)
      expect(await quiet.call(tool, input)).toEqual({})
    expect(quiet.state.lookups).toBe(0)
    expect(quiet.state.walks).toBe(0)
    expect(fetched).toEqual([])
    // A reviewed call does both, once.
    await module.call("bash", RISKY)
    expect(module.state.walks).toBe(1)
    await quiet.call("bash", RISKY)
    expect(quiet.state.lookups).toBe(1)
    expect(quiet.state.walks).toBe(1)
  })

  test("the policy text of the config reaches the reviewer", async () => {
    const { reviewer, requests } = recording(answer("allow"))
    const module = start({ current: { extraPolicy: "Vendor.example is trusted." } }, { reviewer })
    await module.call("bash", RISKY)
    expect(requests[0]?.instructions).toContain("Vendor.example is trusted.")
  })

  test("without the capability there is no gate at all: nothing is classified, reviewed or asked of the backend", async () => {
    const { reviewer, requests } = recording(answer("deny"))
    const fetched: Array<string> = []
    const lookups = start(
      { current: undefined },
      {
        reviewer,
        fetcher: (url) => {
          fetched.push(url)
          return Promise.reject(new Error("no network in tests"))
        },
      },
    )
    expect(await lookups.call("bash", RISKY)).toEqual({})
    expect(await lookups.call("write", { path: "/etc/hosts", content: "x" })).toEqual({})
    expect(requests).toHaveLength(0)
    expect(fetched).toEqual([])
    expect(lookups.notices).toEqual([])
    expect(lookups.state.aborts).toBe(0)
  })

  test("is inert under another provider, even with the capability on", async () => {
    const { reviewer, requests } = recording(answer("deny"))
    const module = start({ current: {} }, { reviewer })
    expect(await module.call("bash", RISKY, "kimi-coding-global")).toEqual({})
    expect(requests).toHaveLength(0)
  })

  test("turning the capability off between calls removes the gate for the next one", async () => {
    const held: { current: PolicyConfig | undefined } = { current: {} }
    const { reviewer, requests } = recording(answer("deny"))
    const module = start(held, { reviewer })
    expect((await module.call("bash", RISKY)).block).toBe(true)
    held.current = undefined
    expect(await module.call("bash", RISKY)).toEqual({})
    expect(requests).toHaveLength(1)
  })
})

describe("the default reviewer client", () => {
  test("sends the review to the Codex backend with the session's token, and a bad answer denies closed", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const module = start(
      { current: {} },
      {
        fetcher: (url, init) => {
          seen.push({ url, init })
          return Promise.resolve(
            new Response(
              `data: ${JSON.stringify({ type: "response.output_text.done", text: answer("allow") })}\n\n`,
            ),
          )
        },
      },
    )
    expect(await module.call("bash", RISKY)).toEqual({})
    expect(seen[0]?.url).toBe(CODEX_RESPONSES_URL)
    expect((seen[0]?.init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer secret-token",
    )
    const broken = start(
      { current: {} },
      { fetcher: () => Promise.resolve(new Response("data: {}\n\n")) },
    )
    expect((await broken.call("bash", RISKY)).block).toBe(true)
  })

  test("without a Codex login the review fails closed and the backend is not asked", async () => {
    const fetched: Array<string> = []
    const module = start(
      { current: {} },
      {
        token: undefined,
        fetcher: (url) => {
          fetched.push(url)
          return Promise.reject(new Error("unexpected"))
        },
      },
    )
    const result = await module.call("bash", RISKY)
    expect(result.block).toBe(true)
    expect(result.reason).toContain("no Codex credentials")
    expect(fetched).toEqual([])
  })
})

describe("the /approve command", () => {
  test("approves the latest denied action for one retry, which is reviewed with the approval", async () => {
    const { reviewer, requests } = recording(answer("deny"), answer("allow"))
    const module = start({ current: {} }, { reviewer })
    await module.call("bash", RISKY)
    await module.command("approve")
    expect(module.notices.at(-1)).toContain("Approved for one retry: rm -rf build")
    expect(await module.call("bash", RISKY)).toEqual({})
    expect(requests[1]?.prompt).toContain(MANUAL_APPROVAL_PREFIX)
  })

  test("lists the denied actions, takes a number, and says when there is nothing to approve", async () => {
    const { reviewer } = recording(answer("deny"))
    const module = start({ current: {} }, { reviewer })
    await module.command("approve", "list")
    expect(module.notices.at(-1)).toBe("No denied action to approve.")
    await module.call("bash", { command: "rm -rf one" })
    await module.call("bash", { command: "rm -rf two" })
    await module.command("approve", "list")
    expect(module.notices.at(-1)).toBe("1. rm -rf two\n2. rm -rf one")
    await module.command("approve", "2")
    expect(module.notices.at(-1)).toContain("rm -rf one")
    await module.command("approve", "7")
    expect(module.notices.at(-1)).toBe("No such denied action to approve.")
    await module.command("approve", "zero")
    expect(module.notices.at(-1)).toContain("Usage: /approve")
  })

  test("says auto-review is off when it is", async () => {
    const module = start({ current: undefined })
    await module.command("approve")
    expect(module.notices).toEqual(["Auto-review is off, so there is nothing to approve."])
  })

  test("a new session forgets the denied actions", async () => {
    const { reviewer } = recording(answer("deny"))
    const module = start({ current: {} }, { reviewer })
    await module.call("bash", RISKY)
    await module.emit("session_start", { reason: "new" })
    await module.command("approve", "list")
    expect(module.notices.at(-1)).toBe("No denied action to approve.")
  })
})
