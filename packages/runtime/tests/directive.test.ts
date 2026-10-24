import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG, directiveFor, type ExecutionConfig } from "../src/domain/directive.ts"
import { recommend } from "../src/domain/plan.ts"
import { after, assignment, entry, NOW, project, running, succeeded } from "./fixtures.ts"

const warmFor = (over = {}) => entry({ lastFinishedAt: after(-5), ...over })
const next = (over = {}) =>
  assignment({ id: "assignment-new", followUpOf: "assignment-old", ...over })
const directive = (
  registry: ReturnType<typeof entry>[],
  over = {},
  config: ExecutionConfig = DEFAULT_CONFIG,
) => directiveFor(next(over), registry, NOW, config)

describe("execution directive", () => {
  test("spawns when nothing is registered, with the route's agent, model and effort", () => {
    expect(directive([])).toMatchObject({
      action: "spawn",
      agent: "worker-implementation",
      model: "sonnet",
      effort: "high",
    })
  })

  test("continues a warm specialist for a follow-up of its own Assignment", () => {
    expect(directive([warmFor()])).toMatchObject({ action: "continue", agentId: "agent-1" })
  })

  test("continues for overlapping paths or shared related Assignments, not for unrelated work", () => {
    const unrelated = { followUpOf: undefined } as const
    const overlap = { ownershipPaths: ["src"] }
    expect(directive([warmFor({ assignments: [] })], { ...overlap })).toMatchObject({
      action: "continue",
    })
    const shared = { dependencies: ["assignment-shared"], ownershipPaths: ["lib/x.ts"] }
    expect(
      directive([warmFor({ paths: [], related: ["assignment-shared"] })], shared),
    ).toMatchObject({ action: "continue" })
    expect(
      directive([warmFor({ paths: [], assignments: [] })], {
        ...unrelated,
        ownershipPaths: ["lib/x.ts"],
      }).action,
    ).toBe("spawn")
  })

  test("spawns for a busy specialist, another role task, or another model or effort", () => {
    expect(directive([warmFor({ running: true })]).action).toBe("spawn")
    expect(directive([warmFor({ roleTask: "Worker.integration" })]).action).toBe("spawn")
    expect(directive([warmFor({ effort: "medium" })]).action).toBe("spawn")
    expect(directive([warmFor({ model: "haiku" })]).action).toBe("spawn")
  })

  test("a specialist stays warm inside the TTL and goes cold after it", () => {
    const finishedAgo = (minutes: number) => warmFor({ lastFinishedAt: after(-minutes) })
    expect(directive([finishedAgo(54)]).action).toBe("continue")
    expect(directive([finishedAgo(55)]).action).toBe("continue")
    expect(directive([finishedAgo(56)]).action).toBe("spawn")
    const short = { ...DEFAULT_CONFIG, ttlMinutes: 10 }
    expect(directive([finishedAgo(9)], {}, short).action).toBe("continue")
    expect(directive([finishedAgo(11)], {}, short).action).toBe("spawn")
    expect(DEFAULT_CONFIG.ttlMinutes).toBe(55)
  })

  test("never continues a specialist a workflow launched, however warm and relevant", () => {
    const launched = warmFor({ agentId: "workflow:run-1/assignment-old" })
    expect(directive([launched]).action).toBe("spawn")
    expect(directive([launched, warmFor({ agentId: "agent-2" })])).toMatchObject({
      action: "continue",
      agentId: "agent-2",
    })
  })

  test("a specialist that never finished is not warm", () => {
    const { lastFinishedAt: _gone, ...unfinished } = warmFor()
    expect(directive([unfinished]).action).toBe("spawn")
  })

  test("prefers a follow-up, then the most recently finished, then the smallest id", () => {
    const followUp = warmFor({ agentId: "agent-2", paths: [], lastFinishedAt: after(-30) })
    const overlap = warmFor({ agentId: "agent-3", assignments: [], lastFinishedAt: after(-1) })
    expect(directive([overlap, followUp])).toMatchObject({ agentId: "agent-2" })
    const older = warmFor({ agentId: "agent-4", assignments: [], lastFinishedAt: after(-20) })
    expect(directive([older, overlap])).toMatchObject({ agentId: "agent-3" })
    const tie = warmFor({ agentId: "agent-0", assignments: [], lastFinishedAt: after(-1) })
    expect(directive([overlap, tie])).toMatchObject({ agentId: "agent-0" })
  })
})

describe("reviewer independence", () => {
  const review = {
    roleTask: "Reviewer.code",
    dependencies: ["assignment-impl"],
    ownershipPaths: ["src/a.ts"],
  } as const
  const reviewer = (over = {}) =>
    warmFor({ roleTask: "Reviewer.code", assignments: ["assignment-old"], ...over })

  test("a reviewer with no history on the change continues", () => {
    expect(directive([reviewer()], review).action).toBe("continue")
  })

  test("a specialist that wrote the reviewed change is never its reviewer", () => {
    expect(directive([reviewer({ assignments: ["assignment-impl"] })], review).action).toBe("spawn")
  })

  test("a previous reviewer of the same change is never its reviewer again", () => {
    expect(directive([reviewer({ related: ["assignment-impl"] })], review).action).toBe("spawn")
  })

  test("independentFrom binds a non-reviewer too", () => {
    const fresh = { followUpOf: undefined, independentFrom: ["assignment-other"] }
    expect(directive([warmFor({ assignments: ["assignment-other"] })], fresh).action).toBe("spawn")
    expect(
      directive([warmFor({ assignments: ["assignment-other"] })], { ...fresh, independentFrom: [] })
        .action,
    ).toBe("continue")
  })

  test("a non-reviewer without independentFrom may continue after working on its dependency", () => {
    expect(
      directive([warmFor({ assignments: ["assignment-impl"] })], {
        followUpOf: undefined,
        dependencies: ["assignment-impl"],
      }).action,
    ).toBe("continue")
  })
})

describe("workflow recommendation", () => {
  const on: ExecutionConfig = { ttlMinutes: 55, workflowsAvailable: true }
  const writer = (id: string, over = {}) =>
    assignment({ id, ownershipPaths: [`src/${id}.ts`], ...over })
  const review = (id: string, over = {}) =>
    assignment({ id, roleTask: "Reviewer.code", ownershipPaths: [], ...over })
  const validation = (id: string, over = {}) =>
    assignment({ id, roleTask: "Worker.validation", ownershipPaths: [], ...over })
  const plan = (
    rows: Parameters<typeof project>[0],
    registry: ReturnType<typeof entry>[] = [],
    config: ExecutionConfig = on,
  ) => recommend(project(rows), registry, NOW, config)

  test("nothing ready recommends nothing", () => {
    expect(plan([])).toBeUndefined()
    expect(plan([running()])).toBeUndefined()
  })

  test("a ready writer with the review of its work is implement-review", () => {
    const pair = [writer("w"), review("r", { independentFrom: ["w"] })]
    expect(plan(pair)).toMatchObject({
      action: "workflow",
      name: "implement-review",
      assignmentIds: ["w", "r"],
    })
  })

  test("a workflow comes with the direct-subagent fallback for the same work", () => {
    expect(plan([review("r1"), review("r2")])).toMatchObject({
      fallback: { assignmentIds: ["r1", "r2"], afterwards: [] },
    })
    // The reviews of implement-review wait for their writers, so the fallback launches them after.
    const rows = [
      writer("w1"),
      writer("w2"),
      review("r1", { independentFrom: ["w1"] }),
      review("r2", { independentFrom: ["w2"] }),
    ]
    expect(plan(rows)).toMatchObject({
      assignmentIds: ["w1", "r1", "w2", "r2"],
      fallback: { assignmentIds: ["w1", "w2"], afterwards: ["r1", "r2"] },
    })
  })

  test("several writers with their reviews are pairs in turn, unless their paths collide", () => {
    const rows = [
      writer("w1"),
      writer("w2"),
      review("r2", { independentFrom: ["w2"] }),
      review("r1", { independentFrom: ["w1"] }),
    ]
    expect(plan(rows)).toMatchObject({
      name: "implement-review",
      assignmentIds: ["w1", "r1", "w2", "r2"],
    })
    const colliding = [
      writer("w1"),
      writer("w2", { ownershipPaths: ["src/w1.ts"] }),
      ...rows.slice(2),
    ]
    expect(plan(colliding)).toMatchObject({ assignmentIds: ["w1", "r1"] })
  })

  test("a review that depends on the writer waits for its acceptance and is not paired", () => {
    const rows = [writer("w"), review("r", { dependencies: ["w"], independentFrom: ["w"] })]
    expect(plan(rows)).toMatchObject({ action: "subagent", assignmentIds: ["w"] })
  })

  test("a review waits for any unfinished work it names, and is not paired with just one of them", () => {
    const rows = [writer("w"), writer("other"), review("r", { independentFrom: ["w", "other"] })]
    expect(plan(rows)).toMatchObject({ name: "run-assignments", assignmentIds: ["w", "other"] })
    expect(plan(rows, [], DEFAULT_CONFIG)).toMatchObject({ action: "subagent" })
    const finished = succeeded({ id: "other" }, 1)
    expect(
      plan([writer("w"), finished, review("r", { independentFrom: ["w", "other"] })]),
    ).toMatchObject({ name: "implement-review", assignmentIds: ["w", "r"] })
  })

  test("a review of work still running starts after it finishes, not before", () => {
    const rows = [running({ id: "w", ownershipPaths: ["src/w.ts"] })]
    const check = review("r", { independentFrom: ["w"] })
    expect(plan([...rows, check])).toBeUndefined()
    expect(plan([succeeded({ id: "w" }), check])).toMatchObject({
      action: "subagent",
      assignmentIds: ["r"],
    })
  })

  test("independent reviews are review-diff; dependent ones are not", () => {
    expect(plan([review("r1"), review("r2")])).toMatchObject({
      name: "review-diff",
      assignmentIds: ["r1", "r2"],
    })
    expect(plan([review("r1"), review("r2", { dependencies: ["r1"] })])?.action).toBe("subagent")
  })

  test("other independent Assignments are run-assignments", () => {
    expect(plan([validation("v1"), validation("v2")])).toMatchObject({
      action: "workflow",
      name: "run-assignments",
      assignmentIds: ["v1", "v2"],
    })
    expect(plan([writer("w"), validation("v")])).toMatchObject({ name: "run-assignments" })
    expect(plan([validation("v1"), validation("v2", { dependencies: ["v1"] })])?.action).toBe(
      "subagent",
    )
  })

  test("work that would continue a warm specialist stays out of a workflow", () => {
    const follow = writer("w2", { followUpOf: "assignment-old" })
    expect(plan([writer("w1"), follow], [warmFor()])).toMatchObject({
      action: "subagent",
      assignmentIds: ["w1", "w2"],
      reason: "no workflow fits the ready set",
    })
    expect(plan([writer("w1"), follow, writer("w3")], [warmFor()])).toMatchObject({
      name: "run-assignments",
      assignmentIds: ["w1", "w3"],
    })
  })

  test("writers whose paths overlap are not run together", () => {
    const rows = [
      writer("a", { ownershipPaths: ["src"] }),
      writer("b", { ownershipPaths: ["src/b.ts"] }),
    ]
    expect(plan(rows)).toMatchObject({ action: "subagent", assignmentIds: ["a"] })
  })

  test("Assignments that cannot start now are left out", () => {
    const blockedByDependency = review("r1", { dependencies: ["assignment-dep"] })
    const dep = succeeded({ id: "assignment-dep" })
    expect(plan([blockedByDependency, review("r2"), dep])).toMatchObject({
      action: "subagent",
      assignmentIds: ["r2"],
    })
    const accepted = succeeded({ id: "assignment-dep" }, 1)
    expect(plan([blockedByDependency, review("r2"), accepted])).toMatchObject({
      name: "review-diff",
    })
    const holder = running({ id: "assignment-holder", ownershipPaths: ["src/w.ts"] })
    expect(plan([writer("w"), holder])).toBeUndefined()
  })

  test("without workflows the same sets are plain subagent work", () => {
    expect(plan([review("r1"), review("r2")], [], DEFAULT_CONFIG)).toMatchObject({
      action: "subagent",
      assignmentIds: ["r1", "r2"],
      reason: "workflows are not available",
    })
  })

  test("a single startable Assignment with a warm specialist is continue, otherwise subagent", () => {
    const row = writer("w", { followUpOf: "assignment-old" })
    expect(plan([row], [warmFor()])).toMatchObject({ action: "continue", agentId: "agent-1" })
    expect(plan([row])).toMatchObject({ action: "subagent", assignmentIds: ["w"] })
    const blocker = running({ id: "assignment-holder", ownershipPaths: ["src/w.ts"] })
    expect(plan([row, blocker], [warmFor()])).toBeUndefined()
  })
})
