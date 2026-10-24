import { describe, expect, test } from "bun:test"

import { WORKFLOW_NAMES } from "../../../runtime/src/domain/plan.ts"
import { ROUTES } from "../../../runtime/src/domain/route.ts"
import { generate } from "../src/generate.ts"

const scripts = new Map(
  (await generate())
    .filter((file) => file.path.includes("/workflows/"))
    .map((file) => [file.path.split("/").at(-1)?.replace(/\.js$/, "") ?? "", file.content]),
)

interface Call {
  readonly prompt: string
  readonly options: Record<string, unknown>
}

const AsyncFunction = (async () => {}).constructor as new (
  ...parts: Array<string>
) => (...values: Array<unknown>) => Promise<unknown>

/**
 * Runs a workflow script with the Workflow tool's globals replaced by fakes: agent() answers from
 * `answer`, and pipeline() and parallel() behave as documented (an item whose stage throws is
 * null).
 */
const execute = async (
  name: string,
  args: unknown,
  answer: (call: Call) => unknown = () => report(),
) => {
  const calls: Array<Call> = []
  const agent = (prompt: string, options: Record<string, unknown>) => {
    const call = { prompt, options }
    calls.push(call)
    const result = answer(call)
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }
  const pipeline = (
    items: ReadonlyArray<unknown>,
    ...stages: Array<(previous: unknown, item: unknown, index: number) => unknown>
  ) =>
    Promise.all(
      items.map(async (item, index) => {
        let previous = item
        for (const stage of stages) {
          const next = await Promise.resolve(stage(previous, item, index)).catch(() => undefined)
          if (next === undefined) return null
          previous = next
        }
        return previous
      }),
    )
  const parallel = (thunks: ReadonlyArray<() => Promise<unknown>>) =>
    Promise.all(thunks.map((thunk) => thunk().catch(() => null)))
  const body = (scripts.get(name) ?? "").replace(/^export const meta = /, "const meta = ")
  const result = await new AsyncFunction("agent", "pipeline", "parallel", "args", body)(
    agent,
    pipeline,
    parallel,
    args,
  )
  return { calls, result }
}

const report = (over: Record<string, unknown> = {}) => ({
  status: "done",
  changed_paths: ["src/a.ts"],
  checks: [{ command: "bun test", exit: 0 }],
  blockers: [],
  notes: [],
  evidence: [{ key: "tests", support: "passed" }],
  ...over,
})

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  agent: "holyagent:worker-implementation",
  model: "sonnet",
  effort: "high",
  prompt: `Prompt of ${id}`,
  ...over,
})

describe("every prebuilt workflow", () => {
  test("is one of the planner's names and starts with a literal meta", async () => {
    expect([...scripts.keys()].toSorted()).toEqual([...WORKFLOW_NAMES].toSorted())
    for (const [name, script] of scripts) {
      expect(script.startsWith("export const meta = {\n")).toBe(true)
      const literal = /^export const meta = (\{[\s\S]*?\n\})\n/.exec(script)?.[1]
      const meta = (await new AsyncFunction(`return ${literal}`)()) as {
        name: string
        description: string
        phases: Array<unknown>
      }
      expect(meta.name).toBe(name)
      expect(meta.description).not.toBe("")
      expect(meta.phases).not.toHaveLength(0)
    }
  })

  test("uses nothing that breaks a resume", () => {
    for (const script of scripts.values()) {
      expect(script).not.toMatch(/Date\.now|Math\.random|new Date\(\)/)
    }
  })

  test("runs holyagent specialists only, by agentType from the route table, with the given model and effort", async () => {
    const agents = new Set(ROUTES.map((route) => route.agent))
    const entries = ROUTES.flatMap((route, index) => [
      entry(`a-${index}`, {
        agent: `holyagent:${route.agent}`,
        model: route.model,
        effort: route.effort,
      }),
      entry(`b-${index}`, { agent: route.agent, model: route.model, effort: route.effort }),
    ])
    const half = entries.length / 2
    const runs = [
      await execute("run-assignments", { assignments: entries }),
      await execute("review-diff", { change: "diff.patch", reviewers: entries }),
      await execute("implement-review", {
        pairs: entries.slice(0, half).map((writer, index) => ({
          writer,
          reviewer: entries[half + index],
        })),
      }),
    ]
    for (const { calls } of runs) {
      expect(calls.length).toBeGreaterThan(0)
      for (const { options } of calls) {
        const type = String(options.agentType)
        expect(type).toMatch(/^holyagent:[a-z]+(?:-[a-z]+)*$/)
        expect(agents.has(type.slice("holyagent:".length))).toBe(true)
        const route = ROUTES.find((candidate) => candidate.agent === type.slice(10))
        expect(options).toMatchObject({ model: route?.model, effort: route?.effort })
      }
    }
  })

  test("asks for the structured report whose required fields are all declared", async () => {
    const { calls } = await execute("run-assignments", { assignments: [entry("a")] })
    const schema = calls[0]?.options.schema as {
      type: string
      properties: Record<string, unknown>
      required: Array<string>
    }
    expect(schema.type).toBe("object")
    expect(Object.keys(schema.properties).toSorted()).toEqual([
      "blockers",
      "changed_paths",
      "checks",
      "evidence",
      "notes",
      "status",
    ])
    for (const key of schema.required) expect(schema.properties).toHaveProperty(key)
    expect(calls[0]?.prompt).toStartWith("Prompt of a")
  })
})

describe("run-assignments", () => {
  test("gives each Assignment its own specialist and returns the reports in order", async () => {
    const { calls, result } = await execute("run-assignments", {
      assignments: [entry("a"), entry("b")],
    })
    expect(calls.map((call) => call.options.label)).toEqual(["a", "b"])
    expect(calls.map((call) => call.options.phase)).toEqual(["Run", "Run"])
    expect(result).toEqual([
      { id: "a", report: report() },
      { id: "b", report: report() },
    ])
  })

  test("a specialist that fails leaves the others' reports intact", async () => {
    const { result } = await execute(
      "run-assignments",
      { assignments: [entry("a"), entry("b"), entry("c")] },
      ({ options }) => (options.label === "b" ? new Error("died") : report()),
    )
    expect(result).toEqual([
      { id: "a", report: report() },
      { id: "b", report: null },
      { id: "c", report: report() },
    ])
  })
})

describe("review-diff", () => {
  test("gives every reviewer the change and merges equal blockers across them", async () => {
    const { calls, result } = await execute(
      "review-diff",
      { change: "main..feature", reviewers: [entry("a"), entry("b"), entry("c")] },
      ({ options }) =>
        options.label === "a"
          ? report({ blockers: ["Missing test for parse"] })
          : options.label === "b"
            ? report({ blockers: ["missing  test for PARSE", "Leaks a handle", "Leaks a handle"] })
            : new Error("died"),
    )
    for (const call of calls) expect(call.prompt).toContain("Change under review: main..feature")
    expect(result).toEqual({
      reviewers: [
        { id: "a", report: report({ blockers: ["Missing test for parse"] }) },
        {
          id: "b",
          report: report({
            blockers: ["missing  test for PARSE", "Leaks a handle", "Leaks a handle"],
          }),
        },
        { id: "c", report: null },
      ],
      blockers: [
        { blocker: "Missing test for parse", reviewers: ["a", "b"] },
        { blocker: "Leaks a handle", reviewers: ["b"] },
      ],
    })
  })
})

describe("implement-review", () => {
  const pair = (id: string) => ({
    writer: entry(`w-${id}`),
    reviewer: entry(`r-${id}`, { agent: "holyagent:reviewer-code" }),
  })

  test("runs the writer, then the reviewer with the writer's changed paths and checks", async () => {
    const { calls, result } = await execute(
      "implement-review",
      { pairs: [pair("1")] },
      ({ options }) =>
        options.label === "w-1"
          ? report({
              changed_paths: ["src/x.ts", "src/y.ts"],
              checks: [{ command: "bun check", exit: 0 }],
            })
          : report({ status: "done" }),
    )
    expect(calls.map((call) => call.options.label)).toEqual(["w-1", "r-1"])
    expect(calls.map((call) => call.options.phase)).toEqual(["Implement", "Review"])
    expect(calls[0]?.prompt).not.toContain("src/x.ts")
    expect(calls[1]?.prompt).toContain("- src/x.ts\n- src/y.ts")
    expect(calls[1]?.prompt).toContain("- bun check -> exit 0")
    expect(result).toMatchObject([
      { writer: { id: "w-1" }, reviewer: { id: "r-1", report: report() } },
    ])
  })

  test("a writer that fails or is blocked is not reviewed, and other pairs carry on", async () => {
    const { calls, result } = await execute(
      "implement-review",
      { pairs: [pair("1"), pair("2"), pair("3")] },
      ({ options }) =>
        options.label === "w-1"
          ? new Error("died")
          : options.label === "w-2"
            ? report({ status: "blocked", blockers: ["no access"] })
            : report(),
    )
    expect(calls.map((call) => String(call.options.label)).toSorted()).toEqual([
      "r-3",
      "w-1",
      "w-2",
      "w-3",
    ])
    expect(result).toEqual([
      { writer: { id: "w-1", report: null }, reviewer: { id: "r-1", report: null } },
      {
        writer: { id: "w-2", report: report({ status: "blocked", blockers: ["no access"] }) },
        reviewer: { id: "r-2", report: null },
      },
      { writer: { id: "w-3", report: report() }, reviewer: { id: "r-3", report: report() } },
    ])
  })
})
