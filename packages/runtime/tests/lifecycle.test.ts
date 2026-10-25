import { describe, expect, test } from "bun:test"

import type { AcceptanceInput } from "../src/domain/acceptance.ts"
import { accept } from "../src/domain/acceptance.ts"
import { DEFAULT_CONFIG, directiveFor } from "../src/domain/directive.ts"
import { closeAssignment, dispatch, record } from "../src/domain/lifecycle.ts"
import type { Registry } from "../src/domain/specialists.ts"
import {
  after,
  assignment,
  entry,
  intent,
  NOW,
  ok,
  project,
  refused,
  running,
  succeeded,
} from "./fixtures.ts"

const go = (
  rows: Parameters<typeof project>[0],
  id = "assignment-a",
  registry: Registry = [],
  intents?: Parameters<typeof project>[1],
) => dispatch(project(rows, intents), registry, id, NOW, DEFAULT_CONFIG)

describe("dispatch", () => {
  test("reserves a Ready Assignment as Running on its route's model and effort", () => {
    const result = ok(go([assignment()]))
    expect(result.assignment).toMatchObject({
      state: "Running",
      specialist: { model: "sonnet", effort: "high", startedAt: NOW },
    })
    expect(result.assignments).toEqual([result.assignment])
    expect(result.directive).toMatchObject({ action: "spawn", agent: "worker-implementation" })
  })

  test("refuses anything but Ready, a closed Intent and a stale revision", () => {
    expect(refused(go([running()]))._tag).toBe("InvalidTransition")
    const closed = [intent({ state: "Closed", closeReason: "done" })]
    expect(refused(go([assignment()], "assignment-a", [], closed))._tag).toBe("IntentClosed")
    expect(
      refused(go([assignment()], "assignment-a", [], [intent({ revision: 2 })])),
    ).toMatchObject({
      _tag: "StaleRevision",
      given: 1,
      live: 2,
    })
  })

  test("refuses a time that is not a real instant", () => {
    const at = (now: string) =>
      dispatch(project([assignment()]), [], "assignment-a", now, DEFAULT_CONFIG)
    expect(refused(at("tomorrow"))._tag).toBe("InvalidDraft")
    expect(refused(at("2026-02-30T00:00:00Z"))._tag).toBe("InvalidDraft")
  })

  test("refuses a writer without ownership paths", () => {
    expect(refused(go([assignment({ ownershipPaths: [] })]))._tag).toBe("MissingOwnership")
  })

  test.each([
    ["equal paths", "src/a.ts"],
    ["a directory prefix", "src"],
    ["a path below the other", "src/a.ts/inner"],
    ["a different case", "SRC/A.TS"],
  ])("a writer cannot start beside a Running writer with %s", (_, path) => {
    const other = running({ id: "assignment-b", ownershipPaths: [path] })
    expect(refused(go([assignment(), other]))).toMatchObject({
      _tag: "OwnershipConflict",
      runningId: "assignment-b",
    })
  })

  test("disjoint writers and read-only Assignments start beside a Running writer", () => {
    const other = running({ id: "assignment-b", ownershipPaths: ["src/b.ts"] })
    expect(ok(go([assignment(), other])).assignment.state).toBe("Running")
    const same = running({ id: "assignment-b" })
    const review = assignment({ roleTask: "Reviewer.code" })
    expect(ok(go([review, same])).assignment.state).toBe("Running")
  })

  test("dependencies must be Succeeded and accepted at the same revision", () => {
    const dependent = assignment({ dependencies: ["assignment-dep"] })
    const withDep = (dep: ReturnType<typeof assignment>) =>
      go([dependent, { ...dep, id: "assignment-dep" }])
    expect(refused(withDep(assignment()))).toMatchObject({ _tag: "DependencyNotAccepted" })
    expect(refused(withDep(running()))._tag).toBe("DependencyNotAccepted")
    expect(refused(withDep(succeeded()))._tag).toBe("DependencyNotAccepted")
    expect(refused(withDep(succeeded({}, 2)))._tag).toBe("DependencyNotAccepted")
    expect(ok(withDep(succeeded({}, 1))).assignment.state).toBe("Running")
  })

  test("takes the warm specialist the directive continues", () => {
    const warm = entry({ lastFinishedAt: after(-5) })
    const result = ok(go([assignment({ followUpOf: "assignment-old" })], "assignment-a", [warm]))
    expect(result.directive).toMatchObject({ action: "continue", agentId: "agent-1" })
    expect(result.assignment.specialist?.agentId).toBe("agent-1")
    expect(result.registry?.[0]).toMatchObject({
      running: true,
      assignments: ["assignment-old", "assignment-a"],
    })
  })

  test("a continued specialist that is closed without record still has the work in its history", () => {
    const warm = entry({ lastFinishedAt: after(-5) })
    const started = ok(go([assignment({ followUpOf: "assignment-old" })], "assignment-a", [warm]))
    const closed = ok(
      closeAssignment(
        project([started.assignment]),
        started.registry ?? [],
        "assignment-a",
        { outcome: "Succeeded", result: "done" },
        after(5),
      ),
    )
    const author = closed.registry?.[0]
    expect(author).toMatchObject({
      running: false,
      assignments: ["assignment-old", "assignment-a"],
    })
    const review = assignment({
      id: "assignment-review",
      roleTask: "Reviewer.code",
      dependencies: ["assignment-a"],
      ownershipPaths: [],
    })
    const reviewer = entry({ ...author, roleTask: "Reviewer.code" })
    expect(directiveFor(review, [reviewer], after(6), DEFAULT_CONFIG).action).toBe("spawn")
  })

  test("a second dispatch does not take a specialist the first one holds", () => {
    const warm = entry({ lastFinishedAt: after(-5) })
    const first = ok(go([assignment({ followUpOf: "assignment-old" })], "assignment-a", [warm]))
    const second = assignment({
      id: "assignment-b",
      ownershipPaths: ["src/b.ts"],
      followUpOf: "assignment-old",
    })
    const next = ok(
      dispatch(project([second]), first.registry ?? [], "assignment-b", NOW, DEFAULT_CONFIG),
    )
    expect(next.directive.action).toBe("spawn")
  })
})

describe("record", () => {
  const launch = { launched: true, agentId: "agent-9", model: "sonnet", effort: "high" } as const

  test("binds the specialist and registers it with its history and paths", () => {
    const result = ok(
      record(
        project([running({ specialist: { model: "sonnet", effort: "high", startedAt: NOW } })]),
        [],
        "assignment-a",
        launch,
      ),
    )
    expect(result.assignment.specialist).toMatchObject({ agentId: "agent-9", startedAt: NOW })
    expect(result.registry[0]).toMatchObject({
      agentId: "agent-9",
      roleTask: "Worker.implementation",
      assignments: ["assignment-a"],
      paths: ["src/a.ts"],
      domains: ["src"],
      running: true,
    })
  })

  test("refuses a known specialist reported with another configuration", () => {
    const registry = [entry({ agentId: "agent-9", effort: "medium" })]
    expect(refused(record(project([running()]), registry, "assignment-a", launch))._tag).toBe(
      "SpecialistMismatch",
    )
  })

  test("refuses an agent that is still running another Assignment", () => {
    const busy = [entry({ agentId: "agent-9", running: true, assignments: ["assignment-other"] })]
    expect(refused(record(project([running()]), busy, "assignment-a", launch))._tag).toBe(
      "SpecialistMismatch",
    )
  })

  test("a different agent than the one dispatch took replaces it and frees the first", () => {
    const taken = [entry({ running: true, assignments: ["assignment-old", "assignment-a"] })]
    const result = ok(record(project([running()]), taken, "assignment-a", launch))
    expect(result.registry.find((e) => e.agentId === "agent-1")).toMatchObject({
      running: false,
      assignments: ["assignment-old"],
    })
    expect(result.registry.find((e) => e.agentId === "agent-9")?.assignments).toEqual([
      "assignment-a",
    ])
  })

  test("a launch report with unknown keys is refused", () => {
    const report = { launched: false, extra: true } as never
    expect(refused(record(project([running()]), [], "assignment-a", report))._tag).toBe(
      "InvalidDraft",
    )
  })

  test("a failed launch rolls back to Ready and frees the specialist the dispatch took", () => {
    const registry = [entry({ running: true, assignments: ["assignment-old", "assignment-a"] })]
    const result = ok(record(project([running()]), registry, "assignment-a", { launched: false }))
    expect(result.assignment.state).toBe("Ready")
    expect(result.assignment.specialist).toBeUndefined()
    expect(result.registry[0]).toMatchObject({ running: false, assignments: ["assignment-old"] })
  })

  test("only a Running Assignment has a launch to record", () => {
    expect(refused(record(project([assignment()]), [], "assignment-a", launch))._tag).toBe(
      "InvalidTransition",
    )
  })
})

describe("close", () => {
  const support: AcceptanceInput = {
    rationale: "checked",
    criteria: [{ criterion: "works", support: "ran it" }],
    evidence: [{ label: "tests", support: "bun test passed" }],
  }
  const finish = (
    accepting?: AcceptanceInput,
    rows = [running()],
    intents?: Parameters<typeof project>[1],
  ) =>
    closeAssignment(
      project(rows, intents),
      [entry({ running: true, assignments: ["assignment-old", "assignment-a"] })],
      "assignment-a",
      {
        outcome: "Succeeded",
        result: "done",
        ...(accepting === undefined ? {} : { accept: accepting }),
      },
      after(5),
    )

  test("finishes with the result, stamps the specialist and starts its cache window", () => {
    const result = ok(finish())
    expect(result.assignment).toMatchObject({ state: "Succeeded", result: "done" })
    expect(result.assignment.specialist?.finishedAt).toBe(after(5))
    expect(result.assignment.acceptance).toBeUndefined()
    expect(result.registry?.[0]).toMatchObject({ running: false, lastFinishedAt: after(5) })
  })

  test("accepts in the same step when given", () => {
    expect(ok(finish(support)).assignment.acceptance).toMatchObject({
      revision: 1,
      rationale: "checked",
    })
  })

  test("a refused acceptance closes nothing", () => {
    expect(refused(finish({ ...support, evidence: [] }))._tag).toBe("InsufficientAcceptance")
  })

  test("Succeeded needs a recorded specialist; Failed does not", () => {
    const unrecorded = running({ specialist: { model: "sonnet", effort: "high", startedAt: NOW } })
    expect(refused(finish(undefined, [unrecorded]))._tag).toBe("SpecialistNotRecorded")
    const failed = closeAssignment(
      project([unrecorded]),
      [],
      "assignment-a",
      { outcome: "Failed", result: "crashed" },
      NOW,
    )
    expect(ok(failed).assignment.state).toBe("Failed")
  })

  test("Succeeded needs the registry entry to list the Assignment", () => {
    const close = closeAssignment(
      project([running()]),
      [entry({ running: true })],
      "assignment-a",
      { outcome: "Succeeded", result: "done" },
      NOW,
    )
    expect(refused(close)._tag).toBe("SpecialistNotRecorded")
  })

  test("closing with acceptance on a stale revision is refused and closes nothing", () => {
    const moved = [intent({ revision: 2 })]
    expect(refused(finish(support, [running()], moved))).toMatchObject({
      _tag: "StaleRevision",
      given: 1,
      live: 2,
    })
    const plain = ok(finish(undefined, [running()], moved))
    expect(plain.assignment).toMatchObject({ state: "Succeeded" })
    expect(plain.assignment.acceptance).toBeUndefined()
  })

  test("a closing with unknown keys or a blank result is refused", () => {
    const close = (closing: unknown) =>
      closeAssignment(project([running()]), [], "assignment-a", closing as never, NOW)
    expect(refused(close({ outcome: "Failed", result: " " }))._tag).toBe("InvalidDraft")
    expect(refused(close({ outcome: "Failed", result: "x", extra: 1 }))._tag).toBe("InvalidDraft")
  })

  test("a Ready Assignment can only be Cancelled, and a finished one cannot close again", () => {
    const close = (outcome: "Failed" | "Cancelled", row = assignment()) =>
      closeAssignment(project([row]), [], "assignment-a", { outcome, result: "why" }, NOW)
    expect(ok(close("Cancelled")).assignment.state).toBe("Cancelled")
    expect(refused(close("Failed"))._tag).toBe("InvalidTransition")
    expect(refused(close("Cancelled", succeeded()))._tag).toBe("InvalidTransition")
  })

  test("a failed Assignment cannot be accepted", () => {
    const close = closeAssignment(
      project([running()]),
      [],
      "assignment-a",
      { outcome: "Failed", result: "x", accept: support },
      NOW,
    )
    expect(refused(close)._tag).toBe("InvalidTransition")
  })
})

describe("accept", () => {
  const support: AcceptanceInput = {
    rationale: "checked",
    criteria: [{ criterion: "works", support: "ran it" }],
    evidence: [{ label: "tests", support: "bun test passed" }],
  }
  const run = (
    input: AcceptanceInput,
    row = succeeded(),
    intents?: Parameters<typeof project>[1],
  ) => accept(project([row], intents), "assignment-a", input)

  test("records the live revision and the support", () => {
    expect(ok(run(support)).assignment.acceptance).toEqual({
      revision: 1,
      rationale: "checked",
      criteria: support.criteria,
      evidence: support.evidence,
    })
  })

  test("must support every blocking criterion; non-blocking ones are optional", () => {
    expect(ok(run(support)).assignment.state).toBe("Succeeded")
    expect(refused(run({ ...support, criteria: [] }))._tag).toBe("InsufficientAcceptance")
    const both = {
      ...support,
      criteria: [...support.criteria, { criterion: "tidy", support: "lint clean" }],
    }
    expect(ok(run(both)).assignment.acceptance?.criteria).toHaveLength(2)
  })

  test("must support every evidence label, and blank support is invalid input", () => {
    expect(refused(run({ ...support, evidence: [] }))._tag).toBe("InsufficientAcceptance")
    expect(refused(run({ ...support, evidence: [{ label: "tests", support: "  " }] }))._tag).toBe(
      "InvalidDraft",
    )
    expect(refused(run({ ...support, criteria: [{ criterion: "works", support: "" }] }))._tag).toBe(
      "InvalidDraft",
    )
    expect(refused(run({ ...support, rationale: " " }))._tag).toBe("InvalidDraft")
  })

  test("refuses support for checks the Assignment does not declare", () => {
    const unknown = {
      ...support,
      evidence: [...support.evidence, { label: "extra", support: "x" }],
    }
    expect(refused(run(unknown))._tag).toBe("InsufficientAcceptance")
  })

  test("only a Succeeded Assignment is accepted, once per revision", () => {
    expect(refused(run(support, running()))._tag).toBe("InvalidTransition")
    expect(refused(run(support, succeeded({}, 1)))._tag).toBe("InvalidTransition")
  })

  test("work from an earlier revision needs an explicit carry-forward", () => {
    const moved = [intent({ revision: 2 })]
    expect(refused(run(support, succeeded(), moved))).toMatchObject({
      _tag: "StaleRevision",
      given: 1,
      live: 2,
    })
    const carried = ok(
      run(
        { ...support, carryForward: true, rationale: "unaffected by the change" },
        succeeded(),
        moved,
      ),
    )
    expect(carried.assignment.acceptance).toMatchObject({ revision: 2, carriedFrom: 1 })
    const again = ok(run({ ...support, carryForward: true }, succeeded({}, 1), moved))
    expect(again.assignment.acceptance).toMatchObject({ revision: 2, carriedFrom: 1 })
  })

  test("a repeated carry-forward keeps the revision the work was done at", () => {
    const acceptedAtTwo = succeeded({
      acceptance: {
        revision: 2,
        carriedFrom: 1,
        rationale: "checked",
        criteria: support.criteria,
        evidence: support.evidence,
      },
    })
    const again = ok(
      run({ ...support, carryForward: true }, acceptedAtTwo, [intent({ revision: 3 })]),
    )
    expect(again.assignment.acceptance).toMatchObject({ revision: 3, carriedFrom: 1 })
  })

  test("a closed Intent accepts nothing", () => {
    expect(
      refused(run(support, succeeded(), [intent({ state: "Closed", closeReason: "done" })]))._tag,
    ).toBe("IntentClosed")
  })
})
