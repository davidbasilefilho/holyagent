import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"
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
  expect(Bun.spawnSync(["git", "-C", base, "rev-parse", "--show-toplevel"]).exitCode).not.toBe(0)
  root = join(base, "repo")
  home = join(base, "home")
  await Promise.all([mkdir(root), mkdir(home)])
})
afterEach(() => rm(base, { recursive: true, force: true, maxRetries: 5 }))

const resource = (target: string) => [{ kind: "local-path" as const, target }]
const validate = (target: string, roots = [root]) =>
  Effect.runPromiseExit(validateOperationalResources(resource(target), roots))

// The mutation run replaces only Git's worktree discovery output, leaving all CLI paths intact.
const discoveryEnvironment = async (): Promise<Record<string, string>> => {
  if (process.env.HOLYAGENT_TEST_CWD_ONLY !== "1") return {}
  if (process.platform === "win32") throw new Error("The discovery mutation fixture requires sh")
  const git = Bun.which("git")
  if (git === null) throw new Error("Git is required")
  const bin = join(home, "shim")
  await mkdir(bin)
  const shim = join(bin, "git")
  await Bun.write(
    shim,
    `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = list ] && [ "$3" = --porcelain ] && [ "$4" = -z ]; then
  printf 'worktree %s\\0\\0' "$PWD"
  exit 0
fi
exec "$HOLYAGENT_TEST_REAL_GIT" "$@"
`,
  )
  await chmod(shim, 0o755)
  return { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOLYAGENT_TEST_REAL_GIT: git }
}

const linkedRepository = async () => {
  await $`git init -q -b main`.cwd(root).quiet()
  await $`git -c user.name=Fixture -c user.email=fixture@example.com -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -q --allow-empty -m seed`
    .cwd(root)
    .quiet()
  await $`git config --local holyagent.stateMode local`.cwd(root).quiet()
  const linked = join(base, "linked")
  const addLinked = () =>
    $`git -c core.hooksPath=/dev/null worktree add -q --detach ${linked}`.cwd(root).quiet()
  const extra = await discoveryEnvironment()
  const cli = (argv: ReadonlyArray<string>, input?: unknown) =>
    Effect.runPromise(
      run(argv, {
        cwd: root,
        env: { HOME: home, ...extra },
        stdin:
          input === undefined
            ? Effect.fail(new StdinMissing({ reason: "none" }))
            : Effect.succeed(JSON.stringify(input)),
      }),
    )
  expect((await cli(["intent", "create"], { objective: "Linked worktree" })).code).toBe(0)
  return { addLinked, cli, linked }
}

const linkedDraft = (target: string) => ({
  roleTask: "Worker.implementation",
  objective: "External operation",
  criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
  operationalResources: resource(target),
})

describe("registered linked worktree", () => {
  test("rejects creation in another registered worktree without changing assignments", async () => {
    const { addLinked, cli, linked } = await linkedRepository()
    await addLinked()
    const before = await cli(["assignment", "list", "--all", "--full"])
    expect(before.code).toBe(0)
    const rejected = await cli(["assignment", "create"], linkedDraft(join(linked, "new", "file")))
    expect(rejected.stderr).toContain("overlaps a repository worktree")
    expect(rejected.code).not.toBe(0)
    const after = await cli(["assignment", "list", "--all", "--full"])
    expect(after.stdout).toBe(before.stdout)
    if (process.platform !== "win32") {
      const alias = join(home, "linked-alias")
      await symlink(linked, alias)
      const aliasRejected = await cli(["assignment", "create"], linkedDraft(join(alias, "file")))
      expect(aliasRejected.stderr).toContain("overlaps a repository worktree")
      expect((await cli(["assignment", "list", "--all", "--full"])).stdout).toBe(before.stdout)
    }
  }, 60_000)

  test("revalidates dispatch after another worktree is registered and leaves it Ready", async () => {
    const { addLinked, cli, linked } = await linkedRepository()
    const created = await cli(["assignment", "create"], linkedDraft(join(linked, "new", "file")))
    expect(created.code).toBe(0)
    const id = String((decode(created.stdout) as { id: string }).id)
    await addLinked()
    const before = await cli(["assignment", "show", id, "--full"])
    expect(before.stdout).toContain("Ready")
    const rejected = await cli(["assignment", "dispatch"], { id })
    expect(rejected.stderr).toContain("overlaps a repository worktree")
    expect(rejected.code).not.toBe(0)
    const after = await cli(["assignment", "show", id, "--full"])
    expect(after.stdout).toBe(before.stdout)
  }, 60_000)
})

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
    expect(show.code).toBe(0)
    expect((decode(show.stdout) as { operationalResources: unknown }).operationalResources).toEqual(
      resource(target),
    )
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
