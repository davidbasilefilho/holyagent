import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { renderPrompt } from "../src/cli/report.ts"
import { BROWSE_PACKAGE, CAPABILITIES } from "../src/config/capabilities.ts"
import { PI_PACKAGE_VERSIONS } from "../src/config/pi-packages.ts"
import { DEFAULT_CONFIG as EXECUTION, directiveFor } from "../src/domain/directive.ts"
import { RoleTask } from "../src/domain/route.ts"
import { bindSpecialist } from "../src/domain/specialists.ts"
import { CODEX_ROUTES, SCREEN_MINIMUM_THINKING, screenRoute } from "../src/pi/codex/routes.ts"
import { routeModel } from "../src/pi/provider.ts"
import { DEFAULT_CONFIG as DEFAULT_PI_CONFIG } from "./config/defaults.ts"
import { after, assignment, entry, NOW, ok, refused } from "./fixtures.ts"

// A test that makes a repository and a state worktree runs a dozen git processes; see cli.test.ts.
if (process.platform === "win32") setDefaultTimeout(60_000)
afterAll(() => setDefaultTimeout(5_000))

let project: string
let home: string

beforeEach(async () => {
  project = await realpath(await mkdtemp(join(tmpdir(), "holyagent-screen-")))
  home = await realpath(await mkdtemp(join(tmpdir(), "holyagent-screen-home-")))
})
afterEach(() =>
  Promise.all([
    rm(project, { recursive: true, force: true, maxRetries: 5 }),
    rm(home, { recursive: true, force: true, maxRetries: 5 }),
  ]),
)

const PI = { HOLYAGENT_HOST: "pi" }

const cli = (argv: ReadonlyArray<string>, stdin?: unknown, env: Record<string, string> = {}) =>
  Effect.runPromise(
    run(argv, {
      cwd: project,
      env: { HOME: home, ...env },
      stdin:
        stdin === undefined
          ? Effect.fail(new StdinMissing({ reason: "no stdin in this test" }))
          : Effect.succeed(typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    }),
  )

type Result = Awaited<ReturnType<typeof cli>>

const TRAILER = "\nprompt:\n"

/** The TOON a successful command printed, decoded; a `prompt:` trailer is added as `prompt`. */
const data = (result: Result): Record<string, unknown> => {
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  const at = result.stdout.indexOf(TRAILER)
  if (at === -1) return decode(result.stdout) as Record<string, unknown>
  return {
    ...(decode(result.stdout.slice(0, at + 1)) as Record<string, unknown>),
    prompt: result.stdout.slice(at + TRAILER.length).replace(/\n$/, ""),
  }
}

const draft = (roleTask: string, over: Record<string, unknown> = {}) => {
  const given = over["objective"]
  const objective = typeof given === "string" ? given : `Check the screen (${roleTask})`
  return {
    roleTask,
    criteria: [{ text: "it works", blocking: true, dimension: "behavior" }],
    // One path for each objective, so two writers dispatched in a row own nothing in common.
    ...(roleTask.startsWith("Worker.") && roleTask !== "Worker.validation"
      ? { ownershipPaths: [`src/${objective.replace(/\W+/g, "-")}.ts`] }
      : {}),
    ...over,
    objective,
  }
}

const configure = async (config: unknown) => {
  await mkdir(join(home, ".holyagent"), { recursive: true })
  await writeFile(join(home, ".holyagent", "config.json"), JSON.stringify(config))
}

const createIntent = () => cli(["intent", "create"], { objective: "See the screen" }, PI)

describe("the screen capability on an Assignment's draft", () => {
  test("is kept when set, left out otherwise, and refused when it is not a boolean", async () => {
    await createIntent()
    const withScreen = data(
      await cli(["assignment", "create"], draft("Worker.implementation", { screen: true }), PI),
    )
    const without = data(await cli(["assignment", "create"], draft("Worker.implementation"), PI))
    const off = data(
      await cli(["assignment", "create"], draft("Worker.implementation", { screen: false }), PI),
    )
    const show = async (id: unknown) =>
      data(await cli(["assignment", "show", String(id), "--full"], undefined, PI))
    expect((await show(withScreen.id))["screen"]).toBe(true)
    expect((await show(without.id))["screen"]).toBeUndefined()
    expect((await show(off.id))["screen"]).toBeUndefined()
    const bad = await cli(
      ["assignment", "create"],
      draft("Worker.implementation", { screen: "yes" }),
      PI,
    )
    expect(bad.code).not.toBe(0)
  })

  test("the brief says so for a screen Assignment and says nothing otherwise", () => {
    const plain = renderPrompt(assignment(), "worker-implementation")
    const screen = renderPrompt(assignment({ screen: true }), "worker-implementation-screen")
    expect(plain).not.toContain("Screen capability")
    expect(screen).toContain("Screen capability: this Assignment carries it")
    expect(screen.split("\n")[0]).toBe(
      "Role: Worker.implementation (worker-implementation-screen). Assignment: assignment-a.",
    )
  })
})

describe("dispatching a screen Assignment under the pi host", () => {
  test("names the -screen agent, and an Assignment without the capability keeps the role's own", async () => {
    await createIntent()
    const plain = data(await cli(["assignment", "dispatch"], draft("Worker.implementation"), PI))
    expect(plain["agent"]).toBe("worker-implementation")
    const screen = data(
      await cli(
        ["assignment", "dispatch"],
        draft("Worker.implementation", { objective: "Drive the browser", screen: true }),
        PI,
      ),
    )
    expect(screen["agent"]).toBe("worker-implementation-screen")
    expect(String(screen["prompt"])).toStartWith(
      `Role: Worker.implementation (worker-implementation-screen). Assignment: ${String(screen["id"])}.`,
    )
  })

  test("under Kimi the model and effort are the role's row, screen or not", async () => {
    await createIntent()
    for (const roleTask of RoleTask.literals) {
      const plain = data(
        await cli(
          ["assignment", "dispatch"],
          draft(roleTask, { objective: `Plain ${roleTask}` }),
          PI,
        ),
      )
      const screen = data(
        await cli(
          ["assignment", "dispatch"],
          draft(roleTask, { objective: `Screen ${roleTask}`, screen: true }),
          PI,
        ),
      )
      expect(screen["model"], roleTask).toBe(plain["model"])
      expect(screen["effort"], roleTask).toBe(plain["effort"])
      expect(screen["agent"], roleTask).toBe(`${String(plain["agent"])}-screen`)
    }
  })

  test("under Codex it runs on GPT-6.1 Terra at medium or higher, whatever the role", async () => {
    await configure({ pi: { provider: "openai-codex" } })
    await createIntent()
    for (const roleTask of RoleTask.literals) {
      const row = CODEX_ROUTES[roleTask]
      const plain = data(
        await cli(
          ["assignment", "dispatch"],
          draft(roleTask, { objective: `Plain ${roleTask}` }),
          PI,
        ),
      )
      const screen = data(
        await cli(
          ["assignment", "dispatch"],
          draft(roleTask, { objective: `Screen ${roleTask}`, screen: true }),
          PI,
        ),
      )
      expect(plain["model"], roleTask).toBe(`openai-codex/${row.model}`)
      expect(plain["effort"], roleTask).toBe(row.thinking)
      expect(screen["model"], roleTask).toBe("openai-codex/gpt-6.1-terra")
      expect(["medium", "high", "xhigh", "max"], roleTask).toContain(String(screen["effort"]))
    }
    // The light specialists of Luna move to Terra at medium; an effort above medium stays.
    const lookup = data(
      await cli(
        ["assignment", "dispatch"],
        draft("Explorer.lookup", { objective: "Look at the screen", screen: true }),
        PI,
      ),
    )
    expect(lookup).toMatchObject({ model: "openai-codex/gpt-6.1-terra", effort: "medium" })
    const debugging = data(
      await cli(
        ["assignment", "dispatch"],
        draft("Worker.debugging", { objective: "Debug the screen", screen: true }),
        PI,
      ),
    )
    expect(debugging).toMatchObject({ model: "openai-codex/gpt-6.1-terra", effort: "xhigh" })
  })

  test("a Ready Assignment created with the capability is dispatched with it", async () => {
    await createIntent()
    const created = data(
      await cli(["assignment", "create"], draft("Reviewer.visual", { screen: true }), PI),
    )
    const dispatched = data(await cli(["assignment", "dispatch"], { id: created.id }, PI))
    expect(dispatched["agent"]).toBe("reviewer-visual-screen")
  })

  test("the brief file holds the screen line and the screen agent in its role line", async () => {
    await createIntent()
    const dispatched = data(
      await cli(["assignment", "dispatch"], draft("Worker.implementation", { screen: true }), PI),
    )
    const path = String(dispatched["prompt"]).match(/Read the brief at (\S+) with/)?.[1] ?? ""
    const brief = await readFile(path, "utf8")
    expect(brief).toContain("(worker-implementation-screen)")
    expect(brief).toContain("Screen capability: this Assignment carries it")
  })

  test("the launch of a screen Assignment is recorded for the -screen agent only", async () => {
    await createIntent()
    const dispatched = data(
      await cli(["assignment", "dispatch"], draft("Worker.implementation", { screen: true }), PI),
    )
    const recorded = await cli(
      ["assignment", "record", String(dispatched["id"]), "--agent", "pi:agent-1"],
      undefined,
      PI,
    )
    expect(data(recorded)).toMatchObject({ state: "Running", agent: "pi:agent-1" })
  })
})

describe("the screen capability under the Claude host", () => {
  test("is refused at dispatch, naming the host, and starts nothing", async () => {
    await cli(["intent", "create"], { objective: "See the screen" })
    const refusal = await cli(
      ["assignment", "dispatch"],
      draft("Worker.implementation", { screen: true }),
    )
    expect(refusal.code).not.toBe(0)
    expect(refusal.stderr).toContain("pi host only")
    const listed = data(await cli(["assignment", "list", "--all"]))
    expect(JSON.stringify(listed)).not.toContain("Running")
    // Without the capability the same draft dispatches as it always did.
    const plain = data(await cli(["assignment", "dispatch"], draft("Worker.implementation")))
    expect(plain["agent"]).toBe("holyagent:worker-implementation")
  })
})

describe("the route of a screen Assignment", () => {
  test("Codex moves every row to Terra at the higher of the row's effort and medium", () => {
    for (const [key, row] of Object.entries(CODEX_ROUTES)) {
      const moved = screenRoute(row)
      expect(moved.model, key).toBe("gpt-6.1-terra")
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
      expect(levels.indexOf(moved.thinking), key).toBeGreaterThanOrEqual(
        levels.indexOf(SCREEN_MINIMUM_THINKING),
      )
      expect(levels.indexOf(moved.thinking), key).toBeGreaterThanOrEqual(
        levels.indexOf(row.thinking),
      )
    }
    expect(screenRoute({ model: "gpt-6-luna", thinking: "low" })).toEqual({
      model: "gpt-6.1-terra",
      thinking: "medium",
    })
    expect(screenRoute({ model: "gpt-6.1-terra", thinking: "xhigh" }).thinking).toBe("xhigh")
  })

  test("routeModel applies it under Codex only, and only with the capability", () => {
    const codex = {
      ...DEFAULT_PI_CONFIG,
      pi: { ...DEFAULT_PI_CONFIG.pi, provider: "openai-codex" as const, routes: CODEX_ROUTES },
    }
    expect(routeModel(codex, "Explorer.map").spec).toBe("openai-codex/gpt-6-luna:low")
    expect(routeModel(codex, "Explorer.map", { screen: true }).spec).toBe(
      "openai-codex/gpt-6.1-terra:medium",
    )
    expect(routeModel(codex, "Explorer.map", { screen: false }).spec).toBe(
      "openai-codex/gpt-6-luna:low",
    )
    for (const key of Object.keys(DEFAULT_PI_CONFIG.pi.routes) as Array<RoleTask>)
      expect(routeModel(DEFAULT_PI_CONFIG, key, { screen: true })).toEqual(
        routeModel(DEFAULT_PI_CONFIG, key),
      )
  })
})

describe("a screen specialist is not reused for work without the capability, and the reverse", () => {
  const warm = (over = {}) => entry({ lastFinishedAt: after(-5), ...over })
  const next = (over = {}) =>
    assignment({ id: "assignment-new", followUpOf: "assignment-old", ...over })
  const directive = (registry: ReturnType<typeof entry>[], over = {}) =>
    directiveFor(next(over), registry, NOW, EXECUTION)

  test("a screen Assignment spawns the -screen agent, and continues only a screen specialist", () => {
    expect(directive([], { screen: true })).toMatchObject({
      action: "spawn",
      agent: "worker-implementation-screen",
    })
    expect(directive([warm()], { screen: true })).toMatchObject({
      action: "spawn",
      agent: "worker-implementation-screen",
      reason: "no specialist with the same screen capability",
    })
    expect(directive([warm({ screen: true })], { screen: true })).toMatchObject({
      action: "continue",
      agentId: "agent-1",
    })
  })

  test("an Assignment without the capability never continues a screen specialist", () => {
    expect(directive([warm({ screen: true })])).toMatchObject({
      action: "spawn",
      agent: "worker-implementation",
      reason: "no specialist with the same screen capability",
    })
    expect(directive([warm()]).action).toBe("continue")
  })

  test("binding registers the capability, and a specialist cannot take work of the other kind", () => {
    const registry = ok(
      bindSpecialist([], assignment({ screen: true }), {
        agentId: "agent-1",
        model: "sonnet",
        effort: "high",
      }),
    )
    expect(registry[0]).toMatchObject({ agentId: "agent-1", screen: true })
    const plain = ok(
      bindSpecialist([], assignment(), { agentId: "agent-2", model: "sonnet", effort: "high" }),
    )
    expect(plain[0]?.screen).toBeUndefined()
    const mismatch = refused(
      bindSpecialist(
        [{ ...registry[0]!, running: false }],
        assignment({ id: "assignment-other" }),
        { agentId: "agent-1", model: "sonnet", effort: "high" },
      ),
    )
    expect(mismatch._tag).toBe("SpecialistMismatch")
  })
})

describe("the browse pin", () => {
  test("is exact, from the table, and in the argument of the MCP server the capability registers", () => {
    const entryOf = CAPABILITIES.find((capability) => capability.name === "browser-use")
    const server = entryOf?.forms.normal
    expect(PI_PACKAGE_VERSIONS[BROWSE_PACKAGE]).toBe("0.0.15")
    expect(server).toMatchObject({
      packages: [],
      mcpServers: [
        { name: "browse", command: "npx", args: ["-y", "@opencode/browse@0.0.15", "mcp"] },
      ],
    })
  })
})
