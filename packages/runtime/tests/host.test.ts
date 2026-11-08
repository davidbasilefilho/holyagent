import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { Effect } from "effect"

import { agentHostOf, workflowsAvailable } from "../src/cli/config.ts"
import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { CLAUDE_WORDS, PI_WORDS, wordsFor } from "../src/domain/host.ts"
import * as runtime from "../src/index.ts"

// A test that makes a repository and a state worktree runs a dozen git processes; see cli.test.ts.
if (process.platform === "win32") setDefaultTimeout(60_000)
afterAll(() => setDefaultTimeout(5_000))

let project: string
let home: string

beforeEach(async () => {
  project = await realpath(await mkdtemp(join(tmpdir(), "holyagent-host-")))
  home = await realpath(await mkdtemp(join(tmpdir(), "holyagent-host-home-")))
})
afterEach(() =>
  Promise.all([
    rm(project, { recursive: true, force: true, maxRetries: 5 }),
    rm(home, { recursive: true, force: true, maxRetries: 5 }),
  ]),
)

const PI = { HOLYAGENT_HOST: "pi" }

/** Runs one command line in-process against the temp project, with stdin as JSON when given. */
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

const writer = {
  roleTask: "Worker.implementation",
  objective: "Build the parser",
  criteria: [{ text: "parses", blocking: true, dimension: "behavior" }],
  evidence: ["tests"],
  ownershipPaths: ["src/parser.ts"],
}

const reviewer = (roleTask: string) => ({
  roleTask,
  objective: `Review the parser (${roleTask})`,
  criteria: [{ text: "sound", blocking: true, dimension: "behavior" }],
})

const createIntent = async (env: Record<string, string> = {}) =>
  data(await cli(["intent", "create"], { objective: "Parse everything" }, env))

/** Two Ready reviews, which a workflow can run side by side. */
const readyPair = async (env: Record<string, string> = {}) => {
  await createIntent(env)
  const ids: Array<string> = []
  for (const task of ["Reviewer.code", "Reviewer.security"])
    ids.push(String(data(await cli(["assignment", "create"], reviewer(task), env)).id))
  return ids
}

/** The Claude Workflow tool, which the Claude help names and pi's `SubagentWorkflow` does not. */
const CLAUDE_WORKFLOW_TOOL = /(?<!Subagent)Workflow\b/

describe("the host and the workflow switch", () => {
  const available = (env: Record<string, string>) =>
    Effect.runPromise(workflowsAvailable(env, project))

  test("Claude is the default host and its own detection decides", async () => {
    expect(await Effect.runPromise(agentHostOf({}))).toBe("claude")
    expect(await available({ HOME: home })).toBe(true)
    expect(await available({ HOME: home, CLAUDE_CODE_DISABLE_WORKFLOWS: "1" })).toBe(false)
    expect(await available({ HOME: home, HOLYAGENT_HOST: "claude" })).toBe(true)
  })

  test("under pi workflows are unavailable until the extension says so", async () => {
    expect(await Effect.runPromise(agentHostOf(PI))).toBe("pi")
    expect(await available({ HOME: home, ...PI })).toBe(false)
    expect(await available({ HOME: home, ...PI, HOLYAGENT_WORKFLOWS: "1" })).toBe(true)
    expect(await available({ HOME: home, ...PI, HOLYAGENT_WORKFLOWS: " 0 " })).toBe(false)
  })

  test("HOLYAGENT_WORKFLOWS overrides Claude's detection too, and blank counts as unset", async () => {
    expect(
      await available({ HOME: home, CLAUDE_CODE_DISABLE_WORKFLOWS: "1", HOLYAGENT_WORKFLOWS: "1" }),
    ).toBe(true)
    expect(await available({ HOME: home, HOLYAGENT_WORKFLOWS: "0" })).toBe(false)
    expect(await available({ HOME: home, HOLYAGENT_WORKFLOWS: "  ", HOLYAGENT_HOST: "" })).toBe(
      true,
    )
  })

  test("a value that is not a host or a switch is a usage error that names the variable", async () => {
    const badHost = await cli(["plan"], undefined, { HOLYAGENT_HOST: "codex" })
    expect(badHost.code).toBe(2)
    expect(badHost.stderr).toContain("HOLYAGENT_HOST must be claude or pi")
    const badSwitch = await cli(["plan"], undefined, { HOLYAGENT_WORKFLOWS: "yes" })
    expect(badSwitch.code).toBe(2)
    expect(badSwitch.stderr).toContain('HOLYAGENT_WORKFLOWS must be 1 or 0, not "yes"')
    // A bad host does not hide the failure being reported, which falls back to Claude's words.
    expect((await cli(["help", "nothing"], undefined, { HOLYAGENT_HOST: "codex" })).code).toBe(2)
  })

  test("help under a bad host falls back to Claude's words, as the failures do", async () => {
    const bad = { HOLYAGENT_HOST: "codex" }
    for (const argv of [["--help"], ["help", "assignment", "dispatch"], ["assignment", "--help"]]) {
      const shown = await cli(argv, undefined, bad)
      expect(shown.code).toBe(0)
      expect(shown).toEqual(await cli(argv))
    }
  })

  test("recording an agent needs only the host, so a bad TTL or workflows setting does not block it", async () => {
    await createIntent()
    const id = String(data(await cli(["assignment", "dispatch"], writer)).id)
    const broken = { HOLYAGENT_REUSE_TTL_MINUTES: "soon", HOLYAGENT_WORKFLOWS: "yes" }
    expect((await cli(["plan"], undefined, broken)).code).toBe(2)
    expect(
      data(await cli(["assignment", "record", id, "--agent", "a-1"], undefined, broken)).agent,
    ).toBe("a-1")
    expect((await cli(["reconcile"], undefined, broken)).code).toBe(0)
  })

  test("recording a failed launch does not read the host, so a bad HOLYAGENT_HOST does not block it", async () => {
    await createIntent()
    const id = String(data(await cli(["assignment", "dispatch"], writer)).id)
    const bad = { HOLYAGENT_HOST: "codex" }
    const refused = await cli(["assignment", "record", id, "--agent", "a-1"], undefined, bad)
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("HOLYAGENT_HOST must be claude or pi")
    expect(data(await cli(["assignment", "record", id, "--failed"], undefined, bad)).id).toBe(id)
  })
})

describe("plan under the pi host", () => {
  test("with workflows available it names pi's workflow tool for the direct-subagent fallback", async () => {
    const ids = await readyPair()
    const plan = data(await cli(["plan"], undefined, { ...PI, HOLYAGENT_WORKFLOWS: "1" }))
    expect(plan).toMatchObject({
      action: "workflow",
      assignments: ids,
      fallback: {
        action: "subagent",
        when: "only if the SubagentWorkflow tool is disabled or unavailable",
        assignments: ids,
        parallel: true,
      },
    })
  })

  test("with workflows unavailable it prints the direct subagents, whether the switch is 0 or unset", async () => {
    const ids = await readyPair()
    for (const env of [{ ...PI, HOLYAGENT_WORKFLOWS: "0" }, PI]) {
      const plan = data(await cli(["plan"], undefined, env))
      expect(plan).toMatchObject({
        action: "subagent",
        assignments: ids,
        parallel: true,
        reason: "the SubagentWorkflow tool is disabled or unavailable",
      })
      expect(plan).not.toHaveProperty("fallback")
    }
  })

  test("Claude's detection plays no part under pi", async () => {
    const ids = await readyPair()
    await mkdir(join(project, ".claude"))
    await Bun.write(join(project, ".claude", "settings.local.json"), '{"enableWorkflows": false}')
    // Settings that disable Claude's workflows do not switch off a pi extension that says it has them.
    expect(data(await cli(["plan"], undefined, { ...PI, HOLYAGENT_WORKFLOWS: "1" }))).toMatchObject(
      { action: "workflow", assignments: ids },
    )
  })

  test("no output of plan names Claude's tools", async () => {
    await readyPair()
    for (const env of [{ ...PI, HOLYAGENT_WORKFLOWS: "1" }, PI]) {
      const { stdout } = await cli(["plan"], undefined, env)
      expect(stdout).not.toMatch(CLAUDE_WORKFLOW_TOOL)
      expect(stdout).not.toContain("SendMessage")
    }
  })
})

describe("help under each host", () => {
  const COMMAND_LINE = /^(\S.*?) {2}\S/

  /** The usage of every command a host's top help lists, to ask for the help of each. */
  const listedCommands = async (env: Record<string, string>) =>
    (await cli(["help"], undefined, env)).stdout
      .split("\n")
      .slice(2, -2)
      .map((line) => COMMAND_LINE.exec(line)?.[1] ?? "")
      .map((usage) => usage.split(/\s+/).filter((word) => /^[a-z-]+$/.test(word)))

  test("under pi no help names Claude's Workflow tool or SendMessage", async () => {
    const commands = await listedCommands(PI)
    expect(commands.length).toBeGreaterThan(20)
    const texts = [(await cli(["help"], undefined, PI)).stdout]
    for (const words of commands) texts.push((await cli(["help", ...words], undefined, PI)).stdout)
    for (const group of new Set(commands.map((words) => words[0] ?? "")))
      texts.push((await cli([group, "--help"], undefined, PI)).stdout)
    for (const text of texts) {
      expect(text).not.toMatch(CLAUDE_WORKFLOW_TOOL)
      expect(text).not.toContain("SendMessage")
    }
  })

  test("under pi the help names pi-subagents' tools", async () => {
    const dispatch = (await cli(["help", "assignment", "dispatch"], undefined, PI)).stdout
    expect(dispatch).toContain(
      "to the Agent tool only when the SubagentWorkflow tool is disabled or unavailable, and by the Agent tool's resume only for a warm continuation",
    )
    expect(dispatch).toContain("reads it with the read tool")
    const plan = (await cli(["help", "plan"], undefined, PI)).stdout
    expect(plan).toContain("by the Agent tool's resume beside the workflow")
    expect(plan).toContain("where the SubagentWorkflow tool is disabled or unavailable")
    const record = (await cli(["help", "assignment", "record"], undefined, PI)).stdout
    expect(record).toContain("a workflow's agent as pi-workflow:<run-id>/<id>")
    expect(record).toContain("an agent is recorded as pi:<agent-id>")
    const close = (await cli(["help", "assignment", "close"], undefined, PI)).stdout
    expect(close).toContain(
      "records nothing: resume the same subagent with the Agent tool and ask for the missing support, then close again",
    )
  })

  test("under pi no help says a hook records agents, and reports reads Claude journals only", async () => {
    const record = (await cli(["help", "assignment", "record"], undefined, PI)).stdout
    expect(record).not.toContain("a hook records")
    expect(record).toContain("the pi launcher records no agent by hook")
    const reports = (await cli(["help", "assignment", "reports"], undefined, PI)).stdout
    expect(reports).toContain("reads Claude workflow journals only for now")
    const claude = (await cli(["help", "assignment", "record"])).stdout
    expect(claude).toContain("a hook records an agent spawned from a dispatch prompt")
    expect((await cli(["help", "assignment", "reports"])).stdout).not.toContain("for now")
  })

  test("the Claude hooks are not listed under pi, the git hook is", async () => {
    const hooks = (await cli(["hook", "--help"], undefined, PI)).stdout
    expect(hooks).toContain("hook commit-msg")
    for (const claudeOnly of ["session-start", "agent-launch", "hook workflow"])
      expect(hooks).not.toContain(claudeOnly)
    expect((await cli(["help"], undefined, PI)).stdout).not.toContain("hook session-start")
    // They still answer a direct ask, and Claude's help lists all of them.
    expect((await cli(["hook", "workflow", "--help"], undefined, PI)).code).toBe(0)
    const claude = (await cli(["hook", "--help"])).stdout
    for (const name of ["session-start", "root-rules", "agent-launch", "vcs-reminder", "workflow"])
      expect(claude).toContain(`hook ${name}`)
  })

  test("Claude's help is the same with the host unset and set to claude, and names Claude's tools", async () => {
    for (const words of [
      [],
      ["assignment"],
      ["assignment", "dispatch"],
      ["assignment", "record"],
      ["assignment", "close"],
      ["assignment", "reports"],
      ["plan"],
      ["hook"],
    ]) {
      const unset = await cli(["help", ...words])
      expect(await cli(["help", ...words], undefined, { HOLYAGENT_HOST: "claude" })).toEqual(unset)
    }
    const dispatch = (await cli(["help", "assignment", "dispatch"])).stdout
    expect(dispatch).toContain(
      "to the Agent tool only when the Workflow tool is disabled or unavailable, and by SendMessage only for a warm continuation",
    )
    expect(dispatch).toContain("reads it with the Read tool")
    expect((await cli(["help", "assignment", "reports"])).stdout).toContain(
      "Write the results of a Workflow run's journal",
    )
    expect(wordsFor("claude")).toBe(CLAUDE_WORDS)
    expect(wordsFor("pi")).toBe(PI_WORDS)
  })
})

describe("dispatch and the hints under the pi host", () => {
  test("the prompt names the read tool of pi and the output no tool of Claude's", async () => {
    await createIntent()
    const result = await cli(["assignment", "dispatch"], writer, PI)
    const dispatched = data(result)
    expect(dispatched).toMatchObject({ state: "Running", agent: "holyagent:worker-implementation" })
    expect(String(dispatched.prompt)).toMatch(
      /with the read tool and follow it as your full task\.$/,
    )
    expect(result.stdout).not.toMatch(CLAUDE_WORKFLOW_TOOL)
  })

  test("the Claude prompt is unchanged", async () => {
    await createIntent()
    const dispatched = data(await cli(["assignment", "dispatch"], writer))
    expect(String(dispatched.prompt)).toMatch(
      /with the Read tool and follow it as your full task\.$/,
    )
  })

  test("an evidence gap hints at resuming the subagent under pi and SendMessage under Claude", async () => {
    for (const [env, agent, hint] of [
      [PI, "pi:agent-1", "Resume the subagent with the Agent tool for the missing support"],
      [{}, "agent-1", "SendMessage the subagent for the missing support"],
    ] as const) {
      await createIntent(env)
      const id = String(data(await cli(["assignment", "dispatch"], writer, env)).id)
      data(await cli(["assignment", "record", id, "--agent", agent], undefined, env))
      const refused = await cli(
        ["assignment", "close", id, "--outcome", "success", "--accept", "ok"],
        "Built it.\n\nevidence:\n- parses: yes",
        env,
      )
      expect(refused.code).toBe(3)
      expect(refused.stderr).toContain("InsufficientAcceptance")
      expect(refused.stderr).toContain(hint)
      if (env === PI) expect(refused.stderr).not.toContain("SendMessage")
      await rm(join(project, ".holyagent"), { recursive: true, force: true })
    }
  })

  test("reconcile names how to confirm an agent is gone in the host's tools", async () => {
    await createIntent()
    const id = String(data(await cli(["assignment", "dispatch"], writer)).id)
    data(await cli(["assignment", "record", id, "--agent", `pi:agent-1`], undefined, PI))
    expect(String(data(await cli(["reconcile"], undefined, PI)).next)).toContain(
      "(get_subagent_result or transcript;",
    )
    expect(String(data(await cli(["reconcile"])).next)).toContain("(SendMessage or transcript;")
  })
})

describe("agent ids", () => {
  const dispatchWriter = async (env: Record<string, string> = {}) => {
    await createIntent(env)
    return String(data(await cli(["assignment", "dispatch"], writer, env)).id)
  }
  const record = (id: string, agent: string, env: Record<string, string> = {}) =>
    cli(["assignment", "record", id, "--agent", agent], undefined, env)

  test("pi records a direct agent as pi:<agent-id> and a workflow's agent as pi-workflow:<run-id>/<id>", async () => {
    const id = await dispatchWriter(PI)
    for (const bad of [
      "pi:",
      "pi: x",
      "pi-workflow:run-1",
      `pi-workflow:run-1/other`,
      `pi-workflow:/${id}`,
      `pi-workflow:run-1/${id}/x`,
    ]) {
      const refused = await record(id, bad, PI)
      expect(refused.code).toBe(2)
      expect(refused.stderr).toMatch(/pi:<agent-id>|pi-workflow:<run-id>\//)
    }
    expect(data(await record(id, `pi-workflow:wf-3f9a/${id}`, PI))).toMatchObject({
      id,
      state: "Running",
      agent: `pi-workflow:wf-3f9a/${id}`,
    })
  })

  test("a direct pi agent is recorded under its prefix", async () => {
    const id = await dispatchWriter(PI)
    expect(data(await record(id, "pi:1c2d3e4f-5a6b-7c8", PI))).toMatchObject({
      state: "Running",
      agent: "pi:1c2d3e4f-5a6b-7c8",
    })
  })

  test("under pi a bare id or Claude's workflow form is refused with the pi forms", async () => {
    const id = await dispatchWriter(PI)
    for (const bad of ["1c2d3e4f-5a6b-7c8", `workflow:run-1/${id}`]) {
      const refused = await record(id, bad, PI)
      expect(refused.code).toBe(2)
      expect(refused.stderr).toContain(
        `Under the pi host an agent is recorded as pi:<agent-id>, or as pi-workflow:<run-id>/${id}`,
      )
    }
  })

  test("Claude still takes any host id and the workflow form, and also the pi forms", async () => {
    const id = await dispatchWriter()
    const refused = await record(id, `workflow:run-1`)
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain(`workflow:<run-id>/${id}`)
    expect((await record(id, `pi-workflow:run-1/other`)).stderr).toContain(
      `pi-workflow:<run-id>/${id}`,
    )
    expect(data(await record(id, "toolu_01ABC"))).toMatchObject({ agent: "toolu_01ABC" })
  })

  test("a pi workflow's agent is never continued, a direct one is for a follow-up", async () => {
    const id = await dispatchWriter(PI)
    data(await record(id, `pi-workflow:wf-1/${id}`, PI))
    data(await cli(["assignment", "close", id, "--outcome", "failure"], "stopped", PI))
    const next = data(
      await cli(["assignment", "dispatch"], { ...writer, objective: "Fix it", followUpOf: id }, PI),
    )
    expect(next).toMatchObject({ agent: "holyagent:worker-implementation" })
    expect(next).not.toHaveProperty("continue")
  })

  test("a warm direct pi agent is continued under its recorded id", async () => {
    const id = await dispatchWriter(PI)
    data(await record(id, "pi:agent-9", PI))
    data(
      await cli(
        ["assignment", "close", id, "--outcome", "success"],
        "Built it.\n\nevidence:\n- parses: yes",
        PI,
      ),
    )
    const next = data(
      await cli(["assignment", "dispatch"], { ...writer, objective: "Fix it", followUpOf: id }, PI),
    )
    expect(next).toMatchObject({
      continue: "pi:agent-9",
      reason: "follow-up of its own Assignment",
    })
  })
})

describe("the session-start building blocks", () => {
  test("the package exports what the hook builds its context from", () => {
    for (const exported of [
      runtime.statusOf,
      runtime.resumeOf,
      runtime.requirementsOf,
      runtime.hasStateFolder,
      runtime.sessionContext,
      runtime.bareContext,
      runtime.legacyContext,
    ])
      expect(typeof exported).toBe("function")
    expect(runtime.ROOT_CORE.length).toBeGreaterThan(100)
    expect(runtime.SESSION_REMINDER.length).toBeGreaterThan(10)
    expect(runtime.RESUMED.has("resume")).toBe(true)
    expect(runtime.PI_WORDS).toBe(PI_WORDS)
  })

  test("a pi handler builds the context from them", async () => {
    await createIntent()
    const id = String(data(await cli(["assignment", "dispatch"], writer)).id)
    data(await cli(["assignment", "record", id, "--agent", "pi:agent-1"], undefined, PI))
    const directory = join(project, ".holyagent")
    expect(await Effect.runPromise(runtime.hasStateFolder(directory))).toBe(true)
    const { status, reconcile } = await Effect.runPromise(runtime.resumeOf(directory, PI_WORDS))
    const text = runtime.sessionContext(status, runtime.ROOT_CORE, reconcile)
    expect(text).toContain("holyagent status:")
    expect(text).toContain("pi:agent-1")
    expect(JSON.stringify(reconcile)).toContain("(get_subagent_result or transcript;")
    expect(text.length).toBeLessThanOrEqual(runtime.CONTEXT_BUDGET)
  })
})
