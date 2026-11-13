import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { DEFAULT_CONFIG } from "../src/domain/directive.ts"
import { recommend } from "../src/domain/plan.ts"
import { validateOperationalResources } from "../src/state/operational.ts"
import { assignment, NOW, project } from "./fixtures.ts"

let base: string
let root: string
let home: string
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "holyagent-operational-")))
  root = join(base, "repo")
  home = join(base, "home")
  await Promise.all([mkdir(root), mkdir(home)])
})
afterEach(() => rm(base, { recursive: true, force: true, maxRetries: 5 }))

const resource = (target: string) => [{ kind: "local-path" as const, target }]
const validate = (target: string, roots = [root]) =>
  Effect.runPromiseExit(validateOperationalResources(resource(target), roots))

describe("operational path validation", () => {
  test("allows an external missing target and rejects worktrees, their parents, and traversal", async () => {
    expect((await validate(join(home, "agent", "future")))._tag).toBe("Success")
    expect((await validate(join(root, "src", "file")))._tag).toBe("Failure")
    expect((await validate(base))._tag).toBe("Failure")
    expect((await validate(`${home}/../repo/file`))._tag).toBe("Failure")
    expect((await validate(join(home, "alias"), [root, home]))._tag).toBe("Failure")
    expect((await validate(root.toUpperCase()))._tag).toBe("Failure")
  })

  test.skipIf(process.platform === "win32")(
    "resolves symlinks and rejects dangling aliases",
    async () => {
      await symlink(root, join(home, "repo-alias"))
      await symlink(join(base, "missing"), join(home, "dangling"))
      expect((await validate(join(home, "repo-alias", "new")))._tag).toBe("Failure")
      expect((await validate(join(home, "dangling", "new")))._tag).toBe("Failure")
      await symlink(home, join(root, "external-alias"))
      expect((await validate(join(root, "external-alias", "new")))._tag).toBe("Failure")
    },
  )
})

test("plan does not schedule an operational writer beside another writer", () => {
  const first = assignment({
    operationalResources: resource(join(tmpdir(), "agent")),
    ownershipPaths: [],
  })
  const second = assignment({ id: "assignment-b", ownershipPaths: ["src/other.ts"] })
  expect(recommend(project([first, second]), [], NOW, DEFAULT_CONFIG)?.assignmentIds).toEqual([
    first.id,
  ])
})

describe.each(["claude", "pi"])("%s host", (host) => {
  const cli = (argv: ReadonlyArray<string>, input: unknown) =>
    Effect.runPromise(
      run(argv, {
        cwd: root,
        env: { HOME: home, HOLYAGENT_HOST: host },
        stdin:
          input === undefined
            ? Effect.fail(new StdinMissing({ reason: "none" }))
            : Effect.succeed(JSON.stringify(input)),
      }),
    )

  test("dispatches external-only work and blocks a repository writer", async () => {
    expect((await cli(["intent", "create"], { objective: "Operate" })).code).toBe(0)
    const target = join(home, ".pi", "agent")
    const draft = {
      roleTask: "Worker.implementation",
      objective: "Install",
      criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
      ownershipPaths: [],
      operationalResources: resource(target),
    }
    const started = await cli(["assignment", "dispatch"], draft)
    expect(started.code).toBe(0)
    const id = String((decode(started.stdout.split("\nprompt:\n")[0] ?? "") as { id: string }).id)
    const show = await cli(["assignment", "show", id, "--full"], undefined)
    expect(show.stdout).toContain(target)
    const briefPath = /at (.+?\.md) with/.exec(started.stdout)?.[1]
    expect(briefPath).toBeDefined()
    expect(await Bun.file(briefPath ?? "").text()).toContain(target)
    const blocked = await cli(["assignment", "dispatch"], {
      ...draft,
      objective: "Code",
      ownershipPaths: ["src/a.ts"],
      operationalResources: [],
    })
    expect(blocked.stderr).toContain("OwnershipConflict")
  })

  test("an external writer waits for a repository writer", async () => {
    expect((await cli(["intent", "create"], { objective: "Operate" })).code).toBe(0)
    const draft = {
      roleTask: "Worker.implementation",
      objective: "Code",
      criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
      ownershipPaths: ["src/a.ts"],
    }
    expect((await cli(["assignment", "dispatch"], draft)).code).toBe(0)
    const blocked = await cli(["assignment", "dispatch"], {
      ...draft,
      objective: "External",
      ownershipPaths: [],
      operationalResources: resource(join(home, "agent")),
    })
    expect(blocked.stderr).toContain("OwnershipConflict")
  })

  test.skipIf(process.platform === "win32")(
    "rechecks a saved draft after an alias changes",
    async () => {
      expect((await cli(["intent", "create"], { objective: "Operate" })).code).toBe(0)
      const target = join(home, "later", "file")
      const draft = {
        roleTask: "Worker.implementation",
        objective: "External",
        criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
        operationalResources: resource(target),
      }
      const created = await cli(["assignment", "create"], draft)
      expect(created.code).toBe(0)
      const id = String((decode(created.stdout) as { id: string }).id)
      await symlink(root, join(home, "later"))
      const refused = await cli(["assignment", "dispatch"], { id })
      expect(refused.stderr).toContain("overlaps a repository worktree")
    },
  )
})
