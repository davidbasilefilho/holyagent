import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { dispatchedAssignment } from "../src/cli/report.ts"

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

describe("workflow runs", () => {
  const dispatchWriter = async () =>
    String(data(await cli(["assignment", "dispatch"], writer())).id)

  test("records a workflow's agent as workflow:<run-id>/<assignment-id> and nothing else of that kind", async () => {
    await createIntent()
    const id = await dispatchWriter()
    for (const bad of ["workflow:run-1", "workflow:run-1/assignment-other", "workflow:/" + id]) {
      const refused = await cli(["assignment", "record", id, "--agent", bad])
      expect(refused.code).toBe(2)
      expect(refused.stderr).toContain(`workflow:<run-id>/${id}`)
    }
    expect(
      data(await cli(["assignment", "record", id, "--agent", `workflow:run-1/${id}`])),
    ).toMatchObject({ id, state: "Running", agent: `workflow:run-1/${id}` })
  })

  test("a workflow's agent is never continued, even for a follow-up of its Assignment", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", `workflow:run-1/${id}`]))
    data(
      await cli(["assignment", "close", id, "--outcome", "success", "--accept", "ok"], FULL_REPORT),
    )
    const next = data(
      await cli(["assignment", "dispatch"], writer({ objective: "Fix it", followUpOf: id })),
    )
    expect(next).toMatchObject({ agent: "holyagent:worker-implementation" })
    expect(next).not.toHaveProperty("continue")
  })

  test("closes from the JSON report a workflow returned, evidence included", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", `workflow:run-1/${id}`]))
    const json = {
      status: "done",
      changed_paths: ["src/parser.ts"],
      checks: [{ command: "bun test", exit: 0 }],
      blockers: [],
      notes: ["none"],
      evidence: [
        { key: "parses", support: "ran the parser" },
        { key: "tests", support: "bun test passed" },
      ],
    }
    expect(
      data(
        await cli(
          ["assignment", "close", id, "--outcome", "success", "--accept", "ok", "--report-json"],
          json,
        ),
      ),
    ).toMatchObject({ state: "Succeeded", accepted: true })
    const stored = data(await cli(["assignment", "show", id, "--full"]))
    expect(stored.result).toBe(
      [
        "status: done",
        "changed:",
        "- src/parser.ts",
        "checks:",
        "- bun test -> exit 0",
        "notes:",
        "- none",
        "evidence:",
        "- parses: ran the parser",
        "- tests: bun test passed",
      ].join("\n"),
    )
  })

  test("refuses --accept for a report whose status is not done, and closes nothing", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", `workflow:run-1/${id}`]))
    const partial = {
      status: "partial",
      changed_paths: [],
      checks: [],
      blockers: ["no access"],
      notes: [],
      evidence: [
        { key: "parses", support: "ran the parser" },
        { key: "tests", support: "bun test passed" },
      ],
    }
    const refused = await cli(
      ["assignment", "close", id, "--outcome", "success", "--accept", "ok", "--report-json"],
      partial,
    )
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("status done")
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      state: "Running",
    })
    // Without --accept the root still records the partial report.
    expect(
      data(
        await cli(["assignment", "close", id, "--outcome", "success", "--report-json"], partial),
      ),
    ).toMatchObject({ state: "Succeeded", accepted: false })
  })

  test("keeps a field a workflow report carries beyond the known ones, so it can be closed verbatim", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", `workflow:run-1/${id}`]))
    const json = {
      status: "done",
      changed_paths: [],
      checks: [],
      blockers: [],
      notes: [],
      status_note: "n/a",
      evidence: [
        { key: "parses", support: "ran the parser" },
        { key: "tests", support: "bun test passed" },
      ],
    }
    expect(
      data(
        await cli(
          ["assignment", "close", id, "--outcome", "success", "--accept", "ok", "--report-json"],
          json,
        ),
      ),
    ).toMatchObject({ state: "Succeeded", accepted: true })
    const stored = String(data(await cli(["assignment", "show", id, "--full"])).result)
    expect(stored).toContain("status_note: n/a")
    expect(stored.indexOf("status_note: n/a")).toBeLessThan(stored.indexOf("evidence:"))
  })

  test("refuses a JSON report that is not one, and closes nothing", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", `workflow:run-1/${id}`]))
    const refused = await cli(
      ["assignment", "close", id, "--outcome", "success", "--report-json"],
      { status: "done" },
    )
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("error: InvalidDraft:")
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      state: "Running",
    })
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

  test("a Succeeded Assignment whose report lacks the evidence block takes a corrected report by close again", async () => {
    await createIntent()
    const id = await dispatchWriter()
    expect(data(await closeWith(id, "all done, trust me"))).toMatchObject({ accepted: false })
    // The stored report cannot be accepted, and the hint names a command that works.
    const gap = await cli(["assignment", "accept", id, "--rationale", "reviewed"])
    expect(gap.code).toBe(3)
    expect(gap.stderr).toContain("error: InsufficientAcceptance:")
    expect(gap.stderr).toContain("assignment close <id> --outcome success --accept")
    expect(gap.stderr).toContain("assignment accept <id> --rationale <text> --report")
    // A corrected report still short of the evidence stores nothing.
    const still = await cli(
      ["assignment", "close", id, "--outcome", "success", "--accept", "ok"],
      report("parses: ran it"),
    )
    expect(still.code).toBe(3)
    expect(data(await cli(["assignment", "show", id, "--full"])).result).toBe("all done, trust me")

    expect(
      data(
        await cli(
          ["assignment", "close", id, "--outcome", "success", "--accept", "ok"],
          FULL_REPORT,
        ),
      ),
    ).toMatchObject({ id, state: "Succeeded", accepted: true })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      result: FULL_REPORT,
    })
    // An accepted Assignment is final: closing it again is refused.
    const again = await cli(["assignment", "close", id, "--outcome", "success"], FULL_REPORT)
    expect(again.code).toBe(3)
    expect(again.stderr).toContain("error: InvalidTransition:")
  })

  test("a Succeeded Assignment takes a corrected report with accept --report", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await closeWith(id, "all done, trust me"))
    const short = await cli(
      ["assignment", "accept", id, "--rationale", "reviewed", "--report"],
      report("parses: ran it"),
    )
    expect(short.code).toBe(3)
    expect(data(await cli(["assignment", "show", id, "--full"])).result).toBe("all done, trust me")

    expect(
      data(
        await cli(["assignment", "accept", id, "--rationale", "reviewed", "--report"], FULL_REPORT),
      ),
    ).toMatchObject({ id, state: "Succeeded", accepted: true, revision: 1 })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      result: FULL_REPORT,
    })
  })

  test("evidence lines match their criteria after normalizing, and a different criterion still fails", async () => {
    await createIntent()
    const id = await dispatchWriter()
    const accept = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))

    // Another criterion's text is not this criterion's, however close.
    const wrong = await cli(accept, report("parse: ran it", "tests: passed"))
    expect(wrong.code).toBe(3)
    expect(wrong.stderr).toContain('criterion "parses"')

    // Case, spacing, trailing punctuation, the prompt's `[blocking]` marker and `(dimension)`.
    const closed = await cli(
      accept,
      report("[blocking] Parses  (behavior): ran it", "**Tests.**: bun test passed"),
    )
    expect(data(closed)).toMatchObject({ accepted: true })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      acceptance: {
        criteria: [{ criterion: "parses", support: "ran it" }],
        evidence: [{ label: "tests", support: "bun test passed" }],
      },
    })
  })

  test("a key line whose support is only emphasis marks and punctuation is no support", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const accept = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]
    for (const block of [
      report("**parses:**", "**tests:**"),
      report("parses: **", "tests: passed"),
      report("parses: `` .", "tests: passed"),
      report("- parses: ---", "tests: passed"),
    ]) {
      const refused = await cli(accept, block)
      expect(refused.code).toBe(3)
      expect(refused.stderr).toContain("error: InsufficientAcceptance:")
      expect(refused.stderr).toContain('criterion "parses"')
    }
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      state: "Running",
    })
    expect(
      data(await cli(accept, report("**parses:** ran it", "tests: `bun test`"))),
    ).toMatchObject({ accepted: true })
  })

  test("a support given as indented sub-bullets under its entry counts", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const nested = [
      "Built it.",
      "",
      "evidence:",
      "- [blocking] parses (behavior):",
      "  - ran the parser on nested input",
      "  - exit 0",
      "- tests: bun test passed",
      "  - 12 pass",
    ].join("\n")
    expect(
      data(
        await cli(["assignment", "close", id, "--outcome", "success", "--accept", "ok"], nested),
      ),
    ).toMatchObject({ accepted: true })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      acceptance: {
        criteria: [{ criterion: "parses", support: "ran the parser on nested input; exit 0" }],
        evidence: [{ label: "tests", support: "bun test passed; 12 pass" }],
      },
    })
  })

  test("the prompt's first line names its Assignment, and nothing else is taken for a dispatch", async () => {
    await createIntent()
    const dispatched = data(await cli(["assignment", "dispatch"], writer()))
    const prompt = String(dispatched.prompt)
    expect(dispatchedAssignment(prompt)).toBe(String(dispatched.id))
    expect(dispatchedAssignment(`${prompt}\nExtra`)).toBe(String(dispatched.id))
    for (const other of [
      "Fix the bug",
      `Please run\n${prompt}`,
      `Role: x. Assignment: ${String(dispatched.id)}.`,
      prompt.replace("Assignment: assignment-", "Assignment: intent-"),
      "",
    ])
      expect(dispatchedAssignment(other)).toBeUndefined()
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

  test("a criterion text that holds a colon takes the line keyed by all of it", async () => {
    await createIntent()
    const text = "mise run verify: command, exit code and pass/fail counts on the current head"
    const draft = writer({
      criteria: [{ text, blocking: true, dimension: "regressions" }],
      evidence: [],
    })
    const id = String(data(await cli(["assignment", "dispatch"], draft)).id)
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const close = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]

    // The key cut at its first colon is not the criterion, so it is no support for it.
    const cut = await cli(close, report("mise run verify: `mise run verify` -> exit 0"))
    expect(cut.code).toBe(3)
    expect(cut.stderr).toContain(`criterion "${text}"`)

    const whole = report(`${text}: \`mise run verify\` -> exit 0: 12 pass / 0 fail`)
    expect(data(await cli(close, whole))).toMatchObject({ accepted: true })
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

  test("help is --help as a word, for the top level, a group and a command", async () => {
    for (const [word, flag] of [
      [["help"], ["--help"]],
      [
        ["help", "assignment"],
        ["assignment", "--help"],
      ],
      [
        ["help", "assignment", "close"],
        ["assignment", "close", "--help"],
      ],
      [
        ["help", "plan"],
        ["plan", "--help"],
      ],
    ] as const) {
      const words = await cli(word)
      expect(words.code).toBe(0)
      expect(words).toEqual(await cli(flag))
    }
    expect((await cli(["help", "nothing"])).code).toBe(2)
  })

  test("the help carries what a model needs to run Assignments without a manual", async () => {
    const help = async (...words: Array<string>) => (await cli(["help", ...words])).stdout
    const dispatch = await help("assignment", "dispatch")
    for (const part of [
      "roleTask",
      "criteria",
      "dimension: behavior|regressions|tests|scope|style|repo-standards",
      "ownershipPaths",
      "dependencies",
      "independentFrom",
      "followUpOf",
      "checks-run",
      '{"id": "<id>"}',
      "prompt:",
    ])
      expect(dispatch).toContain(part)
    const close = await help("assignment", "close")
    for (const part of [
      "success|failure|errored|interrupted|stopped",
      "evidence:",
      "<criterion text or evidence label>: <support>",
      "InsufficientAcceptance",
      "--report-json",
    ])
      expect(close).toContain(part)
    expect(await help("assignment", "record")).toContain("a hook records")
    expect(close).toContain("a workflow agent cannot be messaged")
    const accept = await help("assignment", "accept")
    expect(accept).toContain("--carry-forward")
    expect(accept).toContain("validation Assignment")
    expect(await help("intent", "update")).toContain("--material")
    const plan = await help("plan")
    for (const part of [
      "write the inline script yourself",
      "{id, agent, model, effort, prompt}",
      "one agent() per entry",
      "agentType holyagent:<agent>",
      "runs without a permission prompt",
      "fallback",
      "Workflow tool is disabled or unavailable",
      "workflow:<run-id>/<id>",
      "verbatim",
    ])
      expect(plan).toContain(part)
    for (const gone of ["holyagent:run-assignments", "holyagent:review-diff", "prebuilt"])
      expect(plan).not.toContain(gone)
    expect(await help()).toContain("hint:")
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
    const plan = data(await cli(["plan"]))
    expect(plan).toMatchObject({
      action: "workflow",
      assignments: ids,
      fallback: { action: "subagent", assignments: ids, parallel: true },
    })
    // The root writes the script itself, so the plan names no prebuilt workflow.
    expect(plan).not.toHaveProperty("workflow")
  })

  test("the workflow comes first and its subagent fallback says when to use it", async () => {
    await readyPair()
    const plan = data(await cli(["plan"]))
    expect(Object.keys(plan).indexOf("action")).toBeLessThan(Object.keys(plan).indexOf("fallback"))
    expect(plan.fallback).toMatchObject({
      when: "only if the Workflow tool is disabled or unavailable",
    })
  })

  test("a writer and the review that names it in independentFrom are planned as writer then review", async () => {
    await createIntent()
    const w = String(data(await cli(["assignment", "create"], writer())).id)
    const r = String(
      data(await cli(["assignment", "create"], reviewer("Reviewer.code", { independentFrom: [w] })))
        .id,
    )
    expect(data(await cli(["plan"]))).toMatchObject({
      action: "workflow",
      assignments: [w, r],
      fallback: { action: "subagent", assignments: [w], afterwards: [r] },
    })
  })

  test("without workflows the same set runs as parallel subagents", async () => {
    const ids = await readyPair()
    const disabled = data(await cli(["plan"], undefined, { CLAUDE_CODE_DISABLE_WORKFLOWS: "1" }))
    expect(disabled).toMatchObject({
      action: "subagent",
      assignments: ids,
      parallel: true,
      reason: "the Workflow tool is disabled or unavailable",
    })
    expect(disabled).not.toHaveProperty("fallback")

    await mkdir(join(project, ".claude"))
    await Bun.write(join(project, ".claude", "settings.local.json"), '{"enableWorkflows": false}')
    expect(data(await cli(["plan"]))).toMatchObject({ action: "subagent", assignments: ids })
  })

  test("a single Ready Assignment is a one-entry workflow, and direct subagents only without the tool", async () => {
    await createIntent()
    const id = String(data(await cli(["assignment", "create"], writer())).id)
    expect(data(await cli(["plan"]))).toMatchObject({
      action: "workflow",
      assignments: [id],
      fallback: { action: "subagent", assignments: [id] },
    })
    expect(
      data(await cli(["plan"], undefined, { CLAUDE_CODE_DISABLE_WORKFLOWS: "1" })),
    ).toMatchObject({
      action: "subagent",
      assignments: [id],
    })
  })

  test("work that continues a warm specialist is listed beside the workflow", async () => {
    await createIntent()
    const first = await runToClose(writer(), "agent-1", true)
    const follow = String(
      data(await cli(["assignment", "create"], writer({ objective: "Fix it", followUpOf: first })))
        .id,
    )
    const other = String(
      data(await cli(["assignment", "create"], writer({ ownershipPaths: ["src/other.ts"] }))).id,
    )
    const plan = data(await cli(["plan"]))
    expect(plan).toMatchObject({
      action: "workflow",
      assignments: [other],
      continues: [{ assignment: follow, agent: "agent-1" }],
    })
    expect(String(plan.reason)).toContain("SendMessage")
    expect(plan.fallback).toMatchObject({ assignments: [other] })
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
    await rm(join(project, ".holyagent", "local", "active-intent"), { recursive: true })
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
    expect(result.stderr).toContain("hint: Give the input as --input '<json>' or pipe it in")
  })
})

describe("process", () => {
  const main = join(import.meta.dir, "..", "src", "cli", "main.ts")

  test("the state lives in the shared state worktree, and the entry point sets the exit code", async () => {
    await $`git init -q -b main`.cwd(project).quiet()
    await $`git -c user.name=Octo -c user.email=octo@example.com commit -q --allow-empty -m seed`
      .cwd(project)
      .quiet()
    const inner = join(project, "packages", "app")
    await mkdir(inner, { recursive: true })

    const created = await $`bun ${main} intent create < ${new Response('{"objective":"Parse"}')}`
      .cwd(inner)
      .env({ ...process.env, HOME: home })
      .quiet()
      .nothrow()
    expect(created.exitCode).toBe(0)
    // Not in the work tree, nor in the folder the command ran in: in the worktree of the state branch.
    expect(await Bun.file(join(project, ".holyagent")).exists()).toBe(false)
    expect(await Bun.file(join(inner, ".holyagent")).exists()).toBe(false)
    const listed = (await $`git worktree list --porcelain`.cwd(project).quiet().text()).split(
      "\n\n",
    )
    const worktree = listed
      .find((block) => block.includes("\nbranch refs/heads/holyagent/state"))
      ?.split("\n")[0]
      ?.replace("worktree ", "")
    expect(worktree).toStartWith(join(project, ".git", "holyagent"))
    expect((await stat(join(worktree ?? "", ".holyagent", "intents"))).isDirectory()).toBe(true)

    const unknown = await $`bun ${main} bogus`.cwd(inner).quiet().nothrow()
    expect(unknown.exitCode).toBe(2)
    expect(unknown.stderr.toString()).toStartWith("error: Usage:")
    expect((await $`bun ${main} --version`.quiet()).text()).toMatch(/^\d+\.\d+\.\d+(?:-\d+)?\n$/)
  })
})
