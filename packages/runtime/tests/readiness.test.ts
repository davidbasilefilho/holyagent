import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { dispatchBlock } from "../src/domain/readiness.ts"
import { assignment, NOW, project, running } from "./fixtures.ts"

describe("operational scheduling ownership", () => {
  const operationalResources = [{ kind: "local-path", target: join(tmpdir(), "agent") }] as const

  test("allows an operational-only writer when no writer is running", () => {
    const row = assignment({ operationalResources, ownershipPaths: [] })
    expect(dispatchBlock(project([row]), row)).toBeUndefined()
  })

  test("a running operational writer blocks a repository writer in another worktree", () => {
    const row = assignment()
    const other = running({
      id: "assignment-other",
      operationalResources,
      specialist: {
        agentId: "other",
        model: "sonnet",
        effort: "high",
        startedAt: NOW,
        workTree: "first-tree",
      },
    })
    expect(dispatchBlock(project([row, other]), row, undefined, "different-tree")?._tag).toBe(
      "OwnershipConflict",
    )
  })

  test("an operational writer waits for a repository writer in another worktree", () => {
    const row = assignment({ operationalResources, ownershipPaths: [] })
    const other = running({
      id: "assignment-other",
      specialist: {
        agentId: "other",
        model: "sonnet",
        effort: "high",
        startedAt: NOW,
        workTree: "first-tree",
      },
    })
    expect(dispatchBlock(project([row, other]), row, undefined, "different-tree")?._tag).toBe(
      "OwnershipConflict",
    )
  })
})
