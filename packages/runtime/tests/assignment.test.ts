import { describe, expect, test } from "bun:test"

import { Schema } from "effect"

import {
  Assignment,
  AssignmentDraft,
  type AssignmentDraft as Draft,
  createAssignment,
} from "../src/domain/assignment.ts"
import { assignment, intent, NOW, ok, project, refused, running, succeeded } from "./fixtures.ts"

const draft = (over: Partial<Draft> = {}): Draft => ({
  intentId: "intent-a",
  intentRevision: 1,
  roleTask: "Worker.implementation",
  objective: "Build it",
  scope: [],
  constraints: [],
  criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
  evidence: ["tests"],
  ownershipPaths: ["src/a.ts"],
  dependencies: [],
  independentFrom: [],
  ...over,
})

const create = (
  over: Partial<Draft> = {},
  base = project([assignment({ id: "assignment-dep" })]),
) => createAssignment(base, draft(over), { id: "assignment-new", now: NOW })

describe("createAssignment", () => {
  test("plans a Ready Assignment at the Intent's revision", () => {
    expect(ok(create()).assignment).toMatchObject({
      id: "assignment-new",
      state: "Ready",
      intentRevision: 1,
      slug: "build-it",
    })
  })

  test("a writing route needs an ownership path; a read-only route does not", () => {
    expect(refused(create({ ownershipPaths: [] }))._tag).toBe("MissingOwnership")
    expect(ok(create({ roleTask: "Reviewer.code", ownershipPaths: [] })).assignment.state).toBe(
      "Ready",
    )
  })

  test.each(["/abs/path", "../up", "src/../../up"])("refuses the non-portable path %s", (path) => {
    expect(refused(create({ ownershipPaths: [path] }))._tag).toBe("InvalidPath")
  })

  test("refuses a stale revision and a closed Intent", () => {
    expect(refused(create({ intentRevision: 2 }))).toMatchObject({ _tag: "StaleRevision", live: 1 })
    const closed = project([], [intent({ state: "Closed", closeReason: "done" })])
    expect(refused(create({}, closed))._tag).toBe("IntentClosed")
  })

  test("refuses an id already in use", () => {
    const taken = project([assignment({ id: "assignment-new" })])
    expect(refused(create({}, taken))).toMatchObject({
      _tag: "DuplicateRecord",
      kind: "assignment",
      id: "assignment-new",
    })
  })

  test("refuses input that does not match its schema", () => {
    expect(refused(create({ objective: " " }))._tag).toBe("InvalidDraft")
    expect(refused(create({ extra: 1 } as never))._tag).toBe("InvalidDraft")
    expect(refused(createAssignment(project(), draft(), { id: "Bad Id", now: NOW }))._tag).toBe(
      "InvalidDraft",
    )
  })

  test("refuses references to Assignments outside the Intent and repeated criteria or labels", () => {
    expect(refused(create({ dependencies: ["assignment-missing"] }))._tag).toBe("UnknownRecord")
    expect(ok(create({ dependencies: ["assignment-dep"] })).assignment.dependencies).toEqual([
      "assignment-dep",
    ])
    const twice = { text: "works", blocking: true, dimension: "behavior" } as const
    expect(refused(create({ criteria: [twice, twice] }))._tag).toBe("InvalidDraft")
    expect(refused(create({ evidence: ["tests", "tests"] }))._tag).toBe("InvalidDraft")
  })
})

describe("stored Assignment", () => {
  const decode = Schema.decodeUnknownSync(Assignment, { onExcessProperty: "error" })

  test("states must agree with the run they record", () => {
    expect(decode(assignment())).toEqual(assignment())
    expect(decode(running())).toEqual(running())
    expect(decode(succeeded({}, 1))).toEqual(succeeded({}, 1))
    expect(() => decode({ ...running(), result: "early" })).toThrow()
    expect(() => decode({ ...assignment(), specialist: running().specialist })).toThrow()
    expect(() => decode({ ...succeeded(), result: undefined })).toThrow()
    expect(() => decode({ ...running(), acceptance: succeeded({}, 1).acceptance })).toThrow()
  })

  test("rejects unknown keys and a draft without criteria", () => {
    expect(() => decode({ ...assignment(), extra: 1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(AssignmentDraft)({ ...draft(), criteria: [] })).toThrow()
  })

  test("a draft's lists default to empty", () => {
    const {
      scope: _s,
      constraints: _c,
      evidence: _e,
      ownershipPaths: _o,
      dependencies: _d,
      independentFrom: _i,
      ...bare
    } = draft()
    expect(Schema.decodeUnknownSync(AssignmentDraft)(bare)).toMatchObject({
      scope: [],
      ownershipPaths: [],
    })
  })
})
