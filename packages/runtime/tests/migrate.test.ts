import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode, encode } from "@toon-format/toon"
import { $ } from "bun"
import { Effect } from "effect"

import { describeFailure, StdinMissing } from "../src/cli/errors.ts"
import { MigrationUnverified } from "../src/cli/migrate.ts"
import { run } from "../src/cli/program.ts"
import { loadProject } from "../src/state/store.ts"

let project: string
let home: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "holyagent-migrate-"))
  home = await mkdtemp(join(tmpdir(), "holyagent-home-"))
})
afterEach(() =>
  Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]),
)

const cli = (argv: ReadonlyArray<string>) =>
  Effect.runPromise(
    run(argv, {
      cwd: project,
      env: { HOME: home },
      stdin: Effect.fail(new StdinMissing({ reason: "no stdin in this test" })),
    }),
  )

/** What the SessionStart hook prints for the project. */
const sessionStart = () =>
  Effect.runPromise(
    run(["hook", "session-start"], {
      cwd: project,
      env: { HOME: home },
      stdin: Effect.succeed('{"agent_type":"holyagent"}'),
    }),
  ).then((result) => result.stdout)

type Result = Awaited<ReturnType<typeof cli>>

/** The TOON a successful command printed, decoded. */
const data = (result: Result): Record<string, unknown> => {
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  return decode(result.stdout) as Record<string, unknown>
}

/**
 * Fails the test unless the command was refused (exit 3, with the migrate hint); returns its error
 * text.
 */
const refusal = (result: Result): string => {
  expect(result.stdout).toBe("")
  expect(result.code).toBe(3)
  expect(result.stderr).toContain("hint: ")
  expect(result.stderr).not.toContain("holyagent --help")
  return result.stderr
}

const put = (path: string, content: string) => Bun.write(join(project, path), content)
const putJson = (path: string, value: unknown) => put(path, `${JSON.stringify(value, null, 2)}\n`)
const putToon = (path: string, value: unknown) => put(path, `${encode(value)}\n`)
const readJson = (path: string) =>
  Bun.file(join(project, path)).json() as Promise<Record<string, unknown>>
const exists = (path: string) =>
  stat(join(project, path)).then(
    () => true,
    () => false,
  )

/** The files below a folder of the project, relative to it, sorted. */
const filesBelow = (folder: string) =>
  readdir(join(project, folder), { recursive: true, withFileTypes: true }).then((entries) =>
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(join(project, folder).length + 1))
      .toSorted(),
  )

// ---- holyclaude -------------------------------------------------------------------------------

const CLAUDE = ".holyclaude/intents"
const INTENT_A = "intent-0mvp7hcqf-t7pm"
const INTENT_B = "intent-0mvp8aaaa-bbbb"
const INTENT_C = "intent-0001"
const FOLDER_A = `${CLAUDE}/take-over-legacy-state-${INTENT_A}`
const FOLDER_B = `${CLAUDE}/second-${INTENT_B}`
const FOLDER_C = `${CLAUDE}/old-and-closed-${INTENT_C}`
const SUCCEEDED = "assignment-0mvp8lutt-vd4h"
const READY = "assignment-0mvp8mdgy-5yss"
const FAILED = "assignment-0mvp8mrlp-9ejx"
const CANCELLED = "assignment-0mvp8mroj-g5hh"
const BLANK = "assignment-0mvp8zzzz-0000"

const claudeAssignment = (
  id: string,
  intent: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  intent_id: intent,
  intent_revision: 2,
  role: "Worker.implementation",
  objective: `Objective of ${id}`,
  scope: ["packages/runtime"],
  constraints: ["Keep the CLI stable"],
  acceptance_criteria: ["it converts"],
  required_evidence: ["tests"],
  mutability: "ScopedWrite",
  metadata: {
    ownership_paths: ["packages/runtime/src"],
    symbols: [],
    domains: [],
    dependencies: [],
    related_assignments: [],
    independent_from: [],
  },
  state: "Ready",
  result: null,
  acceptance: null,
  ...over,
})

const claudeFile = (folder: string, id: string, objective: string) =>
  `${folder}/assignments/${objective}-${id}.json`

/** A `.holyclaude/` tree with one Assignment in each state, notes and missing fields. */
const holyclaudeTree = async () => {
  await put(".holyclaude/.gitignore", "/local/\n*.tmp\n/state.json*\n/state.observations.jsonl\n")
  await put(".holyclaude/local/lock", "{}")
  await putJson(`${FOLDER_A}/intent.json`, {
    id: INTENT_A,
    objective: "Take over legacy state",
    requirements: "Convert both formats.\n- keep the notes",
    revision: 2,
  })
  await put(`${FOLDER_A}/resume-notes.md`, "# Resume\nThe notes stay as they are.\n")
  await put(`${FOLDER_A}/notes/design.md`, "design notes\n")
  await put(`${FOLDER_A}/notes/scratch.tmp`, "temporary\n")
  await putJson(
    claudeFile(FOLDER_A, SUCCEEDED, "objective-of"),
    claudeAssignment(SUCCEEDED, INTENT_A, {
      state: "Succeeded",
      result: "Built and tested",
      acceptance_criteria: ["it converts", "it reloads"],
      scope: ["packages/runtime"],
      metadata: {
        ownership_paths: ["packages/runtime/src/state/legacy.ts", "/etc/absolute", "src/../up"],
        symbols: ["gatherLegacy"],
        domains: ["state"],
        dependencies: [READY, "assignment-ghost-0000"],
        related_assignments: [FAILED],
        independent_from: [],
      },
      clone_id: "clone-0mvp8000-aaaa",
      acceptance: {
        intent_revision: 2,
        rationale: "Checked by hand",
        criteria_evidence: { "it converts": "ran it", "it reloads": "status works" },
        required_evidence: { tests: "bun test passed" },
      },
    }),
  )
  await putJson(
    claudeFile(FOLDER_A, READY, "objective-of"),
    claudeAssignment(READY, INTENT_A, {
      role: "Reviewer.code",
      mutability: "ReadOnly",
      required_evidence: [],
      metadata: {
        // A read-only role that kept a path in holyclaude; holyagent gives it none.
        ownership_paths: ["packages/runtime/src"],
        symbols: [],
        domains: [],
        dependencies: [],
        related_assignments: [],
        independent_from: [SUCCEEDED],
      },
    }),
  )
  // No result and no acceptance_criteria: both are filled in.
  const failed = claudeAssignment(FAILED, INTENT_A, { state: "Failed" })
  delete failed["result"]
  delete failed["acceptance_criteria"]
  await putJson(claudeFile(FOLDER_A, FAILED, "objective-of"), failed)
  await putJson(
    claudeFile(FOLDER_A, CANCELLED, "objective-of"),
    claudeAssignment(CANCELLED, INTENT_A, { state: "Cancelled", result: "Dropped by the root" }),
  )
  await putJson(`${FOLDER_B}/intent.json`, {
    id: INTENT_B,
    objective: "Second Intent",
    requirements: "   ",
    revision: 1,
  })
  await putJson(
    claudeFile(FOLDER_B, BLANK, "objective-of"),
    claudeAssignment(BLANK, INTENT_B, { intent_revision: 1, state: "Failed" }),
  )
  await putJson(`${FOLDER_C}/intent.json`, {
    id: INTENT_C,
    objective: "Old and closed",
    requirements: "Done long ago",
    revision: 3,
    state: "closed",
    close_reason: "Shipped",
    closed_at: "2026-01-01T00:00:00.000Z",
  })
}

const NEW_A = `.holyagent/intents/take-over-legacy-state-${INTENT_A}`

/** The path of a migrated Assignment record, found by its id. */
const recordPath = async (folder: string, id: string) => {
  const name = (await filesBelow(`${folder}/assignments`)).find((file) =>
    file.endsWith(`-${id}.json`),
  )
  expect(name).toBeDefined()
  return `${folder}/assignments/${name}`
}

describe("migrating .holyclaude", () => {
  test("converts every record and the project reloads through the CLI", async () => {
    await holyclaudeTree()

    const result = data(await cli(["migrate"]))

    expect(result).toMatchObject({
      migrated: true,
      holyclaude: { intents: 3, assignments: 5, notes: 2 },
      reloaded: { intents: 3, assignments: 5 },
    })
    expect(String(result["next"])).toContain("delete")
    expect(String(result["next"])).toContain("state mode")

    const intents = data(await cli(["intent", "list"]))["intents"] as Array<{ id: string }>
    expect(intents.map((row) => row.id).toSorted()).toEqual(
      [INTENT_C, INTENT_A, INTENT_B].toSorted(),
    )
    const listed = data(await cli(["assignment", "list", "--all"]))["assignments"] as Array<{
      id: string
      state: string
    }>
    expect(Object.fromEntries(listed.map((row) => [row.id, row.state]))).toEqual({
      [SUCCEEDED]: "Succeeded",
      [READY]: "Ready",
      [FAILED]: "Failed",
      [CANCELLED]: "Cancelled",
      [BLANK]: "Failed",
    })
    // Two Intents are open and the Succeeded Assignment keeps its acceptance, so nothing waits.
    const status = data(await cli(["status"]))
    expect(status["intents"]).toHaveLength(2)
    expect(status).not.toHaveProperty("unaccepted")
    const loaded = await Effect.runPromise(loadProject(join(project, ".holyagent")))
    expect([loaded.intents.length, loaded.assignments.length]).toEqual([3, 5])
  })

  test("maps Intents, Assignments, acceptance and non-portable paths as documented", async () => {
    await holyclaudeTree()
    data(await cli(["migrate"]))

    expect(await readJson(`${NEW_A}/intent.json`)).toEqual({
      id: INTENT_A,
      slug: "take-over-legacy-state",
      objective: "Take over legacy state",
      requirements: ["Convert both formats.\n- keep the notes"],
      revision: 2,
      state: "Open",
      createdAt: new Date(Number.parseInt("0mvp7hcqf", 36)).toISOString(),
    })
    const blank = await readJson(`.holyagent/intents/second-intent-${INTENT_B}/intent.json`)
    expect(blank.requirements).toEqual([])
    const closed = await readJson(`.holyagent/intents/old-and-closed-${INTENT_C}/intent.json`)
    expect(closed).toMatchObject({
      state: "Closed",
      closeReason: "Shipped",
      createdAt: "1970-01-01T00:00:00.000Z",
    })

    const succeeded = await readJson(await recordPath(NEW_A, SUCCEEDED))
    expect(succeeded).toMatchObject({
      id: SUCCEEDED,
      intentId: INTENT_A,
      intentRevision: 2,
      roleTask: "Worker.implementation",
      slug: "objective-of-assignment-0mvp8lutt-vd4h",
      state: "Succeeded",
      constraints: ["Keep the CLI stable"],
      criteria: [
        { text: "it converts", blocking: true, dimension: "behavior" },
        { text: "it reloads", blocking: true, dimension: "behavior" },
      ],
      evidence: ["tests"],
      ownershipPaths: ["packages/runtime/src/state/legacy.ts"],
      dependencies: [READY],
      independentFrom: [],
      result: "Built and tested",
      acceptance: {
        revision: 2,
        rationale: "Checked by hand",
        criteria: [
          { criterion: "it converts", support: "ran it" },
          { criterion: "it reloads", support: "status works" },
        ],
        evidence: [{ label: "tests", support: "bun test passed" }],
      },
      createdAt: new Date(Number.parseInt("0mvp8lutt", 36)).toISOString(),
    })
    expect(succeeded.scope).toEqual([
      "packages/runtime",
      "Owned path (not portable): /etc/absolute",
      "Owned path (not portable): src/../up",
      `Related Assignment: ${FAILED}`,
      "Dependency not migrated: assignment-ghost-0000",
    ])
    expect(succeeded).not.toHaveProperty("clone_id")
    expect(succeeded).not.toHaveProperty("symbols")

    const ready = await readJson(await recordPath(NEW_A, READY))
    expect(ready).toMatchObject({
      state: "Ready",
      roleTask: "Reviewer.code",
      independentFrom: [SUCCEEDED],
      ownershipPaths: [],
    })
    expect(ready).not.toHaveProperty("result")
    expect(ready).not.toHaveProperty("acceptance")

    const failed = await readJson(await recordPath(NEW_A, FAILED))
    expect(failed.result).toBe("No result was recorded in holyclaude.")
    expect(failed.criteria).toEqual([
      { text: `Objective of ${FAILED}`, blocking: true, dimension: "behavior" },
    ])
    expect((await readJson(await recordPath(NEW_A, CANCELLED))).result).toBe("Dropped by the root")
  })

  test("copies the notes unchanged and leaves the legacy folder, its local state and *.tmp alone", async () => {
    await holyclaudeTree()
    data(await cli(["migrate"]))

    expect(await Bun.file(join(project, NEW_A, "resume-notes.md")).text()).toBe(
      "# Resume\nThe notes stay as they are.\n",
    )
    expect(await Bun.file(join(project, NEW_A, "notes/design.md")).text()).toBe("design notes\n")
    expect(await exists(`${NEW_A}/notes/scratch.tmp`)).toBe(false)
    expect(await exists(".holyagent/.gitignore")).toBe(false)
    expect(await Bun.file(join(project, ".holyagent/local/.gitignore")).text()).toBe("*\n")
    expect(await exists(".holyclaude/intents")).toBe(true)
  })
})

// ---- holycodex --------------------------------------------------------------------------------

const CODEX = ".holycodex"
const CODEX_INTENT = "intent-3f2a9c1b2d"
const CODEX_FOLDER = `${CODEX}/add-login-3f2a9c1b2d`
const CODEX_AT = "2026-03-04T05:06:07.000Z"

const gate = { required: true, status: "missing", evidence: [] }

const codexIntent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: "holycodex-intent-1",
  toon_compatibility: "toon-4",
  id: CODEX_INTENT,
  slug: "add-login",
  title: "Add login",
  goal: "Users can sign in",
  acceptance_criteria: ["A form exists", "Errors are shown"],
  state: "executing",
  revision: 3,
  plan_required: false,
  blockers: [],
  verification: gate,
  review: gate,
  acceptance_met: false,
  root_readiness: false,
  evidence: [],
  baseline: {
    root: "/repo",
    git_common_dir: "/repo/.git",
    initial_head: "a".repeat(40),
    expected_head: "a".repeat(40),
    expected_changes: [],
    expected_status_digest: "b".repeat(64),
    updated_at: CODEX_AT,
  },
  created_at: CODEX_AT,
  updated_at: CODEX_AT,
  ...over,
})

const invocation = (over: Record<string, unknown> = {}) => ({
  id: "invocation-1",
  outcome: "completed",
  started_at: CODEX_AT,
  finished_at: CODEX_AT,
  summary: "Added the form",
  evidence: [],
  remaining_risk: [],
  ...over,
})

const codexAssignment = (
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schema_version: "holycodex-assignment-1",
  toon_compatibility: "toon-4",
  intent_id: CODEX_INTENT,
  id,
  objective: `Work on ${id}`,
  owner: { role: "Worker", task: "implementation" },
  scope: ["src/login.ts", "docs/**"],
  constraints: ["No new dependency"],
  exclusions: ["Do not touch the router"],
  dependencies: [],
  acceptance_criteria: ["The form renders"],
  status: "pending",
  revision: 1,
  invocations: [],
  evidence: [],
  remaining_risk: [],
  created_at: CODEX_AT,
  updated_at: CODEX_AT,
  ...over,
})

const codexFile = (id: string) => `${CODEX_FOLDER}/assignments/${id}.toon`

/** A `.holycodex/` tree with an Assignment in each status, a plan and a current pointer. */
const holycodexTree = async () => {
  await put(`${CODEX}/current`, "add-login-3f2a9c1b2d\n")
  await putToon(`${CODEX_FOLDER}/intent.toon`, codexIntent())
  await putToon(`${CODEX_FOLDER}/plan.toon`, {
    schema_version: "holycodex-plan-1",
    approach: "Build it",
  })
  await putToon(`${CODEX_FOLDER}/plan.old-001.toon`, { approach: "Earlier plan" })
  await putToon(codexFile("assignment-aaaaaaaaaa"), codexAssignment("assignment-aaaaaaaaaa"))
  await putToon(
    codexFile("assignment-bbbbbbbbbb"),
    codexAssignment("assignment-bbbbbbbbbb", {
      status: "completed",
      invocations: [invocation()],
      dependencies: ["login-form", "free text dependency"],
    }),
  )
  await putToon(
    codexFile("assignment-cccccccccc"),
    codexAssignment("assignment-cccccccccc", {
      status: "failed",
      invocations: [invocation({ outcome: "failed", summary: "Tests fail" })],
    }),
  )
  await putToon(
    codexFile("assignment-dddddddddd"),
    codexAssignment("assignment-dddddddddd", {
      status: "blocked",
      blocker: "Needs the API key",
      owner: { role: "Explorer", task: "map" },
    }),
  )
  await putToon(
    codexFile("assignment-eeeeeeeeee"),
    codexAssignment("assignment-eeeeeeeeee", {
      status: "needs_root_input",
      acceptance_criteria: [],
    }),
  )
  await putToon(
    codexFile("assignment-ffffffffff"),
    codexAssignment("assignment-ffffffffff", { status: "superseded", superseded_by: "login-form" }),
  )
  await putToon(codexFile("login-form"), codexAssignment("login-form", { status: "pending" }))
}

const CODEX_NEW = `.holyagent/intents/add-login-${CODEX_INTENT}`

describe("migrating .holycodex", () => {
  test("converts every status and the project reloads through the CLI", async () => {
    await holycodexTree()

    const result = data(await cli(["migrate"]))

    expect(result).toMatchObject({
      migrated: true,
      holycodex: { intents: 1, assignments: 7, notes: 2 },
      reloaded: { intents: 1, assignments: 7 },
    })
    const listed = data(await cli(["assignment", "list", "--all"]))["assignments"] as Array<{
      id: string
      state: string
    }>
    expect(Object.fromEntries(listed.map((row) => [row.id, row.state]))).toEqual({
      "assignment-aaaaaaaaaa": "Ready",
      "assignment-bbbbbbbbbb": "Succeeded",
      "assignment-cccccccccc": "Failed",
      "assignment-dddddddddd": "Failed",
      "assignment-eeeeeeeeee": "Failed",
      "assignment-ffffffffff": "Cancelled",
      "assignment-login-form": "Ready",
    })
    expect(data(await cli(["intent", "list"]))["intents"]).toHaveLength(1)
    data(await cli(["status"]))
  })

  test("maps the Intent, the statuses, the results and the scope as documented", async () => {
    await holycodexTree()
    data(await cli(["migrate"]))

    expect(await readJson(`${CODEX_NEW}/intent.json`)).toEqual({
      id: CODEX_INTENT,
      slug: "add-login",
      objective: "Add login",
      requirements: ["Users can sign in", "A form exists", "Errors are shown"],
      revision: 3,
      state: "Open",
      createdAt: CODEX_AT,
    })
    const record = async (id: string) => readJson(await recordPath(CODEX_NEW, id))

    const pending = await record("assignment-aaaaaaaaaa")
    expect(pending).toMatchObject({
      state: "Ready",
      roleTask: "Worker.implementation",
      intentRevision: 3,
      scope: ["src/login.ts", "docs/**"],
      ownershipPaths: ["src/login.ts"],
      constraints: ["No new dependency", "Exclusion: Do not touch the router"],
      criteria: [{ text: "The form renders", blocking: true, dimension: "behavior" }],
      createdAt: CODEX_AT,
    })
    expect(pending).not.toHaveProperty("result")

    const completed = await record("assignment-bbbbbbbbbb")
    expect(completed).toMatchObject({
      state: "Succeeded",
      result: "Added the form",
      dependencies: ["assignment-login-form"],
    })
    expect(completed.scope).toContain("Dependency not migrated: free text dependency")
    expect(completed).not.toHaveProperty("acceptance")

    expect((await record("assignment-cccccccccc")).result).toBe("Tests fail")
    const blocked = await record("assignment-dddddddddd")
    expect(blocked).toMatchObject({
      state: "Failed",
      roleTask: "Explorer.map",
      ownershipPaths: [],
      result: "Blocker: Needs the API key\nholycodex status: blocked",
    })
    const needsInput = await record("assignment-eeeeeeeeee")
    expect(needsInput.result).toBe("holycodex status: needs_root_input")
    expect(needsInput.criteria).toEqual([
      { text: "Work on assignment-eeeeeeeeee", blocking: true, dimension: "behavior" },
    ])
    expect(await record("assignment-ffffffffff")).toMatchObject({
      state: "Cancelled",
      result: "holycodex status: superseded",
    })
  })

  test("copies the plan files unchanged as notes and leaves the pointer behind", async () => {
    await holycodexTree()
    data(await cli(["migrate"]))

    const files = await filesBelow(CODEX_NEW)
    for (const name of ["plan.toon", "plan.old-001.toon", "intent.json"])
      expect(files).toContain(name)
    expect(await Bun.file(join(project, CODEX_NEW, "plan.old-001.toon")).text()).toBe(
      await Bun.file(join(project, CODEX_FOLDER, "plan.old-001.toon")).text(),
    )
    expect(await exists(".holyagent/current")).toBe(false)
  })

  test("reads the earlier intent schema and closes a complete Intent", async () => {
    const addedLater = [
      "toon_compatibility",
      "plan_required",
      "blockers",
      "verification",
      "review",
      "acceptance_met",
      "root_readiness",
      "evidence",
    ]
    const earlier = Object.fromEntries(
      Object.entries(codexIntent()).filter(([key]) => !addedLater.includes(key)),
    )
    await putToon(`${CODEX_FOLDER}/intent.toon`, {
      ...earlier,
      schema_version: "holycodex-intent-0",
      state: "complete",
    })

    data(await cli(["migrate"]))

    expect(await readJson(`${CODEX_NEW}/intent.json`)).toMatchObject({
      state: "Closed",
      closeReason: "Closed in holycodex (state complete).",
    })
  })
})

// ---- dry run, refusals and stops --------------------------------------------------------------

describe("the dry run", () => {
  test("prints counts per source, lists what cannot convert and writes nothing", async () => {
    await holyclaudeTree()
    await holycodexTree()
    await putToon(
      codexFile("assignment-gggggggggg"),
      codexAssignment("assignment-gggggggggg", { owner: { role: "Reviewer", task: "plan" } }),
    )
    await put(`${FOLDER_A}/assignments/broken-assignment-0mvp8bad-0000.json`, "{ not json")
    await putJson(`${FOLDER_B}/assignments/extra-assignment-0mvp8ex-0000.json`, {
      ...claudeAssignment("assignment-0mvp8ex-0000", INTENT_B),
      surprise: true,
    })
    // Decodes as a holyclaude record, but breaks a holyagent rule (revisions start at 1).
    await putJson(
      `${FOLDER_B}/assignments/stale-assignment-0mvp8st-0000.json`,
      claudeAssignment("assignment-0mvp8st-0000", INTENT_B, { intent_revision: 0 }),
    )
    await put(".prettierignore", ".holyclaude/\n")

    const result = data(await cli(["migrate", "--dry-run"]))

    expect(result).toMatchObject({
      dryRun: true,
      holyclaude: { intents: 3, assignments: 5, notes: 2 },
      holycodex: { intents: 1, assignments: 7, notes: 2 },
    })
    const unconvertible = result["unconvertible"] as Array<{
      source: string
      path: string
      reason: string
    }>
    expect(unconvertible).toHaveLength(4)
    expect(unconvertible.find((row) => row.path.endsWith("0mvp8st-0000.json"))?.reason).toContain(
      "intentRevision",
    )
    expect(result["mentions"]).toEqual([".prettierignore"])
    const plan = unconvertible.find((row) => row.path.endsWith("assignment-gggggggggg.toon"))
    expect(plan?.source).toBe("holycodex")
    expect(plan?.reason).toContain("Reviewer.plan")
    expect(unconvertible.find((row) => row.path.endsWith("0mvp8bad-0000.json"))?.reason).toContain(
      "not valid JSON",
    )
    expect(unconvertible.find((row) => row.path.endsWith("0mvp8ex-0000.json"))?.reason).toContain(
      "surprise",
    )
    expect(String(result["verdict"])).toContain("refuse")
    expect(await exists(".holyagent")).toBe(false)
  })

  test("says a clean tree would be written, still writing nothing", async () => {
    await holyclaudeTree()

    const result = data(await cli(["migrate", "--dry-run"]))

    expect(result["verdict"]).toBe("a real run would write these records")
    expect(result).not.toHaveProperty("unconvertible")
    expect(await exists(".holyagent")).toBe(false)
  })

  test("reports a Running Assignment, which a real run refuses", async () => {
    await holyclaudeTree()
    await putJson(
      claudeFile(FOLDER_B, "assignment-0mvp8run-0000", "running"),
      claudeAssignment("assignment-0mvp8run-0000", INTENT_B, { state: "Running" }),
    )

    const result = data(await cli(["migrate", "--dry-run"]))

    const stops = result["stops"] as Array<{ source: string; message: string }>
    expect(stops).toHaveLength(1)
    expect(stops[0]?.source).toBe("holyclaude")
    expect(stops[0]?.message).toContain("Running")
    expect(await exists(".holyagent")).toBe(false)
  })
})

describe("refusals", () => {
  test("never overwrites: a second run fails and leaves every record as it was", async () => {
    await holyclaudeTree()
    data(await cli(["migrate"]))
    const before = await readJson(`${NEW_A}/intent.json`)
    await Bun.write(join(project, NEW_A, "resume-notes.md"), "edited after the migration\n")
    const files = await filesBelow(".holyagent")

    const error = refusal(await cli(["migrate"]))

    expect(error).toContain("MigrationRefused")
    expect(error).toContain("hint: Run `holyagent migrate --dry-run`")
    expect(error).toContain("already exists")
    expect(await readJson(`${NEW_A}/intent.json`)).toEqual(before)
    expect(await Bun.file(join(project, NEW_A, "resume-notes.md")).text()).toBe(
      "edited after the migration\n",
    )
    expect(await filesBelow(".holyagent")).toEqual(files)
  })

  test("refuses an id that .holyagent already holds under another name", async () => {
    await holyclaudeTree()
    await putJson(`.holyagent/intents/another-name-${INTENT_B}/intent.json`, {
      id: INTENT_B,
      slug: "another-name",
      objective: "Another name",
      requirements: [],
      revision: 1,
      state: "Open",
      createdAt: "2026-01-01T00:00:00.000Z",
    })

    const error = refusal(await cli(["migrate"]))

    expect(error).toContain(`intent ${INTENT_B}`)
    expect(await exists(`${NEW_A}/intent.json`)).toBe(false)
  })

  test("writes nothing when one record cannot be converted", async () => {
    await holyclaudeTree()
    await put(`${FOLDER_A}/assignments/broken-assignment-0mvp8bad-0000.json`, "{ not json")

    const error = refusal(await cli(["migrate"]))

    expect(error).toContain("0mvp8bad-0000.json")
    expect(error).toContain("cannot be converted")
    expect(await exists(".holyagent")).toBe(false)
  })

  test("stops on a Running holyclaude Assignment, naming it and how to settle it", async () => {
    await holyclaudeTree()
    await putJson(
      claudeFile(FOLDER_B, "assignment-0mvp8run-0000", "running"),
      claudeAssignment("assignment-0mvp8run-0000", INTENT_B, { state: "Running" }),
    )

    const error = refusal(await cli(["migrate"]))

    expect(error).toContain("assignment-0mvp8run-0000 is Running")
    expect(error).toContain("holyclaude assignment finish")
    expect(error).toContain("holyclaude assignment cancel")
    expect(await exists(".holyagent")).toBe(false)
  })

  test("stops on an executing holycodex Assignment, naming it and how to settle it", async () => {
    await holycodexTree()
    await putToon(
      codexFile("assignment-hhhhhhhhhh"),
      codexAssignment("assignment-hhhhhhhhhh", {
        status: "executing",
        active_invocation_id: "invocation-2",
        active_started_at: CODEX_AT,
      }),
    )

    const error = refusal(await cli(["migrate"]))

    expect(error).toContain("assignment-hhhhhhhhhh is executing")
    expect(error).toContain("holycodex-agent assignment result")
    expect(await exists(".holyagent")).toBe(false)
  })

  test("stops on a pending holycodex transaction, saying how to recover it", async () => {
    await holycodexTree()
    await putToon(`${CODEX_FOLDER}/.holycodex-transaction.toon`, {
      schema_version: "holycodex-work-state-transaction-1",
      state: "prepared",
      files: [{ path: "intent.toon", previous: "", next: "" }],
    })

    const error = refusal(await cli(["migrate"]))

    expect(error).toContain(".holycodex-transaction.toon")
    expect(error).toContain("holycodex-agent intent current")
    expect(await exists(".holyagent")).toBe(false)
  })

  test("fails when there is no legacy state", async () => {
    expect(refusal(await cli(["migrate"]))).toContain("NothingToMigrate")
    expect(await exists(".holyagent")).toBe(false)
  })

  test("a legacy folder with only local state is nothing to migrate, and the hook says nothing", async () => {
    await put(".holyclaude/local/lock", "{}")
    await put(".holyclaude/state.json", "{}")
    await put(".holycodex/.gitignore", "*.tmp\n")

    expect(refusal(await cli(["migrate"]))).toContain("NothingToMigrate")
    expect(await sessionStart()).toBe("")
    expect(await exists(".holyagent")).toBe(false)

    await holyclaudeTree()
    expect(await sessionStart()).toContain(".holyclaude/")
    expect(data(await cli(["migrate", "--dry-run"]))).toHaveProperty("holyclaude")
  })

  test("lists a record that .holyagent already holds once, not once per file", async () => {
    await holyclaudeTree()
    data(await cli(["migrate"]))

    const { conflicts } = data(await cli(["migrate", "--dry-run"]))

    expect(conflicts).toBeArray()
    const named = (id: string) => (conflicts as Array<string>).filter((text) => text.includes(id))
    expect(named(SUCCEEDED)).toHaveLength(1)
    expect(named(`intent ${INTENT_A}`)).toHaveLength(1)
  })

  test("hints at the way out of a failed reload", () => {
    const failure = describeFailure(new MigrationUnverified({ detail: "boom" }))
    expect(failure.hint).toContain("git status")
    expect(failure.hint).toContain("holyagent migrate --dry-run")
  })
})

describe("project files that name a legacy folder", () => {
  test("lists them without editing them, outside a repository", async () => {
    await holyclaudeTree()
    await put(".prettierignore", "node_modules\n.holyclaude/\n")
    await put("README.md", "nothing here\n")

    const result = data(await cli(["migrate"]))

    expect(result["mentions"]).toEqual([".prettierignore"])
    expect(await Bun.file(join(project, ".prettierignore")).text()).toBe(
      "node_modules\n.holyclaude/\n",
    )
  })

  test("asks git inside a repository, and leaves out the state folders", async () => {
    await $`git init -q`.cwd(project).quiet()
    await holyclaudeTree()
    await holycodexTree()
    await put("lint/ignore.txt", ".holycodex\n")
    await put("docs/old.md", "see .holyclaude\n")
    await put("src/clean.ts", "export {}\n")

    const result = data(await cli(["migrate"]))

    expect(result["mentions"]).toEqual(["docs/old.md", "lint/ignore.txt"])
    expect(String(result["next"])).toContain(".holyclaude and .holycodex")
  })
})
