import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect } from "effect"

import { loadProject } from "../src/state/store.ts"
import { cleanup, fakeGitHub, initRepo, put, scratch, seed, sh, toon, vcs } from "./vcs-fixtures.ts"

afterEach(cleanup)

const OWNER = { name: "Octo", email: "42+octo@users.noreply.github.com" }
const STATE = "holyagent/state"

/** Runs a holyagent command line in a directory; the GitHub is a fake that answers pull requests. */
const holy = (dir: string, argv: ReadonlyArray<string>, stdin?: unknown) =>
  vcs(
    dir,
    argv,
    fakeGitHub({
      rest: (request) =>
        request.method === "POST" || request.method === "PATCH"
          ? { number: 7, html_url: "https://github.com/octo/project/pull/7" }
          : undefined,
    }).layer,
    stdin,
  )

const createIntent = async (dir: string, objective: string) =>
  String(toon(await holy(dir, ["intent", "create"], { objective })).id)

const planAssignment = async (dir: string, objective: string, path: string) =>
  String(
    toon(
      await holy(dir, ["assignment", "create"], {
        roleTask: "Worker.implementation",
        objective,
        criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
        evidence: ["tests"],
        ownershipPaths: [path],
      }),
    ).id,
  )

/** Where a branch (the state branch by default) is checked out, from any worktree of the clone. */
const stateTree = async (dir: string, branch = STATE) => {
  const blocks = (await sh(dir, ["git", "worktree", "list", "--porcelain"])).split("\n\n")
  const block = blocks.find((text) => text.includes(`\nbranch refs/heads/${branch}`))
  const path = block?.split("\n")[0]?.replace("worktree ", "")
  if (path === undefined) throw new Error(`no worktree has ${branch} checked out`)
  return path
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "")

/** The files each commit of `range` touched, newest first. */
const touched = async (dir: string, range: string) =>
  lines(await sh(dir, ["git", "log", "--name-only", "--format=%x00", range]))
    .join("\n")
    .split("\0")
    .map((block) => lines(block))
    .filter((files) => files.length > 0)

/** A repository with a seed commit, a state with one Intent and one Assignment, and a stack of work. */
const diverged = async () => {
  const dir = await initRepo(OWNER)
  await seed(dir, { "a.txt": "a\n", "b.txt": "b\n" })
  const intent = await createIntent(dir, "Ship the parser")
  await planAssignment(dir, "Build the parser", "src/parser.ts")
  await sh(dir, ["git", "switch", "-q", "-c", "feature"])
  await put(dir, { "a.txt": "a2\n" })
  toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))
  await sh(dir, ["git", "switch", "-q", "-c", "stack"])
  await put(dir, { "b.txt": "b2\n" })
  toon(await holy(dir, ["vcs", "commit", "-m", "Change b", "--", "b.txt"]))
  return { dir, intent }
}

describe("the state branch", () => {
  test("every command finds the same state from the main checkout and from a linked worktree on another branch", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const intent = await createIntent(dir, "Ship the parser")

    const tree = join(await scratch("holyagent-worktree-"), "tree")
    await sh(dir, ["git", "worktree", "add", "-q", "-b", "feature", tree])
    const listed = toon(await holy(tree, ["intent", "list"])) as {
      intents: Array<{ id: string; inUse: boolean }>
    }
    expect(listed.intents).toMatchObject([{ id: intent, inUse: true }])

    const assignment = await planAssignment(tree, "Build it", "src/a.ts")
    expect(toon(await holy(dir, ["assignment", "show", assignment]))).toMatchObject({
      assignments: [expect.objectContaining({ id: assignment })],
    })
    // Neither work tree holds state; the state branch is checked out under the git directory.
    for (const where of [dir, tree]) {
      expect(await sh(where, ["git", "status", "--porcelain"])).toBe("")
      expect(await Bun.file(join(where, ".holyagent")).exists()).toBe(false)
    }
    expect(await sh(dir, ["git", "worktree", "list", "--porcelain"])).toContain(
      `branch refs/heads/${STATE}`,
    )
    const project = await Effect.runPromise(loadProject(join(await stateTree(dir), ".holyagent")))
    expect(project.intents).toHaveLength(1)
    expect(project.assignments).toHaveLength(1)
  })

  test("each worktree of a clone keeps its own Intent in use, and one with no choice resolves the only open Intent", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const first = await createIntent(dir, "Ship the parser")
    const tree = join(await scratch("holyagent-worktree-"), "tree")
    await sh(dir, ["git", "worktree", "add", "-q", "-b", "feature", tree])
    const idle = join(await scratch("holyagent-worktree-"), "idle")
    await sh(dir, ["git", "worktree", "add", "-q", "-b", "idle", idle])
    const inUse = async (where: string) => String(toon(await holy(where, ["intent", "show"])).id)

    // With one Intent open, a worktree that chose nothing resolves it.
    expect(await inUse(tree)).toBe(first)

    const second = await createIntent(tree, "Ship the printer")
    expect(await inUse(tree)).toBe(second)
    // Creating it in the linked worktree did not switch the main checkout.
    expect(await inUse(dir)).toBe(first)

    await holy(dir, ["intent", "use", second])
    await holy(dir, ["intent", "use", first])
    expect(await inUse(dir)).toBe(first)
    expect(await inUse(tree)).toBe(second)

    // Two are open and the third worktree chose none, so it is told to pick.
    const refused = await holy(idle, ["intent", "show"])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("NoActiveIntent")
    const listed = toon(await holy(idle, ["intent", "list"])) as {
      intents: Array<{ id: string; inUse: boolean }>
    }
    expect(listed.intents.every((row) => !row.inUse)).toBe(true)
  })

  test("a worktree with no choice of its own uses the one shared choice an older version kept", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const first = await createIntent(dir, "Ship the parser")
    await createIntent(dir, "Ship the printer")
    const idle = join(await scratch("holyagent-worktree-"), "idle")
    await sh(dir, ["git", "worktree", "add", "-q", "-b", "idle", idle])
    const legacy = join(await stateTree(dir), ".holyagent", "local", "active-intent.json")
    await writeFile(legacy, JSON.stringify({ intentId: first }))

    const shown = toon(await holy(idle, ["intent", "show"]))

    expect(String(shown.id)).toBe(first)
  })

  test("a new state branch starts at the base branch head, and the state branch name is configurable in git config", async () => {
    const dir = await initRepo(OWNER)
    const head = await seed(dir, { "a.txt": "a\n" })
    await sh(dir, ["git", "switch", "-q", "-c", "work"])
    await createIntent(dir, "Ship the parser")
    expect((await sh(dir, ["git", "rev-parse", `${STATE}~1`])).trim()).toBe(head)

    const other = await initRepo(OWNER)
    await seed(other, { "a.txt": "a\n" })
    await sh(other, ["git", "config", "holyagent.stateBranch", "ops/state"])
    await createIntent(other, "Ship the parser")
    expect(lines(await sh(other, ["git", "branch", "--list", "ops/state"]))).toHaveLength(1)
    expect(await sh(other, ["git", "branch", "--list", STATE])).toBe("")
  })

  test("each transition is a commit that touches only .holyagent, and local changes make none", async () => {
    const dir = await initRepo(OWNER)
    const base = await seed(dir, { "a.txt": "a\n" })
    const intent = await createIntent(dir, "Ship the parser")
    const assignment = await planAssignment(dir, "Build it", "src/a.ts")
    const before = (await sh(dir, ["git", "rev-parse", STATE])).trim()

    // The Intent in use is a per-clone fact: no versioned record changes, so no commit.
    toon(await holy(dir, ["intent", "use", intent]))
    expect((await sh(dir, ["git", "rev-parse", STATE])).trim()).toBe(before)

    toon(await holy(dir, ["intent", "update", "--material"], { objective: "Ship the new parser" }))
    expect(await holy(dir, ["assignment", "record", assignment, "--failed"])).toMatchObject({
      code: 3,
    })

    const commits = await touched(dir, `${base}..${STATE}`)
    expect(commits).toHaveLength(3)
    for (const files of commits) for (const file of files) expect(file).toStartWith(".holyagent/")
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
    expect(await sh(await stateTree(dir), ["git", "status", "--porcelain"])).toBe("")
  })

  test("two commands that start at once make the state worktree once", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })

    const results = await Promise.all(
      ["First", "Second"].map((objective) => holy(dir, ["intent", "create"], { objective })),
    )

    expect(results.map((result) => result.code)).toEqual([0, 0])
    expect(lines(await sh(dir, ["git", "worktree", "list"]))).toHaveLength(2)
    const project = await Effect.runPromise(loadProject(join(await stateTree(dir), ".holyagent")))
    expect(project.intents).toHaveLength(2)
  })

  test("a project that keeps no state is left alone by the commands that only look", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })

    const hook = await holy(dir, ["hook", "session-start"], { agent_type: "holyagent" })
    expect(hook.code).toBe(0)
    expect(toon(await holy(dir, ["status"]))).toEqual({ intents: [] })
    await put(dir, { "a.txt": "a2\n" })
    toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))

    expect(await sh(dir, ["git", "branch", "--list", "holyagent/*"])).toBe("")
    expect(lines(await sh(dir, ["git", "worktree", "list"]))).toHaveLength(1)
  })

  test("the state worktree is made from origin/holyagent/state when the remote has it", async () => {
    const remote = await scratch("holyagent-origin-")
    await sh(remote, ["git", "init", "--bare", "-q", "-b", "main", "."])
    const first = await scratch("holyagent-clone-")
    await sh(first, ["git", "clone", "-q", remote, "."])
    await sh(first, ["git", "config", "user.name", OWNER.name])
    await sh(first, ["git", "config", "user.email", OWNER.email])
    await seed(first, { "a.txt": "a\n" })
    await sh(first, ["git", "push", "-q", "origin", "main"])
    const intent = await createIntent(first, "Ship the parser")
    await sh(first, ["git", "push", "-q", "origin", STATE])

    const second = await scratch("holyagent-clone-")
    await sh(second, ["git", "clone", "-q", remote, "."])
    await sh(second, ["git", "config", "user.name", OWNER.name])
    await sh(second, ["git", "config", "user.email", OWNER.email])
    expect(await sh(second, ["git", "branch", "--list", STATE])).toBe("")

    const listed = toon(await holy(second, ["intent", "list"])) as {
      intents: Array<{ id: string }>
    }

    expect(listed.intents.map((row) => row.id)).toEqual([intent])
    expect((await sh(second, ["git", "rev-parse", STATE])).trim()).toBe(
      (await sh(first, ["git", "rev-parse", STATE])).trim(),
    )
    expect((await sh(second, ["git", "config", `branch.${STATE}.remote`])).trim()).toBe("origin")
  })
})

describe("merging the state", () => {
  test("the state branch changes only .holyagent, and work branches never do", async () => {
    const { dir } = await diverged()

    for (const files of await touched(dir, `main..${STATE}`))
      for (const file of files) expect(file).toStartWith(".holyagent/")
    expect(lines(await sh(dir, ["git", "diff", "--name-only", "main", "stack"]))).toEqual([
      "a.txt",
      "b.txt",
    ])
  })

  test("merging the state branch into a work branch, and a stack on it, has no conflict", async () => {
    const { dir } = await diverged()

    await sh(dir, ["git", "merge", "--no-edit", STATE]) // on `stack`; sh throws on a conflict
    await sh(dir, ["git", "switch", "-q", "feature"])
    await sh(dir, ["git", "merge", "--no-edit", STATE])

    expect(await sh(dir, ["git", "ls-files", "-u"])).toBe("")
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("a2\n")
    expect(lines(await sh(dir, ["git", "ls-files", ".holyagent"])).length).toBeGreaterThan(0)
    // The merged copy is read-only history in the work tree: the commands still use the state worktree.
    expect(toon(await holy(dir, ["status"]))).toMatchObject({ intents: [expect.anything()] })
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
  })

  test("merging a work branch and its stack into the state branch has no conflict", async () => {
    const { dir } = await diverged()
    const tree = await stateTree(dir)

    await sh(tree, ["git", "merge", "--no-edit", "stack"])

    expect(await sh(tree, ["git", "ls-files", "-u"])).toBe("")
    expect(await readFile(join(tree, "b.txt"), "utf8")).toBe("b2\n")
    // The merged state still loads, and a command that records more keeps working on top of it.
    expect(toon(await holy(dir, ["status"]))).toMatchObject({ intents: [expect.anything()] })
    await planAssignment(dir, "Build more", "src/more.ts")
    expect(await sh(tree, ["git", "status", "--porcelain"])).toBe("")
  })

  test("two lines of state that add different records merge cleanly", async () => {
    const remote = await scratch("holyagent-origin-")
    await sh(remote, ["git", "init", "--bare", "-q", "-b", "main", "."])
    const clone = async () => {
      const dir = await scratch("holyagent-clone-")
      await sh(dir, ["git", "clone", "-q", remote, "."])
      await sh(dir, ["git", "config", "user.name", OWNER.name])
      await sh(dir, ["git", "config", "user.email", OWNER.email])
      return dir
    }
    const first = await clone()
    await seed(first, { "a.txt": "a\n", "b.txt": "b\n" })
    await sh(first, ["git", "push", "-q", "origin", "main"])
    const intent = await createIntent(first, "Ship the parser")
    await sh(first, ["git", "push", "-q", "origin", STATE])
    const second = await clone()
    await sh(second, ["git", "fetch", "-q", "origin"])

    // Each line adds its own records: an Assignment and a commit record in one, others in the other.
    const mine = await planAssignment(first, "Build the printer", "src/printer.ts")
    await put(first, { "a.txt": "a2\n" })
    toon(await holy(first, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))
    const theirs = await planAssignment(second, "Build the lexer", "src/lexer.ts")
    await put(second, { "b.txt": "b2\n" })
    toon(await holy(second, ["vcs", "commit", "-m", "Change b", "--", "b.txt"]))
    await sh(first, ["git", "push", "-q", "origin", STATE])

    await sh(second, ["git", "fetch", "-q", "origin"])
    const tree = await stateTree(second)
    await sh(tree, ["git", "merge", "--no-edit", `origin/${STATE}`])

    expect(await sh(tree, ["git", "ls-files", "-u"])).toBe("")
    const listed = toon(await holy(second, ["assignment", "list", "--all"])) as {
      assignments: Array<{ id: string }>
    }
    expect(listed.assignments.map((row) => row.id).toSorted()).toEqual([mine, theirs].toSorted())
    const shown = toon(await holy(second, ["intent", "show", intent])) as { branches: unknown }
    expect(shown.branches).toEqual(["main"])
    const records = lines(await sh(tree, ["git", "ls-files", ".holyagent/intents"]))
    expect(records.filter((path) => path.includes("/branches/"))).toHaveLength(2)
  })
})

describe("recording branches and pull requests on the Intent", () => {
  const withOrigin = async () => {
    const dir = await initRepo(OWNER)
    await sh(dir, ["git", "remote", "add", "origin", "https://github.com/octo/project.git"])
    await seed(dir, { "a.txt": "a\n" })
    await sh(dir, ["git", "switch", "-q", "-c", "feature"])
    return dir
  }

  test("vcs commit records its branch and commit, and vcs pr the pull request, in versioned state", async () => {
    const dir = await withOrigin()
    const intent = await createIntent(dir, "Ship the parser")
    await put(dir, { "a.txt": "a2\n" })

    const done = toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))
    expect(done).toMatchObject({ branch: "feature", files: 1, intent })
    await put(dir, { "a.txt": "a3\n" })
    toon(await holy(dir, ["vcs", "commit", "-m", "Change a again", "--", "a.txt"]))
    const made = toon(await holy(dir, ["vcs", "pr", "--base", "main", "--title", "Add parser"]))
    expect(made).toMatchObject({ number: 7, created: true, intent })
    toon(await holy(dir, ["vcs", "pr", "--update", "7", "--title", "Better title"]))

    const shown = toon(await holy(dir, ["intent", "show"]))
    expect(shown["branches"]).toEqual(["feature"])
    expect(shown["pulls"]).toMatchObject([
      {
        number: 7,
        url: "https://github.com/octo/project/pull/7",
        branch: "feature",
        base: "main",
      },
    ])
    // One file per commit and per call, so lines of state that record different steps never meet.
    const tree = await stateTree(dir)
    const records = lines(await sh(tree, ["git", "ls-files", ".holyagent/intents"]))
    expect(records.filter((path) => path.includes("/branches/"))).toHaveLength(2)
    expect(records.filter((path) => path.includes("/pulls/"))).toHaveLength(2)
    const sha = (await sh(dir, ["git", "rev-parse", "HEAD"])).trim()
    const newest =
      records
        .filter((path) => path.includes("/branches/"))
        .toSorted()
        .at(-1) ?? ""
    expect(JSON.parse(await readFile(join(tree, newest), "utf8"))).toMatchObject({
      intentId: intent,
      branch: "feature",
      commit: sha,
    })
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
  })

  test("with no Intent in use nothing is recorded and the commit still happens", async () => {
    const dir = await withOrigin()
    await put(dir, { "a.txt": "a2\n" })

    const done = toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))

    expect(done).toEqual({ branch: "feature", commit: expect.any(String), files: 1 })
    expect(await sh(dir, ["git", "branch", "--list", STATE])).toBe("")
  })
})

describe("moving the state found in a work tree", () => {
  /** Runs the CLI in a folder that is not a repository, so its state stays where it was written. */
  const legacyState = async (objective: string) => {
    const plain = await scratch("holyagent-plain-")
    const result = await holy(plain, ["intent", "create"], { objective })
    return { plain, id: String(toon(result).id) }
  }

  test("uncommitted state is moved into the state worktree once, and the work tree is left clean", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const { plain, id } = await legacyState("Ship the parser")
    await sh(dir, ["cp", "-r", join(plain, ".holyagent"), join(dir, ".holyagent")])

    const listed = toon(await holy(dir, ["intent", "list"])) as {
      intents: Array<{ id: string; inUse: boolean }>
    }

    expect(listed.intents).toMatchObject([{ id, inUse: true }])
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
    expect(await Bun.file(join(dir, ".holyagent")).exists()).toBe(false)
    const migrated = lines(
      await sh(dir, ["git", "ls-tree", "-r", "--name-only", STATE, ".holyagent"]),
    )
    expect(migrated).toHaveLength(1)
    expect(migrated[0]).toEndWith("/intent.json")
    expect(lines(await sh(dir, ["git", "log", "--format=%s", STATE]))).toEqual([
      "chore(state): migrate the state found in a work tree",
      "seed",
    ])

    // The marker is per work tree: state written there later is not picked up again.
    const late = await legacyState("Ship the printer")
    await sh(dir, ["cp", "-r", join(late.plain, ".holyagent"), join(dir, ".holyagent")])
    const again = toon(await holy(dir, ["intent", "list"])) as { intents: Array<{ id: string }> }
    expect(again.intents.map((row) => row.id)).toEqual([id])
  })

  test("a new state worktree takes in the uncommitted state of every work tree of the clone", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const { plain, id } = await legacyState("Ship the parser")
    await sh(dir, ["cp", "-r", join(plain, ".holyagent"), join(dir, ".holyagent")])
    const tree = join(await scratch("holyagent-worktree-"), "tree")
    await sh(dir, ["git", "worktree", "add", "-q", "-b", "feature", tree])

    // The first command of the clone runs in the linked worktree; the state sits in the main one.
    const listed = toon(await holy(tree, ["intent", "list"])) as { intents: Array<{ id: string }> }

    expect(listed.intents.map((row) => row.id)).toEqual([id])
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
    expect(await sh(tree, ["git", "status", "--porcelain"])).toBe("")
  })

  test("an uncommitted edit of a committed record wins over the state branch's copy", async () => {
    const dir = await initRepo(OWNER)
    const { plain, id } = await legacyState("Ship the parser")
    await put(dir, { "a.txt": "a\n" })
    await sh(dir, ["cp", "-r", join(plain, ".holyagent"), join(dir, ".holyagent")])
    await writeFile(join(dir, ".holyagent", "local", ".gitignore"), "*\n")
    await sh(dir, ["git", "add", "-A"])
    await sh(dir, ["git", "commit", "-q", "-m", "seed"])
    const record = lines(await sh(dir, ["git", "ls-files", ".holyagent/intents"]))[0] ?? ""
    const stored = JSON.parse(await readFile(join(dir, record), "utf8")) as Record<string, unknown>
    await writeFile(
      join(dir, record),
      `${JSON.stringify({ ...stored, objective: "Ship the parser v2" }, null, 2)}\n`,
    )

    const shown = toon(await holy(dir, ["intent", "show", id]))

    expect(shown["objective"]).toBe("Ship the parser v2")
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
    expect(JSON.parse(await sh(dir, ["git", "show", `${STATE}:${record}`]))).toMatchObject({
      objective: "Ship the parser v2",
    })
    expect(JSON.parse(await sh(dir, ["git", "show", `HEAD:${record}`]))).toMatchObject({
      objective: "Ship the parser",
    })
    expect((await stat(join(await stateTree(dir), record))).isFile()).toBe(true)
  })
})

describe("starting the state in a large tree", () => {
  test("six commands that start at once all succeed while the state worktree is still being checked out", async () => {
    const dir = await initRepo(OWNER)
    const files: Record<string, string> = {}
    for (let index = 0; index < 3000; index++) files[`src/dir${index % 30}/f${index}.txt`] = "x\n"
    await seed(dir, files)

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        holy(dir, ["intent", "create"], { objective: `Objective ${index}` }),
      ),
    )

    expect(results.map((result) => result.stderr)).toEqual(Array.from({ length: 6 }, () => ""))
    expect(results.map((result) => result.code)).toEqual(Array.from({ length: 6 }, () => 0))
    expect(lines(await sh(dir, ["git", "worktree", "list"]))).toHaveLength(2)
    const project = await Effect.runPromise(loadProject(join(await stateTree(dir), ".holyagent")))
    expect(project.intents).toHaveLength(6)
  }, 120_000)
})

describe("the config file of the project", () => {
  test("an untracked config.json stays in the work tree and is never moved into the state", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const config = '{"vcs":{"allowWords":["Claude Code"],"stateBranch":"team/state"}}\n'
    await put(dir, { ".holyagent/config.json": config })

    await createIntent(dir, "First")
    await createIntent(dir, "Second")

    expect(await readFile(join(dir, ".holyagent", "config.json"), "utf8")).toBe(config)
    expect(await sh(dir, ["git", "branch", "--list", "team/*"])).toBe("")
    expect(lines(await sh(dir, ["git", "worktree", "list"]))).toHaveLength(2)
    expect(await sh(dir, ["git", "ls-tree", "-r", "--name-only", STATE])).not.toContain(
      "config.json",
    )
    // The settings are the work tree's: the word the file allows passes the message check.
    await put(dir, { "a.txt": "a2\n" })
    const done = await holy(dir, [
      "vcs",
      "commit",
      "-m",
      "document Claude Code usage",
      "--",
      "a.txt",
    ])
    expect(done.code).toBe(0)
  })

  test("an edit of a tracked config.json in the work tree takes effect at once", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n", ".holyagent/config.json": '{"vcs":{}}\n' })
    await createIntent(dir, "Ship the parser")
    await put(dir, { "a.txt": "a2\n" })
    const refused = await holy(dir, [
      "vcs",
      "commit",
      "-m",
      "document Claude Code usage",
      "--",
      "a.txt",
    ])
    expect(refused.code).toBe(3)

    await put(dir, { ".holyagent/config.json": '{"vcs":{"allowWords":["Claude Code"]}}\n' })
    const done = await holy(dir, [
      "vcs",
      "commit",
      "-m",
      "document Claude Code usage",
      "--",
      "a.txt",
    ])

    expect(done.code).toBe(0)
  })

  test("a state branch named by the repository's own files is ignored", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, {
      "a.txt": "a\n",
      ".holyagent/config.json": '{"vcs":{"stateBranch":"main"}}\n',
    })
    const before = (await sh(dir, ["git", "rev-parse", "main"])).trim()

    await createIntent(dir, "Ship the parser")

    expect((await sh(dir, ["git", "rev-parse", "main"])).trim()).toBe(before)
    expect(lines(await sh(dir, ["git", "branch", "--list", STATE]))).toHaveLength(1)
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
  })

  test("two branch names that look alike get their own state worktrees", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    await sh(dir, ["git", "config", "holyagent.stateBranch", "holyagent-state"])
    const first = await createIntent(dir, "First")
    const tree = await stateTree(dir, "holyagent-state")

    await sh(dir, ["git", "config", "holyagent.stateBranch", STATE])
    const second = await createIntent(dir, "Second")

    expect(await stateTree(dir, STATE)).not.toBe(tree)
    expect(lines(await sh(dir, ["git", "worktree", "list"]))).toHaveLength(3)
    const kept = await Effect.runPromise(loadProject(join(tree, ".holyagent")))
    expect(kept.intents.map((intent) => intent.id)).toEqual([first])
    const other = await Effect.runPromise(loadProject(join(await stateTree(dir), ".holyagent")))
    expect(other.intents.map((intent) => intent.id)).toEqual([second])
  })
})

describe("the base of a new state branch", () => {
  test("a repository with no commit keeps its state in the work tree until the base has one, then merges cleanly", async () => {
    const dir = await initRepo(OWNER)
    const first = await createIntent(dir, "Ship the parser")
    expect(await sh(dir, ["git", "branch", "--list", STATE])).toBe("")

    await put(dir, { "a.txt": "a\n" })
    await sh(dir, ["git", "add", "a.txt"])
    await sh(dir, ["git", "commit", "-q", "-m", "first"])
    const listed = toon(await holy(dir, ["intent", "list"])) as { intents: Array<{ id: string }> }

    expect(listed.intents.map((row) => row.id)).toEqual([first])
    await sh(dir, ["git", "merge", "--no-edit", STATE]) // an unrelated history would fail here
    expect(await sh(dir, ["git", "merge-base", "main", STATE])).toBe(
      await sh(dir, ["git", "rev-parse", "main"]),
    )
    const tree = await stateTree(dir)
    await sh(tree, ["git", "merge", "--no-edit", "main"])
    expect(await sh(tree, ["git", "status", "--porcelain"])).toBe("")
  })

  test("a repository without main starts the state at its default branch, never at the current commit", async () => {
    const dir = await initRepo(OWNER)
    await sh(dir, ["git", "branch", "-m", "main", "develop"])
    await sh(dir, ["git", "config", "init.defaultBranch", "develop"])
    const base = await seed(dir, { "a.txt": "a\n" })
    await sh(dir, ["git", "switch", "-q", "-c", "feature"])
    await put(dir, { "a.txt": "a2\n" })
    await sh(dir, ["git", "commit", "-q", "-am", "feature work"])

    await createIntent(dir, "Ship the parser")

    expect((await sh(dir, ["git", "merge-base", "develop", STATE])).trim()).toBe(base)
    expect(await sh(dir, ["git", "log", "--format=%s", `develop..${STATE}`])).not.toContain(
      "feature work",
    )
    await sh(dir, ["git", "switch", "-q", "develop"])
    await sh(dir, ["git", "merge", "--no-edit", STATE])
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("a\n")
  })

  test("a repository whose base cannot be told makes no state branch and keeps the state in the work tree", async () => {
    const dir = await initRepo(OWNER)
    await sh(dir, ["git", "branch", "-m", "main", "trunk"])
    await seed(dir, { "a.txt": "a\n" })
    await sh(dir, ["git", "switch", "-q", "-c", "feature"])

    await createIntent(dir, "Ship the parser")

    expect(await sh(dir, ["git", "branch", "--list", STATE])).toBe("")
    expect(lines(await sh(dir, ["git", "worktree", "list"]))).toHaveLength(1)
  })
})

describe("a state worktree that is not what it should be", () => {
  /** A clone with a state worktree, and a linked worktree on `feature` to run commands from. */
  const withLinked = async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    await createIntent(dir, "Ship the parser")
    const tree = join(await scratch("holyagent-worktree-"), "tree")
    await sh(dir, ["git", "worktree", "add", "-q", "-b", "feature", tree])
    return { dir, tree, state: await stateTree(dir) }
  }

  test("migration does not write through a symlink in the state worktree", async () => {
    const { tree, state } = await withLinked()
    const outside = await scratch("holyagent-outside-")
    const victim = join(outside, "victim.txt")
    await symlink(victim, join(state, ".holyagent", "note.txt"))
    await mkdir(join(outside, "shared"))
    await symlink(join(outside, "shared"), join(state, ".holyagent", "linked"))
    await put(tree, {
      ".holyagent/note.txt": "attacker\n",
      ".holyagent/linked/p.txt": "attacker\n",
    })

    const result = await holy(tree, ["intent", "list"])

    expect(result.code).toBe(4)
    expect(await Bun.file(victim).exists()).toBe(false)
    expect(await Bun.file(join(outside, "shared", "p.txt")).exists()).toBe(false)
  })

  test("migration leaves a symlink in a work tree out of the state", async () => {
    const { tree, state } = await withLinked()
    const outside = await scratch("holyagent-outside-")
    await writeFile(join(outside, "secret.txt"), "secret\n")
    await mkdir(join(tree, ".holyagent"), { recursive: true })
    await symlink(join(outside, "secret.txt"), join(tree, ".holyagent", "leak.md"))
    await put(tree, { ".holyagent/real.md": "real\n" })

    const result = await holy(tree, ["intent", "list"])

    expect(result.code).toBe(0)
    expect(await Bun.file(join(state, ".holyagent", "leak.md")).exists()).toBe(false)
    expect(await sh(state, ["git", "log", "--all", "-p"])).not.toContain("secret")
    expect(await readFile(join(state, ".holyagent", "real.md"), "utf8")).toBe("real\n")
  })

  test("migration refuses a state worktree whose .holyagent folder is a symlink", async () => {
    const { tree, state } = await withLinked()
    const outside = await scratch("holyagent-outside-")
    await rm(join(state, ".holyagent"), { recursive: true })
    await symlink(outside, join(state, ".holyagent"))
    await put(tree, { ".holyagent/real.md": "attacker\n" })

    const result = await holy(tree, ["intent", "list"])

    expect(result.code).toBe(4)
    expect(result.stderr).toContain(join(state, ".holyagent"))
    expect(await readdir(outside)).toEqual([])
  })

  test("migration leaves a work tree whose .holyagent folder is a symlink out of the state", async () => {
    const { tree, state } = await withLinked()
    const outside = await scratch("holyagent-outside-")
    await writeFile(join(outside, "secret.md"), "secret\n")
    await symlink(outside, join(tree, ".holyagent"))

    const result = await holy(tree, ["intent", "list"])

    expect(result.code).toBe(0)
    expect(await Bun.file(join(state, ".holyagent", "secret.md")).exists()).toBe(false)
    expect(await sh(state, ["git", "log", "--all", "-p"])).not.toContain("secret")
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("secret\n")
  })

  test("a state worktree switched to another branch is reported and its folder is kept", async () => {
    const { dir, state } = await withLinked()
    await put(state, { ".holyagent/local/keep.txt": "per-clone\n" })
    await sh(state, ["git", "switch", "-q", "--detach"])

    const result = await holy(dir, ["intent", "list"])

    expect(result.code).toBe(4)
    expect(result.stderr).toContain(state)
    expect(await readFile(join(state, ".holyagent", "local", "keep.txt"), "utf8")).toBe(
      "per-clone\n",
    )
    expect(await sh(state, ["git", "rev-parse", "HEAD"])).toBe(
      await sh(dir, ["git", "rev-parse", STATE]),
    )
  })
})
