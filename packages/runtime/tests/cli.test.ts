import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"

let project: string
let home: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "holyagent-cli-"))
  home = await mkdtemp(join(tmpdir(), "holyagent-home-"))
})
afterEach(() =>
  Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]),
)

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

const writer = (over: Record<string, unknown> = {}) => ({
  roleTask: "Worker.implementation",
  objective: "Build the parser",
  criteria: [{ text: "parses", blocking: true, dimension: "behavior" }],
  evidence: ["tests"],
  ownershipPaths: ["src/parser.ts"],
  ...over,
})

const reviewer = (roleTask: string, over: Record<string, unknown> = {}) => ({
  roleTask,
  objective: `Review the parser (${roleTask})`,
  criteria: [{ text: "sound", blocking: true, dimension: "behavior" }],
  ...over,
})

/** A specialist's report: prose, then the evidence block `close --accept` reads. */
const report = (...evidence: ReadonlyArray<string>) =>
  [
    "Built the parser.",
    "It handles nested input.",
    "",
    "evidence:",
    ...evidence.map((l) => `- ${l}`),
  ].join("\n")

const FULL_REPORT = report("parses: ran the parser", "tests: bun test passed")

const createIntent = async () =>
  String(data(await cli(["intent", "create"], { objective: "Parse everything" })).id)

/** Dispatch, record and close one Assignment; returns its id. */
const runToClose = async (draft: object, agent: string, accept = false) => {
  const id = String(data(await cli(["assignment", "dispatch"], draft)).id)
  data(await cli(["assignment", "record", id, "--agent", agent]))
  data(
    await cli(
      [
        "assignment",
        "close",
        id,
        "--outcome",
        "success",
        ...(accept ? ["--accept", "checked"] : []),
      ],
      FULL_REPORT,
    ),
  )
  return id
}

describe("lifecycle", () => {
  test("an Assignment runs from draft to accepted in three calls after the Intent exists", async () => {
    const intentId = await createIntent()

    const dispatched = data(await cli(["assignment", "dispatch"], writer()))
    expect(dispatched).toMatchObject({
      state: "Running",
      agent: "holyagent:worker-implementation",
      model: "sonnet",
      effort: "high",
    })
    const id = String(dispatched.id)

    expect(data(await cli(["assignment", "record", id, "--agent", "agent-1"]))).toMatchObject({
      id,
      state: "Running",
      agent: "agent-1",
    })

    expect(
      data(
        await cli(
          ["assignment", "close", id, "--outcome", "success", "--accept", "checked"],
          FULL_REPORT,
        ),
      ),
    ).toMatchObject({ id, state: "Succeeded", accepted: true })

    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      intent: intentId,
      state: "Succeeded",
      agent: "agent-1",
      result: FULL_REPORT,
      acceptance: { revision: 1, rationale: "checked" },
    })
    expect(data(await cli(["status"]))).not.toHaveProperty("running")
  })

  test("a failed launch rolls the Assignment back to Ready, and it can be dispatched by id", async () => {
    await createIntent()
    const id = String(data(await cli(["assignment", "dispatch"], writer())).id)

    expect(data(await cli(["assignment", "record", id, "--failed"]))).toMatchObject({
      id,
      state: "Ready",
    })
    expect(data(await cli(["assignment", "dispatch"], { id }))).toMatchObject({
      id,
      state: "Running",
    })
  })

  test("a later dispatch continues the warm specialist that finished inside the cache window", async () => {
    await createIntent()
    const first = await runToClose(writer(), "agent-1", true)

    const next = data(
      await cli(
        ["assignment", "dispatch"],
        writer({ objective: "Fix the parser", followUpOf: first }),
      ),
    )
    expect(next).toMatchObject({ state: "Running", continue: "agent-1" })
    expect(next).not.toHaveProperty("agent")
  })

  test("a reviewer is never continued from the writer or from a reviewer of the same work", async () => {
    await createIntent()
    const built = await runToClose(writer(), "writer-1", true)

    const review = (over = {}) => reviewer("Reviewer.code", { dependencies: [built], ...over })
    const firstReview = data(await cli(["assignment", "dispatch"], review()))
    expect(firstReview).toMatchObject({ agent: "holyagent:reviewer-code" })
    expect(firstReview).not.toHaveProperty("continue")
    const firstId = String(firstReview.id)
    data(await cli(["assignment", "record", firstId, "--agent", "reviewer-1"]))
    data(await cli(["assignment", "close", firstId, "--outcome", "success"], "clean"))

    const secondReview = data(
      await cli(["assignment", "dispatch"], review({ objective: "Second look" })),
    )
    expect(secondReview).toMatchObject({ agent: "holyagent:reviewer-code" })
    expect(secondReview).not.toHaveProperty("continue")
  })

  test("reconcile lists Running Assignments and closing one as interrupted cancels it", async () => {
    await createIntent()
    const id = String(data(await cli(["assignment", "dispatch"], writer())).id)
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))

    expect(data(await cli(["reconcile"]))).toMatchObject({ running: [{ id, agent: "agent-1" }] })
    expect(
      data(await cli(["assignment", "close", id, "--outcome", "interrupted"], "agent lost")),
    ).toMatchObject({ state: "Cancelled", accepted: false })
    expect(data(await cli(["reconcile"]))).toEqual({ running: [] })
  })
})

describe("report and prompt", () => {
  const dispatchWriter = async () =>
    String(data(await cli(["assignment", "dispatch"], writer())).id)
  const closeWith = async (id: string, stdin: string, ...flags: Array<string>) => {
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    return cli(["assignment", "close", id, "--outcome", "success", ...flags], stdin)
  }

  test("accepts a raw multi-line report, matching criteria and labels ignoring case", async () => {
    await createIntent()
    const id = await dispatchWriter()
    const closed = await closeWith(id, report("PARSES: ran it", "Tests: passed"), "--accept", "ok")
    expect(data(closed)).toMatchObject({ state: "Succeeded", accepted: true })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      acceptance: {
        criteria: [{ criterion: "parses", support: "ran it" }],
        evidence: [{ label: "tests", support: "passed" }],
      },
    })
  })

  test("refuses an evidence block that misses a label, naming it, and closes nothing", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const accept = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]

    const refused = await cli(accept, report("parses: ran it"))
    expect(refused.code).toBe(3)
    expect(refused.stderr).toContain("error: InsufficientAcceptance:")
    expect(refused.stderr).toContain('evidence label "tests"')
    expect(refused.stderr).not.toContain('criterion "parses"')
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      state: "Running",
    })

    const withoutBlock = await cli(accept, "all done, trust me")
    expect(withoutBlock.stderr).toContain('criterion "parses", evidence label "tests"')
  })

  test("accepts later from the stored report", async () => {
    await createIntent()
    const id = await dispatchWriter()
    expect(data(await closeWith(id, FULL_REPORT))).toMatchObject({ accepted: false })

    expect(
      data(await cli(["assignment", "accept", id, "--rationale", "reviewed the report"])),
    ).toMatchObject({ id, accepted: true, revision: 1 })
  })

  test("dispatch prints the Assignment as a prompt to send, for a spawn and for a continue", async () => {
    await createIntent()
    const draft = writer({ scope: ["the parser"], constraints: ["no deps"] })
    const raw = await cli(["assignment", "dispatch"], draft)
    const spawn = data(raw)
    const prompt = String(spawn.prompt)
    // The fields come first, then `prompt:` alone on its line, then the text verbatim.
    const [fields = "", trailer = ""] = raw.stdout.split(TRAILER)
    expect(fields).not.toContain("Role:")
    expect(trailer).toBe(`${prompt}\n`)
    expect(trailer).toStartWith("Role: Worker.implementation")
    expect(trailer).not.toContain("\\n")
    const order = [
      "Role: Worker.implementation",
      "Objective: Build the parser",
      "Scope:\n- the parser",
      "Constraints:\n- no deps",
      "Ownership paths (write only here):\n- src/parser.ts",
      "Acceptance criteria:\n- [blocking] parses (behavior)",
      "Required evidence:\n- tests",
      "End your report with an `evidence:` line",
    ].map((part) => prompt.indexOf(part))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))

    const first = String(spawn.id)
    await closeWith(first, FULL_REPORT, "--accept", "ok")
    const followUp = writer({ objective: "Fix the parser", followUpOf: first })
    const nextRaw = await cli(["assignment", "dispatch"], followUp)
    expect(nextRaw.stdout).toContain(`\ncontinue: agent-1\n`)
    expect(nextRaw.stdout.indexOf("continue:")).toBeLessThan(nextRaw.stdout.indexOf(TRAILER))
    const next = data(nextRaw)
    expect(next).toMatchObject({ continue: "agent-1" })
    expect(String(next.prompt)).toContain("Objective: Fix the parser")
    expect(String(next.prompt)).toContain("End your report with an `evidence:` line")
  })

  test("show and list print a line per Assignment unless --full is given", async () => {
    await createIntent()
    const id = await dispatchWriter()
    const line = data(await cli(["assignment", "show", id]))
    expect(line).toEqual({ assignments: [expect.objectContaining({ id, state: "Running" })] })
    expect(data(await cli(["assignment", "list"]))).toEqual(line)
    expect(data(await cli(["assignment", "list", "--full"]))).toMatchObject({
      assignments: [{ id, criteria: [{ text: "parses" }] }],
    })
  })
})

describe("close without a report, and report matching", () => {
  const running = async () => {
    await createIntent()
    const id = String(data(await cli(["assignment", "dispatch"], writer())).id)
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    return id
  }

  test("a lost or stopped specialist closes with empty stdin, keeping which outcome it was", async () => {
    const id = await running()
    expect(data(await cli(["assignment", "close", id, "--outcome", "interrupted"]))).toMatchObject({
      state: "Cancelled",
    })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      result: "interrupted",
    })

    const other = String(
      data(await cli(["assignment", "dispatch"], writer({ objective: "Second" }))).id,
    )
    data(await cli(["assignment", "close", other, "--outcome", "stopped"], "user pressed stop"))
    expect(data(await cli(["assignment", "show", other, "--full"]))).toMatchObject({
      state: "Cancelled",
      result: "stopped: user pressed stop",
    })
  })

  test("success still needs a report", async () => {
    const id = await running()
    const result = await cli(["assignment", "close", id, "--outcome", "success"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("error: StdinMissing: This command needs input on stdin")
  })

  test("a key that prefixes another key does not take the longer key's line", async () => {
    await createIntent()
    const draft = writer({
      criteria: [
        { text: "Handles errors", blocking: true, dimension: "behavior" },
        { text: "Handles errors: network", blocking: true, dimension: "behavior" },
      ],
      evidence: [],
    })
    const id = String(data(await cli(["assignment", "dispatch"], draft)).id)
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const close = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]

    const refused = await cli(close, report("Handles errors: network: retried 3 times"))
    expect(refused.code).toBe(3)
    expect(refused.stderr).toContain('criterion "Handles errors"')
    expect(refused.stderr).not.toContain('criterion "Handles errors: network"')

    // A bare longer key claims its line with no support; it is not support for the shorter key.
    const bare = await cli(close, report("Handles errors: network", "handles errors: caught"))
    expect(bare.code).toBe(3)
    expect(bare.stderr).toContain('criterion "Handles errors: network"')
    expect(bare.stderr).not.toContain('criterion "Handles errors",')

    const both = report("Handles errors: network: retried 3 times", "handles errors: caught")
    expect(data(await cli(close, both))).toMatchObject({ accepted: true })
  })
})

describe("command line", () => {
  test("flags: inherited names, values on boolean flags and a swallowed next flag are refused", async () => {
    await createIntent()
    for (const argv of [
      ["intent", "update", "--constructor"],
      ["intent", "update", "--material=false"],
      ["assignment", "close", "assignment-x", "--accept", "--outcome", "success"],
    ]) {
      const result = await cli(argv, "{}")
      expect(result.code).toBe(2)
      expect(result.stderr).toStartWith("error: Usage:")
    }
  })

  test("a group name with --help lists the group's commands", async () => {
    const help = await cli(["intent", "--help"])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("intent create")
    expect(help.stdout).toContain("intent use <id>")
    expect(help.stdout).not.toContain("assignment")
  })

  test("a bad role task is reported in one short line", async () => {
    await createIntent()
    const result = await cli(["assignment", "dispatch"], writer({ roleTask: "Worker.nope" }))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('["roleTask"]')
    expect(result.stderr).toContain("choices")
    expect(result.stderr.length).toBeLessThan(500)
    expect(result.stderr).not.toContain("excess property")
  })
})

describe("plan", () => {
  const readyPair = async () => {
    await createIntent()
    const ids = []
    for (const task of ["Reviewer.code", "Reviewer.security"])
      ids.push(String(data(await cli(["assignment", "create"], reviewer(task))).id))
    return ids
  }

  test("two independent Ready reviews run as a workflow when workflows are available", async () => {
    const ids = await readyPair()
    expect(data(await cli(["plan"]))).toMatchObject({
      action: "workflow",
      workflow: "review-diff",
      assignments: ids,
    })
  })

  test("without workflows the same set runs as parallel subagents", async () => {
    const ids = await readyPair()
    const disabled = data(await cli(["plan"], undefined, { CLAUDE_CODE_DISABLE_WORKFLOWS: "1" }))
    expect(disabled).toMatchObject({ action: "subagent", assignments: ids, parallel: true })

    await mkdir(join(project, ".claude"))
    await Bun.write(join(project, ".claude", "settings.local.json"), '{"enableWorkflows": false}')
    expect(data(await cli(["plan"]))).toMatchObject({ action: "subagent", assignments: ids })
  })

  test("a single Ready Assignment with a warm specialist is a continue", async () => {
    await createIntent()
    const first = await runToClose(writer(), "agent-1", true)
    const id = String(
      data(await cli(["assignment", "create"], writer({ objective: "Fix it", followUpOf: first })))
        .id,
    )
    expect(data(await cli(["plan"]))).toMatchObject({
      action: "continue",
      continue: "agent-1",
      assignments: [id],
    })
  })
})

describe("status", () => {
  test("an empty project prints one line", async () => {
    expect((await cli(["status"])).stdout).toBe("intents: []\n")
  })

  test("the same state prints the same bytes, in id order", async () => {
    const first = await createIntent()
    data(await cli(["intent", "create"], { objective: "Second task" }))
    data(await cli(["intent", "use", first]))
    const unaccepted = await runToClose(writer(), "agent-1")
    const running = String(
      data(await cli(["assignment", "dispatch"], writer({ ownershipPaths: ["src/other.ts"] }))).id,
    )

    const before = await cli(["status"])
    expect(await cli(["status"])).toEqual(before)
    expect(data(before)).toMatchObject({
      inUse: first,
      running: [{ id: running }],
      unaccepted: [{ id: unaccepted }],
    })
    const ids = (decode(before.stdout) as { intents: Array<{ id: string }> }).intents.map(
      (i) => i.id,
    )
    expect(ids).toEqual(ids.toSorted())
  })

  test("only open Intents are read, so closed history is never loaded", async () => {
    const closed = await createIntent()
    data(await cli(["intent", "close", "--reason", "shipped"]))
    const folder = join(
      project,
      ".holyagent",
      "intents",
      `parse-everything-${closed}`,
      "assignments",
    )
    await mkdir(folder, { recursive: true })
    await Bun.write(join(folder, "broken.json"), "{")

    expect((await cli(["status"])).stdout).toBe("intents: []\n")
    expect((await cli(["assignment", "list", "--all"])).code).toBe(4)
  })
})

describe("Intent in use", () => {
  test("with several open and none in use, a command that needs one lists them", async () => {
    const first = await createIntent()
    const second = String(data(await cli(["intent", "create"], { objective: "Other" })).id)
    expect(data(await cli(["intent", "show"]))).toMatchObject({ id: second })

    // A fresh clone has the Intents but no pointer to one of them.
    await rm(join(project, ".holyagent", "local", "active-intent.json"))
    const refused = await cli(["assignment", "list"])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("error: NoActiveIntent:")
    expect(refused.stderr).toContain(first)
    expect(refused.stderr).toContain(second)

    data(await cli(["intent", "use", first]))
    expect(data(await cli(["assignment", "list"]))).toEqual({ assignments: [] })
  })
})

describe("failures", () => {
  test("a usage error exits 2 with an error line and a hint line", async () => {
    const result = await cli(["assignment", "close", "assignment-x"])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe("")
    const [error, hint, end] = result.stderr.split("\n")
    expect(error).toBe("error: Usage: Missing --outcome")
    expect(hint).toStartWith("hint: Usage: holyagent assignment close ")
    expect(end).toBe("")
    expect((await cli(["bogus"])).code).toBe(2)
    await createIntent()
    expect((await cli(["plan"], undefined, { HOLYAGENT_REUSE_TTL_MINUTES: "soon" })).code).toBe(2)
  })

  test("a step the current state refuses exits 3 and changes nothing", async () => {
    await createIntent()
    const id = String(data(await cli(["assignment", "dispatch"], writer())).id)

    const again = await cli(["assignment", "dispatch"], { id })
    expect(again.code).toBe(3)
    expect(again.stderr).toStartWith(
      `error: InvalidTransition: Cannot dispatch ${id} while it is Running`,
    )

    const unrecorded = await cli(["assignment", "close", id, "--outcome", "success"], "done")
    expect(unrecorded.code).toBe(3)
    expect(unrecorded.stderr).toContain("SpecialistNotRecorded")
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      state: "Running",
    })
  })

  test("a corrupt state file exits 4 and names the file", async () => {
    await mkdir(join(project, ".holyagent", "intents", "x"), { recursive: true })
    await Bun.write(join(project, ".holyagent", "intents", "x", "intent.json"), "{}")
    const result = await cli(["status"])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain("error: CorruptRecord:")
    expect(result.stderr).toContain("intent.json")
  })

  test("stdin with an unknown field is refused and nothing is written", async () => {
    const intent = await cli(["intent", "create"], { objective: "Parse", extra: true })
    expect(intent.code).toBe(2)
    expect(intent.stderr).toContain("error: InvalidDraft:")
    expect(await cli(["status"])).toMatchObject({ stdout: "intents: []\n" })

    await createIntent()
    const draft = await cli(["assignment", "dispatch"], writer({ priority: "high" }))
    expect(draft.code).toBe(2)
    expect(draft.stderr).toContain("error: InvalidDraft:")
    expect(data(await cli(["assignment", "list", "--all"]))).toEqual({ assignments: [] })
  })

  test("a command that reads stdin and finds none exits 2", async () => {
    const result = await cli(["intent", "create"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("error: StdinMissing:")
  })
})

describe("process", () => {
  const main = join(import.meta.dir, "..", "src", "cli", "main.ts")

  test("the state root is the git top-level, and the entry point sets the exit code", async () => {
    await $`git init -q`.cwd(project).quiet()
    const inner = join(project, "packages", "app")
    await mkdir(inner, { recursive: true })

    const created = await $`bun ${main} intent create < ${new Response('{"objective":"Parse"}')}`
      .cwd(inner)
      .env({ ...process.env, HOME: home })
      .quiet()
      .nothrow()
    expect(created.exitCode).toBe(0)
    expect((await stat(join(project, ".holyagent"))).isDirectory()).toBe(true)
    expect(await Bun.file(join(inner, ".holyagent")).exists()).toBe(false)

    const unknown = await $`bun ${main} bogus`.cwd(inner).quiet().nothrow()
    expect(unknown.exitCode).toBe(2)
    expect(unknown.stderr.toString()).toStartWith("error: Usage:")
    expect((await $`bun ${main} --version`.quiet()).text()).toMatch(/^\d+\.\d+\.\d+\n$/)
  })
})
