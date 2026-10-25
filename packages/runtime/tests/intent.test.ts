import { describe, expect, test } from "bun:test"

import { Schema } from "effect"

import {
  closeIntent,
  createIntent,
  Intent,
  reopenIntent,
  updateIntent,
} from "../src/domain/intent.ts"
import {
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

describe("intent transitions", () => {
  test("create starts open at revision 1 with a slug from the objective", () => {
    const { intent: created } = ok(
      createIntent(project([], []), {
        id: "intent-x",
        objective: "Add the Café menu!",
        now: NOW,
      }),
    )
    expect(created).toMatchObject({ slug: "add-the-cafe-menu", revision: 1, state: "Open" })
  })

  test("create refuses an id already in use", () => {
    const again = createIntent(project(), { id: "intent-a", objective: "Other", now: NOW })
    expect(refused(again)).toMatchObject({ _tag: "DuplicateRecord", id: "intent-a" })
  })

  test("inputs that do not match their schema are refused with a tagged error", () => {
    const blankObjective = createIntent(project([], []), {
      id: "intent-x",
      objective: " ",
      now: NOW,
    })
    expect(refused(blankObjective)._tag).toBe("InvalidDraft")
    const extra = { material: true, surprise: 1 } as never
    expect(refused(updateIntent(project(), "intent-a", extra))._tag).toBe("InvalidDraft")
    const blankDrop = closeIntent(
      project([running()]),
      [],
      "intent-a",
      { reason: "r", drop: " " },
      NOW,
    )
    expect(refused(blankDrop)._tag).toBe("InvalidDraft")
  })

  test("only a material update bumps the revision", () => {
    const base = project()
    expect(
      ok(updateIntent(base, "intent-a", { objective: "Ship it now", material: false })).intent,
    ).toMatchObject({ objective: "Ship it now", revision: 1, slug: "ship-it" })
    expect(
      ok(updateIntent(base, "intent-a", { requirements: ["fast"], material: true })).intent,
    ).toMatchObject({ requirements: ["fast"], revision: 2 })
  })

  test("a closed Intent cannot be updated", () => {
    const closed = project([], [intent({ state: "Closed", closeReason: "done" })])
    expect(refused(updateIntent(closed, "intent-a", { material: true }))._tag).toBe("IntentClosed")
  })

  test("close is refused while an Assignment is Running", () => {
    const error = refused(
      closeIntent(project([running()]), [], "intent-a", { reason: "done" }, NOW),
    )
    expect(error).toMatchObject({ _tag: "IntentHasOpenWork", running: ["assignment-a"] })
  })

  test("close is refused while a Succeeded Assignment is unaccepted, and allowed once accepted", () => {
    const error = refused(
      closeIntent(project([succeeded()]), [], "intent-a", { reason: "done" }, NOW),
    )
    expect(error).toMatchObject({ _tag: "IntentHasOpenWork", unaccepted: ["assignment-a"] })
    const closed = ok(
      closeIntent(project([succeeded({}, 1)]), [], "intent-a", { reason: "done" }, NOW),
    )
    expect(closed.intent).toMatchObject({ state: "Closed", closeReason: "done" })
  })

  test("a drop reason closes anyway, cancels Ready and Running work and frees the specialist", () => {
    const rows = [
      running(),
      assignment({ id: "assignment-b" }),
      succeeded({ id: "assignment-c" }, 1),
    ]
    const result = ok(
      closeIntent(
        project(rows),
        [entry({ agentId: "agent-1", running: true })],
        "intent-a",
        {
          reason: "obsolete",
          drop: "user changed course",
        },
        NOW,
      ),
    )
    expect(result.assignments.map((row) => [row.id, row.state, row.result])).toEqual([
      ["assignment-a", "Cancelled", "user changed course"],
      ["assignment-b", "Cancelled", "user changed course"],
    ])
    expect(result.registry[0]).toMatchObject({ running: false, lastFinishedAt: NOW })
  })

  test("reopen bumps the revision and clears the reason; an open Intent cannot reopen", () => {
    const closed = project([], [intent({ state: "Closed", closeReason: "done", revision: 3 })])
    const reopened = ok(reopenIntent(closed, "intent-a")).intent
    expect(reopened).toMatchObject({ state: "Open", revision: 4 })
    expect(reopened.closeReason).toBeUndefined()
    expect(refused(reopenIntent(project(), "intent-a"))._tag).toBe("InvalidTransition")
  })

  test("a stored Intent must be closed exactly when it has a close reason", () => {
    const decode = Schema.decodeUnknownSync(Intent)
    expect(() => decode({ ...intent(), closeReason: "x" })).toThrow()
    expect(() => decode({ ...intent(), state: "Closed" })).toThrow()
    expect(() => decode({ ...intent(), revision: 0 })).toThrow()
  })
})
