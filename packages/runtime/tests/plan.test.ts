import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG } from "../src/domain/directive.ts"
import { recommend } from "../src/domain/plan.ts"
import { assignment, NOW, project, running } from "./fixtures.ts"

describe("the recommendation across work trees", () => {
  const elsewhere = running({
    id: "assignment-b",
    specialist: {
      agentId: "agent-2",
      model: "sonnet",
      effort: "high",
      startedAt: NOW,
      workTree: "tree-one",
    },
  })
  const ready = assignment()
  const plan = (workTree?: string) =>
    recommend(project([ready, elsewhere]), [], NOW, DEFAULT_CONFIG, workTree)

  test("a writer is not blocked by a Running writer of another work tree on the same path", () => {
    expect(plan("tree-two")).toMatchObject({ assignmentIds: [ready.id] })
  })

  test("a Running writer of the same work tree, or of an unknown one, still blocks the path", () => {
    expect(plan("tree-one")).toBeUndefined()
    expect(plan(undefined)).toBeUndefined()
  })
})
