import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"
import { Effect } from "effect"

import { parseArgs, readFlags } from "../src/cli/args.ts"
import { StdinMissing } from "../src/cli/errors.ts"
import { pushTargets } from "../src/cli/git-push.ts"
import { run } from "../src/cli/program.ts"
import { dispatchedAssignment } from "../src/cli/report.ts"
import { workflowRefusal } from "../src/cli/workflow-check.ts"
import { fromGitPath } from "../src/domain/paths.ts"

// A test that makes a repository and a state worktree runs a dozen git processes, and process
// creation on Windows is slow enough on the CI runner (2.7 seconds for one such test, a stall of 5
// for another) to pass Bun's 5 second default; a slow test there is not a hung one. Linux and macOS
// keep the default.
if (process.platform === "win32") setDefaultTimeout(60_000)
afterAll(() => setDefaultTimeout(5_000))

let project: string
let home: string

beforeEach(async () => {
  // The real path: on Windows the temporary folder is named by its 8.3 short form (`RUNNER~1`), and
  // git and the CLI report the long form, so a path built from the short one would never match.
  project = await realpath(await mkdtemp(join(tmpdir(), "holyagent-cli-")))
  home = await realpath(await mkdtemp(join(tmpdir(), "holyagent-home-")))
})
afterEach(() =>
  Promise.all([
    // A git process or a scanner can still hold a file of the folder when the test ends (EBUSY on
    // Windows), so the removal retries, as in stdin.test.ts.
    rm(project, { recursive: true, force: true, maxRetries: 5 }),
    rm(home, { recursive: true, force: true, maxRetries: 5 }),
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

/** The path of the brief file a dispatch prompt names. */
const briefPathOf = (prompt: string): string => /at (\S+\.md) with/.exec(prompt)?.[1] ?? ""

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
    expect(gap.stderr).toContain(`assignment close ${id} --outcome success --accept`)
    expect(gap.stderr).toContain(`assignment accept ${id} --rationale <text> --report`)
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

  test("a key line with nothing after its colon takes the list items directly below it, up to the next key line", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const accept = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]
    // The shape of a repair report: the key alone, then unindented list items, then the next key.
    const listed = [
      "Built it.",
      "",
      "evidence:",
      "parses:",
      "- `parse` runs the parser on nested input.",
      "- Tests in parser.test.ts:",
      "  - nested input.",
      "- `bun test` -> exit 0.",
      "tests:",
      "- 12 pass, 0 fail",
    ].join("\n")
    expect(data(await cli(accept, listed))).toMatchObject({ accepted: true })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      acceptance: {
        criteria: [
          {
            criterion: "parses",
            support:
              "`parse` runs the parser on nested input.; Tests in parser.test.ts: nested input.; `bun test` -> exit 0.",
          },
        ],
        evidence: [{ label: "tests", support: "12 pass, 0 fail" }],
      },
    })
  })

  test("an unindented checkbox item below a key line is support exactly when a dash checkbox item is", async () => {
    await createIntent()
    for (const item of ["[x] ran it", "- [x] ran it", "[ ] ran it"]) {
      const id = await dispatchWriter()
      data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
      const text = ["Built it.", "", "evidence:", "parses:", item, "tests: passed"].join("\n")
      const accept = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]
      expect(data(await cli(accept, text))).toMatchObject({ accepted: true })
      expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
        acceptance: { criteria: [{ criterion: "parses", support: "ran it" }] },
      })
    }
  })

  test("a key line followed by unindented text, or by a list after a blank line, is still no support", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const accept = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]
    for (const text of [
      ["parses:", "Looks fine.", "tests: passed"],
      ["parses:", "tests: passed", "", "Looks fine."],
      ["parses:", "", "- ran it", "tests: passed"],
      ["parses:", "Looks fine.", "- ran it", "tests: passed"],
    ]) {
      const refused = await cli(accept, ["Built it.", "", "evidence:", ...text].join("\n"))
      expect(refused.code).toBe(3)
      expect(refused.stderr).toContain('criterion "parses"')
    }
  })

  test("indented lines directly below a key line with nothing after its colon are its support", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const accept = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]
    const indented = ["Built it.", "", "evidence:", "parses:", "  ran it", "tests: passed"].join(
      "\n",
    )
    expect(data(await cli(accept, indented))).toMatchObject({ accepted: true })
  })

  test("a key line with nothing below it before the next key line is still no support", async () => {
    await createIntent()
    const id = await dispatchWriter()
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const refused = await cli(
      ["assignment", "close", id, "--outcome", "success", "--accept", "ok"],
      report("parses:", "tests: passed"),
    )
    expect(refused.code).toBe(3)
    expect(refused.stderr).toContain('criterion "parses"')
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

  test("dispatch writes the Assignment to a brief file and prints a short prompt that names it", async () => {
    await createIntent()
    const draft = writer({ scope: ["the parser"], constraints: ["no deps"] })
    const raw = await cli(["assignment", "dispatch"], draft)
    const spawn = data(raw)
    const prompt = String(spawn.prompt)
    // The fields come first, then `prompt:` alone on its line, then the short prompt verbatim.
    const [fields = "", trailer = ""] = raw.stdout.split(TRAILER)
    expect(fields).not.toContain("Role:")
    expect(trailer).toBe(`${prompt}\n`)
    expect(trailer).toStartWith("Role: Worker.implementation (holyagent:worker-implementation)")
    expect(trailer).not.toContain("\\n")
    expect(prompt.split("\n")).toHaveLength(2)
    expect(prompt).toContain("Read tool")
    // The path and the brief's role are each named once.
    expect(prompt.split("full task")).toHaveLength(2)
    expect(prompt.split("briefs")).toHaveLength(2)
    // The brief text is not printed.
    for (const text of ["Objective:", "Build the parser", "Acceptance criteria", "no deps"])
      expect(raw.stdout).not.toContain(text)

    const path = briefPathOf(prompt)
    expect(path).toBe(join(project, ".holyagent", "local", "briefs", `${String(spawn.id)}.md`))
    const brief = await Bun.file(path).text()
    const order = [
      "Role: Worker.implementation",
      "Objective: Build the parser",
      "Scope:\n- the parser",
      "Constraints:\n- no deps",
      "Ownership paths (write only here):\n- src/parser.ts",
      "Acceptance criteria:\n- [blocking] parses (behavior)",
      "Required evidence:\n- tests",
      "End your report with an `evidence:` line",
    ].map((part) => brief.indexOf(part))
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
    expect(nextRaw.stdout).not.toContain("Fix the parser")
    expect(String(next.prompt)).toContain("Read tool")
    const nextBrief = await Bun.file(briefPathOf(String(next.prompt))).text()
    expect(nextBrief).toContain("Objective: Fix the parser")
    expect(nextBrief).toContain("End your report with an `evidence:` line")
  })

  test("a dispatch by id writes the brief too, and a dispatch that is refused writes none", async () => {
    await createIntent()
    const planned = writer()
    const created = String(data(await cli(["assignment", "create"], planned)).id)
    const dispatched = data(await cli(["assignment", "dispatch"], { id: created }))
    expect(await Bun.file(briefPathOf(String(dispatched.prompt))).text()).toContain(
      `Assignment: ${created}.`,
    )

    const folder = join(project, ".holyagent", "local", "briefs")
    const before = await readdir(folder)
    const again = await cli(["assignment", "dispatch"], { id: created })
    expect(again.code).toBe(3)
    expect(await readdir(folder)).toEqual(before)
  })

  test("a brief that cannot be written leaves the Assignment Ready, and a later dispatch works", async () => {
    await createIntent()
    const created = String(data(await cli(["assignment", "create"], writer())).id)
    // A file where the brief folder belongs makes the write fail after the dispatch was decided.
    const folder = join(project, ".holyagent", "local", "briefs")
    await mkdir(join(project, ".holyagent", "local"), { recursive: true })
    await Bun.write(folder, "not a folder")

    const refused = await cli(["assignment", "dispatch"], { id: created })
    expect(refused.code).toBe(4)
    expect(refused.stderr).toContain("error:")
    const shown = data(await cli(["assignment", "show", created]))
    expect(shown).toMatchObject({ assignments: [{ id: created, state: "Ready" }] })

    await rm(folder)
    const dispatched = data(await cli(["assignment", "dispatch"], { id: created }))
    expect(dispatched).toMatchObject({ id: created, state: "Running" })
    expect(await Bun.file(briefPathOf(String(dispatched.prompt))).exists()).toBe(true)
  })

  test("in a repository the brief lives in the git common directory, outside every work tree", async () => {
    await $`git init -q -b main`.cwd(project).quiet()
    await $`git -c user.name=Octo -c user.email=octo@example.com commit -q --allow-empty -m seed`
      .cwd(project)
      .quiet()
    await createIntent()
    const dispatched = data(await cli(["assignment", "dispatch"], writer()))
    const path = briefPathOf(String(dispatched.prompt))
    expect(path).toBe(join(project, ".git", "holyagent", "briefs", `${String(dispatched.id)}.md`))
    expect(await Bun.file(path).text()).toContain("Objective: Build the parser")
    // Neither the work tree nor the state worktree holds it, so no commit can carry it.
    expect((await $`git status --porcelain`.cwd(project).quiet().text()).trim()).toBe("")
    expect(await $`git ls-files`.cwd(project).quiet().text()).not.toContain("briefs")
    expect(
      await $`git ls-tree -r --name-only holyagent/state`.cwd(project).quiet().text(),
    ).not.toContain("briefs")
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

    // The key cut at the first colon is the criterion's label, so it names the criterion too.
    const cut = await cli(close, report("mise run verify: `mise run verify` -> exit 0: 12 pass"))
    expect(data(cut)).toMatchObject({ accepted: true })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      acceptance: {
        criteria: [{ criterion: text, support: "`mise run verify` -> exit 0: 12 pass" }],
      },
    })
  })

  test("a criterion text that holds a colon still takes the line keyed by all of it", async () => {
    await createIntent()
    const text = "mise run verify: command, exit code and pass/fail counts on the current head"
    const draft = writer({
      criteria: [{ text, blocking: true, dimension: "regressions" }],
      evidence: [],
    })
    const id = String(data(await cli(["assignment", "dispatch"], draft)).id)
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const close = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]
    const whole = report(`${text}: \`mise run verify\` -> exit 0: 12 pass / 0 fail`)
    expect(data(await cli(close, whole))).toMatchObject({ accepted: true })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      acceptance: {
        criteria: [{ criterion: text, support: "`mise run verify` -> exit 0: 12 pass / 0 fail" }],
      },
    })
  })

  test("a label that two criteria share names none of them", async () => {
    await createIntent()
    const draft = writer({
      criteria: [
        { text: "Parser: handles nesting", blocking: true, dimension: "behavior" },
        { text: "Parser: rejects junk", blocking: true, dimension: "behavior" },
      ],
      evidence: [],
    })
    const id = String(data(await cli(["assignment", "dispatch"], draft)).id)
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const close = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]

    // `Parser` is ambiguous, so only the full text of the second criterion is a key.
    const refused = await cli(close, report("Parser: nested ok", "Parser: handles nesting: yes"))
    expect(refused.code).toBe(3)
    expect(refused.stderr).toContain('criterion "Parser: rejects junk"')
    expect(refused.stderr).not.toContain('criterion "Parser: handles nesting"')

    const closed = await cli(
      close,
      report("Parser: handles nesting: yes", "Parser: rejects junk: yes"),
    )
    expect(data(closed)).toMatchObject({ accepted: true })
  })

  test("a criterion label that equals an evidence label is supported by the one line that names both", async () => {
    await createIntent()
    const draft = writer({
      criteria: [
        { text: "Autocompact: the root text still fits", blocking: true, dimension: "behavior" },
        { text: "Scope", blocking: true, dimension: "scope" },
      ],
      evidence: ["autocompact", "scope"],
    })
    const id = String(data(await cli(["assignment", "dispatch"], draft)).id)
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const close = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]

    expect(
      data(await cli(close, report("Autocompact: held at 60%", "scope: only the owned paths"))),
    ).toMatchObject({
      accepted: true,
    })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      acceptance: {
        criteria: [
          { criterion: "Autocompact: the root text still fits", support: "held at 60%" },
          { criterion: "Scope", support: "only the owned paths" },
        ],
        evidence: [
          { label: "autocompact", support: "held at 60%" },
          { label: "scope", support: "only the owned paths" },
        ],
      },
    })
  })

  test("hyphens and underscores read as spaces, and list markers and bold around a key are ignored", async () => {
    await createIntent()
    const draft = writer({
      criteria: [{ text: "Agent effort", blocking: true, dimension: "behavior" }],
      evidence: ["Token totals", "Root context", "Repo standards", "diff file"],
    })
    const id = String(data(await cli(["assignment", "dispatch"], draft)).id)
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const close = ["assignment", "close", id, "--outcome", "success", "--accept", "ok"]
    const lines = [
      "agent-effort: high on the root, medium on the workers",
      "- Token totals: 41k in, 6k out",
      "**Root context**: 38k of 200k",
      "1. repo_standards: no rule broken",
      "* [x] **diff-file**: /tmp/holyagent-review/x.diff",
    ]
    expect(data(await cli(close, report(...lines)))).toMatchObject({ accepted: true })
  })

  test("a criterion is matched by its label as well, in a stored report accepted later", async () => {
    await createIntent()
    const draft = writer({
      criteria: [
        { text: "Brief files: written outside the tree", blocking: true, dimension: "behavior" },
      ],
    })
    const id = String(data(await cli(["assignment", "dispatch"], draft)).id)
    data(await cli(["assignment", "record", id, "--agent", "agent-1"]))
    const labelled = report("[blocking] Brief files (behavior): ran it", "tests: passed")
    data(await cli(["assignment", "close", id, "--outcome", "success"], labelled))
    expect(data(await cli(["assignment", "accept", id, "--rationale", "checked"]))).toMatchObject({
      accepted: true,
    })
    expect(data(await cli(["assignment", "show", id, "--full"]))).toMatchObject({
      acceptance: {
        criteria: [{ criterion: "Brief files: written outside the tree", support: "ran it" }],
      },
    })
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
      "a writer followed by the review of its work",
      "as the root workflow text says",
      "`continues` lists Ready work that continues a warm specialist",
      "Workflow tool is disabled or unavailable",
      "`afterwards` reviews launch once the writers they depend on are terminal",
    ])
      expect(plan).toContain(part)
    for (const gone of [
      "holyagent:run-assignments",
      "holyagent:review-diff",
      "prebuilt",
      "keyed by Assignment id",
      "null report",
    ])
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

  test("lists the Running and unaccepted Assignments of the Intent in use only, and counts the others'", async () => {
    const first = await createIntent()
    const firstRunning = String(data(await cli(["assignment", "dispatch"], writer())).id)
    const firstDone = await runToClose(writer({ ownershipPaths: ["src/b.ts"] }), "agent-2")
    const second = String(data(await cli(["intent", "create"], { objective: "Other" })).id)
    const secondRunning = String(
      data(await cli(["assignment", "dispatch"], writer({ ownershipPaths: ["src/c.ts"] }))).id,
    )
    const secondDone = await runToClose(writer({ ownershipPaths: ["src/d.ts"] }), "agent-3")
    await runToClose(writer({ ownershipPaths: ["src/e.ts"] }), "agent-4", true)

    // The second Intent is in use: its rows are listed and the first one gets counts.
    const inSecond = data(await cli(["status"])) as {
      inUse: string
      intents: Array<Record<string, unknown>>
      running: Array<{ id: string }>
      unaccepted: Array<{ id: string }>
    }
    expect(inSecond.inUse).toBe(second)
    expect(inSecond.running.map((row) => row.id)).toEqual([secondRunning])
    expect(inSecond.unaccepted.map((row) => row.id)).toEqual([secondDone])
    expect(inSecond.intents.find((row) => row.id === first)).toMatchObject({
      running: 1,
      unaccepted: 1,
    })
    expect(inSecond.intents.find((row) => row.id === second)).not.toHaveProperty("running")
    const text = (await cli(["status"])).stdout
    expect(text).not.toContain(firstRunning)
    expect(text).not.toContain(firstDone)

    data(await cli(["intent", "use", first]))
    const inFirst = data(await cli(["status"])) as typeof inSecond
    expect(inFirst.running.map((row) => row.id)).toEqual([firstRunning])
    expect(inFirst.unaccepted.map((row) => row.id)).toEqual([firstDone])
    expect(inFirst.intents.find((row) => row.id === second)).toMatchObject({
      running: 1,
      unaccepted: 1,
    })
  })

  test("with several Intents open and none in use, only the counts show", async () => {
    await createIntent()
    const running = String(data(await cli(["assignment", "dispatch"], writer())).id)
    data(await cli(["intent", "create"], { objective: "Other" }))
    await rm(join(project, ".holyagent", "local", "active-intent"), { recursive: true })

    const result = await cli(["status"])
    const status = data(result) as { intents: Array<Record<string, unknown>> }
    expect(status).not.toHaveProperty("inUse")
    expect(status).not.toHaveProperty("running")
    expect(status.intents.map((row) => row.running)).toEqual([1, 0])
    expect(result.stdout).not.toContain(running)
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
    // Git prints `C:/repo/...` on Windows, and join() gives backslashes there.
    expect(worktree === undefined ? undefined : fromGitPath(worktree)).toStartWith(
      join(project, ".git", "holyagent"),
    )
    expect((await stat(join(worktree ?? "", ".holyagent", "intents"))).isDirectory()).toBe(true)

    const unknown = await $`bun ${main} bogus`.cwd(inner).quiet().nothrow()
    expect(unknown.exitCode).toBe(2)
    expect(unknown.stderr.toString()).toStartWith("error: Usage:")
    expect((await $`bun ${main} --version`.quiet()).text()).toMatch(/^\d+\.\d+\.\d+(?:-\d+)?\n$/)
  })
})

describe("the workflow check refuses scripts that could hang or exhaust memory", () => {
  const AGENT = "await agent('p', { agentType: 'holyagent:worker-implementation' })"
  const refusal = (...lines: ReadonlyArray<string>) =>
    Effect.runPromise(workflowRefusal([...lines, AGENT].join("\n")))

  test.each<readonly [string, string]>([
    ["a while loop", "while (true) {}"],
    ["a while loop with a test", "let n = 0\nwhile (n < 3) { n += 1 }"],
    ["a do loop", "let n = 0\ndo { n += 1 } while (n < 3)"],
    ["a for loop with no head", "for (;;) {}"],
    ["a for loop with no bound", "for (let i = 0; ; i++) {}"],
    ["a for loop over a huge literal bound", "for (let i = 0; i < 1e12; i++) {}"],
    ["a for loop over a bound just above the limit", "for (let i = 0; i < 1001; i++) {}"],
    ["a for loop bounded by data", "for (let i = 0; i < args.n; i++) {}"],
    ["a for loop bounded by a name", "const n = 3\nfor (let i = 0; i < n; i++) {}"],
    ["a for loop that counts away from its bound", "for (let i = 0; i < 10; i--) {}"],
    ["a for loop that does not step", "for (let i = 0; i < 10; i += 0) {}"],
    ["a for loop that steps by a computed amount", "for (let i = 0; i < 10; i += args.step) {}"],
    ["a for loop with a var counter", "for (var i = 0; i < 10; i++) {}"],
    ["a for loop with two counters", "for (let i = 0, j = 0; i < 10; i++) {}"],
    ["a for loop whose body resets the counter", "for (let i = 0; i < 10; i++) { i = 0 }"],
    ["a for loop whose body steps the counter back", "for (let i = 0; i < 10; i++) { i-- }"],
    [
      "a for loop whose body destructures into the counter",
      "for (let i = 0; i < 10; i++) { [i] = [0] }",
    ],
    [
      "a for loop whose closure resets the counter",
      "for (let i = 0; i < 10; i++) { [1].forEach(() => { i = 0 }) }",
    ],
    [
      "loops nested past the total limit",
      "for (let i = 0; i < 1000; i++) { for (let j = 0; j < 1000; j++) {} }",
    ],
    [
      "a for-of loop that keeps adding to the array it walks",
      "const xs = [1]\nfor (const x of xs) { xs.push(x) }",
    ],
    [
      "a for-of loop that writes past the end of the array it walks",
      "const xs = [1]\nfor (const x of xs) { xs[xs.length] = x }",
    ],
    ["repeat with a huge count", "'x'.repeat(2 ** 30)"],
    ["repeat with a huge literal", "'x'.repeat(1073741824)"],
    ["repeat with a count from data", "'x'.repeat(args.n)"],
    ["repeat with a count from a name", "const n = 5\n'x'.repeat(n)"],
    ["repeat with a spread count", "'x'.repeat(...args.counts)"],
    ["padStart with a huge count", "'x'.padStart(1e9, 'y')"],
    ["padStart with a count from data", "'x'.padStart(args.width)"],
    ["padEnd with a huge count", "'x'.padEnd(2 ** 30)"],
    ["padEnd with a count from data", "'x'.padEnd(args.width, '-')"],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    ["a counted loop up", "for (let i = 0; i < 10; i++) { log(i) }"],
    ["a counted loop that includes its bound", "for (let i = 1; i <= 3; ++i) { log(i) }"],
    ["a counted loop down", "for (let i = 5; i > 0; i--) { log(i) }"],
    ["a counted loop with a step", "for (let i = 0; i < 100; i += 10) { log(i) }"],
    ["a counted loop at the limit", `for (let i = 0; i < 1000; i++) { log(i) }`],
    [
      "a counted loop indexing and growing other data",
      "const rows = []\nlet total = 0\nfor (let i = 0; i < 3; i++) { rows.push(i); total += i }",
    ],
    [
      "nested counted loops within the total limit",
      "for (let i = 0; i < 100; i++) { for (let j = 0; j < 100; j++) { log(i, j) } }",
    ],
    [
      "a counted loop with break and continue",
      "for (let i = 0; i < 5; i++) { if (i === 2) continue; if (i > 3) break }",
    ],
    ["a for-of loop over data", "for (const entry of args.entries) { log(entry) }"],
    [
      "a for-of loop that fills another array",
      "const out = []\nfor (const entry of args.entries) { out.push(entry) }",
    ],
    ["a for-in loop", "for (const key in args) { log(key) }"],
    ["repeat with a small literal", "log('x'.repeat(3))"],
    ["repeat at the limit", "log('x'.repeat(1000))"],
    ["padStart and padEnd with small literals", "log('7'.padStart(2, '0'), 'a'.padEnd(10))"],
    [
      "map and forEach over data",
      "log(args.entries.map((e) => e.id))\nargs.entries.forEach((e) => log(e))",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("one flag parser for every command", () => {
  const SPEC = { title: "string", force: "boolean" } as const

  test("after -- every argument is a positional, so a positional may start with dashes", async () => {
    const parsed = await Effect.runPromise(
      parseArgs(["--title", "t", "--", "--force", "--title"], SPEC, "x"),
    )
    expect(parsed).toEqual({ positionals: ["--force", "--title"], flags: { title: "t" } })
  })

  test("reads --name value, --name=value and switches", async () => {
    const parsed = await Effect.runPromise(
      parseArgs(["a", "--title=--t", "--force", "b"], SPEC, "x"),
    )
    expect(parsed).toEqual({ positionals: ["a", "b"], flags: { title: "--t", force: true } })
  })

  test.each<readonly [string, ReadonlyArray<string>, string]>([
    ["an unknown flag", ["--nope"], "Unknown flag --nope"],
    ["an unknown short flag", ["-x"], "Unknown flag -x"],
    ["the text -undefined, which no flag spells", ["-undefined", "v"], "Unknown flag -undefined"],
    ["a switch given a value", ["--force=yes"], "Flag --force takes no value"],
    ["a missing value", ["--title"], "Flag --title needs a value"],
    ["a value that looks like a flag", ["--title", "--force"], "Flag --title needs a value"],
    ["a flag given twice", ["--title", "a", "--title", "b"], "Flag --title was given twice"],
  ])("refuses %s", async (_label, args, message) => {
    const failure = await Effect.runPromise(Effect.flip(parseArgs(args, SPEC, "x")))
    expect(failure).toMatchObject({ _tag: "Usage", message })
  })

  test("repeats, declared short flags and a lone dash are read for flags that allow them", async () => {
    const parsed = await Effect.runPromise(
      readFlags(["-m", "a", "-m", "b", "-", "--"], { message: { kind: "many", short: "m" } }, "x"),
    )
    expect(parsed.values).toEqual({ message: ["a", "b"] })
    expect(parsed.positionals).toEqual(["-"])
  })
})

describe("the runtime package", () => {
  test("ships no program of its own: the plugin's holyagent command is the only one", async () => {
    const manifest = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as object

    expect(manifest).not.toHaveProperty("bin")
  })
})

describe("the push targets of a shell line", () => {
  test.each<readonly [string, ReadonlyArray<string>]>([
    ["git push origin claude/x", ["claude/x"]],
    ["sudo git push origin claude/x", ["claude/x"]],
    ["sudo -u user git push origin claude/x", ["claude/x"]],
    ["sudo -u git git push origin claude/x", ["claude/x"]],
    ["sudo --user=root git push origin claude/x", ["claude/x"]],
    ["env -u HOME git push origin claude/x", ["claude/x"]],
    ["timeout -s KILL 5 git push origin claude/x", ["claude/x"]],
    ["nice -n 5 git push origin claude/x", ["claude/x"]],
    ["xargs -I {} git push origin claude/x", ["claude/x"]],
    ["git push origin claude/x > out.log", ["claude/x"]],
    ["git push origin claude/x 2>push.log", ["claude/x"]],
    ["git push origin feat > claude/out.log", ["feat"]],
    ["git push origin feat >claude/out.log", ["feat"]],
    ["git push origin feat >> claude/out.log 2>&1", ["feat"]],
    ["git push origin feat 2> claude/err.log", ["feat"]],
    ["git push origin feat < claude/in.txt", ["feat"]],
    ["git push origin feat>claude/out.log", ["feat"]],
    ["git push origin feat 2>&1 | tee claude/x", ["feat"]],
    ["git push origin feat >& claude/out.log", ["feat"]],
    ["git push origin feat>>claude/out.log", ["feat"]],
    ["if true; then git push origin claude/x; fi", ["claude/x"]],
    ["for b in a; do git push origin claude/x; done", ["claude/x"]],
    ["while ! git push origin claude/x; do sleep 1; done", ["claude/x"]],
    ["if x; then :; else git push origin claude/x; fi", ["claude/x"]],
    ["{ git push origin claude/x; }", ["claude/x"]],
    ["then sudo -u user git push origin claude/x", ["claude/x"]],
    ["command -p git push origin claude/x", ["claude/x"]],
    ["sudo -u user echo git push origin claude/x", []],
  ])("%s", (line, targets) => {
    expect(pushTargets(line)).toEqual(targets)
  })
})
