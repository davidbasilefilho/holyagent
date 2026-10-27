import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { type AssignmentDraft, createAssignment } from "../src/domain/assignment.ts"
import { DEFAULT_CONFIG } from "../src/domain/directive.ts"
import { closeIntent, createIntent } from "../src/domain/intent.ts"
import { dispatch, record } from "../src/domain/lifecycle.ts"
import { stateDirectory } from "../src/state/layout.ts"
import { WorkTree } from "../src/state/local.ts"
import { loadOpenProject, readState, updateState } from "../src/state/store.ts"
import { NOW } from "./fixtures.ts"

let root: string
let directory: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "holyagent-"))
  directory = stateDirectory(root)
})
afterEach(() => rm(root, { recursive: true, force: true }))

const draft: AssignmentDraft = {
  intentId: "intent-aaa",
  intentRevision: 1,
  roleTask: "Worker.implementation",
  objective: "Build the parser",
  scope: ["parser"],
  constraints: [],
  criteria: [{ text: "parses", blocking: true, dimension: "behavior" }],
  evidence: ["tests"],
  ownershipPaths: ["src/parser.ts"],
  dependencies: [],
  independentFrom: [],
}

/** Runs against the temporary project as its work tree, which keeps the Intent in use. */
const inWorkTree = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provideService(WorkTree, root))

const seed = () =>
  updateState(directory, () =>
    Effect.gen(function* () {
      const created = yield* createIntent(
        { intents: [], assignments: [] },
        { id: "intent-aaa", objective: "Parse everything", now: NOW },
      )
      const planned = yield* createAssignment(
        { intents: created.intents, assignments: [] },
        draft,
        {
          id: "assignment-bbb",
          now: NOW,
        },
      )
      return {
        intents: created.intents,
        assignments: planned.assignments,
        activeIntent: "intent-aaa",
      }
    }),
  ).pipe(Effect.provideService(WorkTree, root))

const assignmentPathOf =
  "intents/parse-everything-intent-aaa/assignments/worker-implementation-build-the-parser-assignment-bbb.json"

/** Every file under the state folder with its content, so a test can see that nothing moved. */
const snapshot = async (): Promise<Record<string, string>> => {
  const names = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, dot: true }))
  return Object.fromEntries(
    await Promise.all(
      names
        .toSorted()
        .map(async (name) => [name, await Bun.file(join(directory, name)).text()] as const),
    ),
  )
}

const files = async (path: string): Promise<string[]> =>
  (await readdir(path, { recursive: true })).toSorted()

describe("state store", () => {
  test("an empty directory reads as an empty project", async () => {
    const state = await Effect.runPromise(readState(directory))
    expect(state.project).toEqual({ intents: [], assignments: [] })
    expect(state.specialists).toEqual([])
    expect(state.activeIntent).toBeUndefined()
  })

  test("records round-trip and live at readable, versioned paths", async () => {
    await Effect.runPromise(seed())
    const state = await Effect.runPromise(inWorkTree(readState(directory)))
    expect(state.project.intents).toHaveLength(1)
    expect(state.project.assignments[0]).toMatchObject({ id: "assignment-bbb", state: "Ready" })
    expect(state.activeIntent).toBe("intent-aaa")
    // Another work tree of the clone has made no choice of its own.
    const other = await Effect.runPromise(
      readState(directory).pipe(Effect.provideService(WorkTree, `${root}-other`)),
    )
    expect(other.activeIntent).toBeUndefined()
    expect(await files(directory)).toContain("intents/parse-everything-intent-aaa/intent.json")
    expect(await files(directory)).toContain(
      "intents/parse-everything-intent-aaa/assignments/worker-implementation-build-the-parser-assignment-bbb.json",
    )
  })

  test("files have stable key order and a trailing newline", async () => {
    await Effect.runPromise(seed())
    const text = await Bun.file(
      join(directory, "intents/parse-everything-intent-aaa/intent.json"),
    ).text()
    expect(text.endsWith("}\n")).toBe(true)
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual([
      "id",
      "slug",
      "objective",
      "requirements",
      "revision",
      "state",
      "createdAt",
    ])
  })

  test("the local folder ignores itself on first use and holds the unversioned files", async () => {
    await Effect.runPromise(seed())
    expect(await Bun.file(join(directory, "local/.gitignore")).text()).toBe("*\n")
    const local = await files(join(directory, "local"))
    expect(local).toHaveLength(3)
    expect(local.slice(0, 2)).toEqual([".gitignore", "active-intent"])
    expect(local[2]).toMatch(/^active-intent\/[0-9a-f]{16}\.json$/)
  })

  test("dispatch and record persist the Running Assignment and the specialist registry", async () => {
    await Effect.runPromise(seed())
    await Effect.runPromise(
      updateState(directory, ({ project, specialists }) =>
        dispatch(project, specialists, "assignment-bbb", NOW, DEFAULT_CONFIG),
      ),
    )
    await Effect.runPromise(
      updateState(directory, ({ project, specialists }) =>
        record(project, specialists, "assignment-bbb", {
          launched: true,
          agentId: "agent-7",
          model: "sonnet",
          effort: "high",
        }),
      ),
    )
    const state = await Effect.runPromise(readState(directory))
    expect(state.project.assignments[0]?.specialist?.agentId).toBe("agent-7")
    expect(state.specialists[0]).toMatchObject({ agentId: "agent-7", running: true })
    expect(await Bun.file(join(directory, "local/specialists.json")).exists()).toBe(true)
  })

  test("a path with a trailing slash or a dot segment reads the same records", async () => {
    await Effect.runPromise(seed())
    for (const spelling of [`${directory}/`, `${directory}/./`, `${root}/./.holyagent`]) {
      const state = await Effect.runPromise(readState(spelling))
      expect(state.project.assignments.map((row) => row.id)).toEqual(["assignment-bbb"])
    }
  })

  test("a change that cannot be encoded writes none of its records", async () => {
    await Effect.runPromise(seed())
    const before = await snapshot()
    const { project } = await Effect.runPromise(readState(directory))
    const intent = project.intents[0]
    const row = project.assignments[0]
    if (intent === undefined || row === undefined) throw new Error("seed is missing")
    const error = await Effect.runPromise(
      Effect.flip(
        updateState(directory, () =>
          Effect.succeed({
            intents: [{ ...intent, objective: "Changed first" }],
            assignments: [{ ...row, state: "Cancelled" as const, result: " " }],
          }),
        ),
      ),
    )
    expect(error._tag).toBeDefined()
    expect(await snapshot()).toEqual(before)
  })

  test("closing an Intent with a blank drop reason leaves Running work and the store as they were", async () => {
    await Effect.runPromise(seed())
    await Effect.runPromise(
      updateState(directory, ({ project, specialists }) =>
        dispatch(project, specialists, "assignment-bbb", NOW, DEFAULT_CONFIG),
      ),
    )
    const before = await snapshot()
    const error = await Effect.runPromise(
      Effect.flip(
        updateState(directory, ({ project, specialists }) =>
          closeIntent(project, specialists, "intent-aaa", { reason: "done", drop: " " }, NOW),
        ),
      ),
    )
    expect(error._tag).toBe("InvalidDraft")
    expect(await snapshot()).toEqual(before)
    const state = await Effect.runPromise(readState(directory))
    expect(state.project.intents[0]?.state).toBe("Open")
    expect(state.project.assignments[0]?.state).toBe("Running")
  })

  test("a failed transition writes nothing", async () => {
    await Effect.runPromise(seed())
    const before = await files(directory)
    const result = await Effect.runPromise(
      Effect.flip(
        updateState(directory, ({ project, specialists }) =>
          dispatch(project, specialists, "assignment-missing", NOW, DEFAULT_CONFIG),
        ),
      ),
    )
    expect(result._tag).toBe("UnknownRecord")
    expect(await files(directory)).toEqual(before)
  })

  test("concurrent dispatches serialize behind the lock, so overlapping writers cannot both start", async () => {
    await Effect.runPromise(
      updateState(directory, () =>
        Effect.gen(function* () {
          const created = yield* createIntent(
            { intents: [], assignments: [] },
            { id: "intent-aaa", objective: "Parse everything", now: NOW },
          )
          const base = { intents: created.intents, assignments: [] }
          const first = yield* createAssignment(base, draft, { id: "assignment-one", now: NOW })
          const second = yield* createAssignment(
            base,
            { ...draft, ownershipPaths: ["src"] },
            {
              id: "assignment-two",
              now: NOW,
            },
          )
          return {
            intents: created.intents,
            assignments: [...first.assignments, ...second.assignments],
          }
        }),
      ),
    )
    const start = (id: string) =>
      Effect.result(
        updateState(directory, ({ project, specialists }) =>
          dispatch(project, specialists, id, NOW, DEFAULT_CONFIG),
        ),
      )
    const outcomes = await Effect.runPromise(
      Effect.all([start("assignment-one"), start("assignment-two")], { concurrency: "unbounded" }),
    )
    const refusals = outcomes.flatMap((outcome) =>
      outcome._tag === "Failure" ? [outcome.failure._tag] : [],
    )
    expect(refusals).toEqual(["OwnershipConflict"])
    expect(await files(join(directory, "local"))).not.toContain("lock")
  })

  test("a lock left by a dead process is broken", async () => {
    const child = Bun.spawn(["true"])
    await child.exited
    await mkdir(join(directory, "local"), { recursive: true })
    await Bun.write(
      join(directory, "local/lock"),
      JSON.stringify({ pid: child.pid, token: "old", acquiredAt: 1 }),
    )
    await Effect.runPromise(seed())
    expect((await Effect.runPromise(readState(directory))).project.intents).toHaveLength(1)
  })

  test("a lock held by a live process is respected", async () => {
    await mkdir(join(directory, "local"), { recursive: true })
    await Bun.write(
      join(directory, "local/lock"),
      JSON.stringify({ pid: process.pid, token: "mine", acquiredAt: 1 }),
    )
    const error = await Effect.runPromise(Effect.flip(seed()))
    expect(error._tag).toBe("StateLocked")
  })
})

describe("loading validates and names the file", () => {
  test("a read that meets a record mid-write is repeated and succeeds", async () => {
    await Effect.runPromise(seed())
    const path = join(directory, assignmentPathOf)
    const whole = await Bun.file(path).text()
    await Bun.write(path, "{")
    const repair = Effect.sleep("10 millis").pipe(
      Effect.andThen(Effect.promise(() => Bun.write(path, whole))),
    )
    const [state] = await Effect.runPromise(
      Effect.all([readState(directory), repair], { concurrency: "unbounded" }),
    )
    expect(state.project.assignments).toHaveLength(1)
  })

  const corrupt = async (relative: string, edit: (text: string) => string) => {
    await Effect.runPromise(seed())
    const path = join(directory, relative)
    await Bun.write(path, edit(await Bun.file(path).text()))
    return { path, error: await Effect.runPromise(Effect.flip(readState(directory))) }
  }
  const assignmentPath =
    "intents/parse-everything-intent-aaa/assignments/worker-implementation-build-the-parser-assignment-bbb.json"

  test("an unknown key is reported with the file", async () => {
    const { path, error } = await corrupt(
      "intents/parse-everything-intent-aaa/intent.json",
      (text) => text.replace('"revision": 1', '"revision": 1,\n  "extra": true'),
    )
    expect(error).toMatchObject({ _tag: "CorruptRecord", path })
  })

  test("a state that disagrees with its fields is reported with the file", async () => {
    const { path, error } = await corrupt(assignmentPath, (text) =>
      text.replace('"state": "Ready"', '"state": "Running"'),
    )
    expect(error).toMatchObject({ _tag: "CorruptRecord", path })
  })

  test("a file that is not JSON is reported with the file", async () => {
    const { path, error } = await corrupt(assignmentPath, () => "<<<<<<< ours\n")
    expect(error).toMatchObject({ _tag: "CorruptRecord", path })
  })

  test("a record outside the path its fields name is reported, not silently duplicated", async () => {
    await Effect.runPromise(seed())
    const from = join(directory, assignmentPath)
    const to = join(directory, "intents/parse-everything-intent-aaa/assignments/renamed.json")
    await Bun.write(to, await Bun.file(from).text())
    await rm(from)
    const error = await Effect.runPromise(Effect.flip(readState(directory)))
    expect(error).toMatchObject({ _tag: "CorruptRecord", path: to })
  })
})

describe("loading the open Intents only", () => {
  test("loads open Intents with their Assignments and leaves closed ones and their files alone", async () => {
    await Effect.runPromise(seed())
    await Effect.runPromise(
      updateState(directory, ({ project }) =>
        createIntent(project, { id: "intent-ccc", objective: "Old work", now: NOW }).pipe(
          Effect.flatMap((created) =>
            closeIntent(
              { ...project, intents: [...project.intents, ...created.intents] },
              [],
              "intent-ccc",
              { reason: "done" },
              NOW,
            ),
          ),
        ),
      ),
    )
    const closedAssignments = join(directory, "intents/old-work-intent-ccc/assignments")
    await mkdir(closedAssignments, { recursive: true })
    await Bun.write(join(closedAssignments, "broken.json"), "{")

    const open = await Effect.runPromise(loadOpenProject(directory))
    expect(open.intents.map((intent) => intent.id)).toEqual(["intent-aaa"])
    expect(open.assignments.map((row) => row.id)).toEqual(["assignment-bbb"])
    expect((await Effect.runPromise(Effect.flip(readState(directory))))._tag).toBe("CorruptRecord")
  })

  test("checks what it reads as strictly as a full load", async () => {
    await Effect.runPromise(seed())
    const from = join(directory, assignmentPathOf)
    const to = join(directory, "intents/parse-everything-intent-aaa/assignments/renamed.json")
    await Bun.write(to, await Bun.file(from).text())
    await rm(from)
    const error = await Effect.runPromise(Effect.flip(loadOpenProject(directory)))
    expect(error).toMatchObject({ _tag: "CorruptRecord", path: to })
  })
})
