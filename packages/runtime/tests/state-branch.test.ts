import { afterAll, afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { writeFileSync } from "node:fs"
import * as filesystem from "node:fs/promises"
import { cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"

import { $ } from "bun"
import { Effect, Exit } from "effect"

import { fromGitPath, toPosix } from "../src/domain/paths.ts"
import { deadlineIn, withFileLock } from "../src/state/lock.ts"
import { loadProject } from "../src/state/store.ts"
import {
  commitState,
  fetchEnvironment,
  fetchRemoteBranch,
  killGroup,
  releaseGroup,
} from "../src/state/tree.ts"
import { PROCESS_TIMEOUT_MS } from "./fixtures.ts"
import {
  cleanup,
  fakeGitHub,
  GIT_ENV,
  initRepo,
  put,
  scratch,
  seed,
  sh,
  toon,
  vcs,
} from "./vcs-fixtures.ts"

// Every test runs a dozen or more git processes, and process creation on Windows is slow enough
// (2 to 5 seconds a test on the CI runner) to pass Bun's 5 second default; a slow test there is not
// a hung one. Linux and macOS keep the default.
if (process.platform === "win32") setDefaultTimeout(60_000)
afterAll(() => setDefaultTimeout(5_000))

/**
 * Removing the scratch directories of the large-tree test (3000 files in the work tree and again in
 * the state worktree) took longer than Bun's 5 second hook default on the Windows runner. Bun reads
 * a hook's default when the hook is registered, so the hook below is registered after the default
 * is raised and also carries its own limit; this one fires first and names what was too slow.
 */
const removeScratch = () => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const tooSlow = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`removing the scratch directories took longer than ${PROCESS_TIMEOUT_MS} ms`),
        ),
      PROCESS_TIMEOUT_MS,
    )
  })
  return Promise.race([cleanup(), tooSlow]).finally(() => clearTimeout(timer))
}
afterEach(removeScratch, PROCESS_TIMEOUT_MS + 5_000)

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
          ? {
              number: 7,
              html_url: "https://github.com/octo/project/pull/7",
              head: { ref: "feature" },
            }
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
  // Git prints `C:/repo/...` on Windows; the commands name the same folder with backslashes.
  return fromGitPath(path)
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

  test("the state branch is fetched from origin when the clone has no remote-tracking ref for it", async () => {
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
    await sh(second, ["git", "update-ref", "-d", `refs/remotes/origin/${STATE}`])
    expect(await sh(second, ["git", "branch", "--all", "--list", `*${STATE}`])).toBe("")

    const added = await createIntent(second, "Ship the printer")
    const listed = toon(await holy(second, ["intent", "list"])) as {
      intents: Array<{ id: string }>
    }

    expect(listed.intents.map((row) => row.id).toSorted()).toEqual([added, intent].toSorted())
    await sh(second, [
      "git",
      "merge-base",
      "--is-ancestor",
      (await sh(first, ["git", "rev-parse", STATE])).trim(),
      STATE,
    ])
    expect((await sh(second, ["git", "config", `branch.${STATE}.remote`])).trim()).toBe("origin")
  })

  test("writers in different worktrees may own the same path, and in one worktree they may not", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    await createIntent(dir, "Ship the parser")
    const tree = join(await scratch("holyagent-worktree-"), "tree")
    await sh(dir, ["git", "worktree", "add", "-q", "-b", "feature", tree])
    const first = await planAssignment(dir, "Build the parser", "src/parser.ts")
    const second = await planAssignment(dir, "Build the parser again", "src/parser.ts")
    const third = await planAssignment(dir, "Build the parser once more", "src/parser.ts")

    // The dispatch prints TOON fields and then the prompt, which is not TOON, so its text is read.
    const started = await holy(dir, ["assignment", "dispatch"], { id: first })
    expect(started.code).toBe(0)
    expect(started.stdout).toContain("state: Running")
    // The other worktree has its own copy of src/parser.ts.
    const beside = await holy(tree, ["assignment", "dispatch"], { id: second })
    expect(beside.code).toBe(0)
    expect(beside.stdout).toContain("state: Running")
    // Each worktree still holds its own path against a third writer.
    for (const where of [dir, tree]) {
      const refused = await holy(where, ["assignment", "dispatch"], { id: third })
      expect(refused.code).not.toBe(0)
      expect(refused.stderr).toContain("OwnershipConflict")
    }
  })

  test("the work tree of a Running writer is kept in the clone's local files, not in the shared record", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    await createIntent(dir, "Ship the parser")
    const id = await planAssignment(dir, "Build the parser", "src/parser.ts")
    await holy(dir, ["assignment", "dispatch"], { id })
    const state = join(await stateTree(dir), ".holyagent")
    const file = (await readdir(join(state, "intents"), { recursive: true })).find(
      (name) => name.endsWith(".json") && name.includes("assignments") && name.includes(id),
    )

    // An older plugin refuses a key it does not know, so the record must not carry one.
    const record = JSON.parse(await readFile(join(state, "intents", String(file)), "utf8")) as {
      state: string
      specialist: object
    }
    expect(record.state).toBe("Running")
    expect(record.specialist).not.toHaveProperty("workTree")
    const local = join(state, "local", "work-trees.json")
    const kept = async () =>
      (JSON.parse(await readFile(local, "utf8")) as { workTrees: Record<string, string> }).workTrees
    expect(Object.keys(await kept())).toEqual([id])

    await holy(dir, ["assignment", "record", id, "--agent", "agent-1"])
    expect(Object.keys(await kept())).toEqual([id])
    await holy(dir, ["assignment", "close", id, "--outcome", "failure"])
    expect(await kept()).toEqual({})
  })

  test("plan offers a path that only another worktree's writer holds", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    await createIntent(dir, "Ship the parser")
    const tree = join(await scratch("holyagent-worktree-"), "tree")
    await sh(dir, ["git", "worktree", "add", "-q", "-b", "feature", tree])
    const first = await planAssignment(dir, "Build the parser", "src/parser.ts")
    const second = await planAssignment(dir, "Build the parser again", "src/parser.ts")
    await holy(dir, ["assignment", "dispatch"], { id: first })

    expect(toon(await holy(tree, ["plan"]))).toMatchObject({ assignments: [second] })
    expect(toon(await holy(dir, ["plan"]))).toMatchObject({ action: "none" })
  })

  /**
   * An Assignment dispatched and recorded, with a brief and a report file; returns the id and both
   * paths.
   */
  const dispatched = async (dir: string, objective: string, path: string) => {
    const id = await planAssignment(dir, objective, path)
    await holy(dir, ["assignment", "dispatch"], { id })
    await holy(dir, ["assignment", "record", id, "--agent", `agent-${id}`])
    await put(join(dir, ".git", "holyagent"), { [`reports/${id}.md`]: "the report\n" })
    return {
      id,
      brief: join(dir, ".git", "holyagent", "briefs", `${id}.md`),
      report: join(dir, ".git", "holyagent", "reports", `${id}.md`),
    }
  }

  const exist = async (...paths: ReadonlyArray<string>) =>
    Promise.all(
      paths.map((path) =>
        stat(path).then(
          () => true,
          () => false,
        ),
      ),
    )

  test("the brief and report files stay while the Intent is open and go when it is closed", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const first = await createIntent(dir, "Ship the parser")
    const mine = await dispatched(dir, "Build the parser", "src/parser.ts")
    await createIntent(dir, "Ship the printer")
    const other = await dispatched(dir, "Build the printer", "src/printer.ts")
    await holy(dir, ["intent", "use", first])
    expect(await exist(mine.brief, mine.report)).toEqual([true, true])

    // Accepting the Assignment leaves its files, so a later brief can cite the report.
    const accepted = await holy(
      dir,
      ["assignment", "close", mine.id, "--outcome", "success", "--accept", "fine", "--report-json"],
      {
        status: "done",
        changed_paths: [],
        checks: [],
        blockers: [],
        notes: [],
        evidence: ["works", "tests"].map((key) => ({ key, support: "checked" })),
      },
    )
    expect(toon(accepted)).toMatchObject({ id: mine.id, accepted: true })
    expect(await exist(mine.brief, mine.report)).toEqual([true, true])

    // Closing the Intent removes the files of its Assignments only.
    const closed = toon(await holy(dir, ["intent", "close", "--reason", "shipped"]))
    expect(closed["unremoved"]).toBeUndefined()
    expect(await exist(mine.brief, mine.report)).toEqual([false, false])
    expect(await exist(other.brief, other.report)).toEqual([true, true])
  })

  test("a file that cannot be removed when the Intent closes is reported, not swallowed", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    await createIntent(dir, "Ship the parser")
    const mine = await dispatched(dir, "Build the parser", "src/parser.ts")
    // A folder where the report file should be makes the removal fail.
    await rm(mine.report)
    await mkdir(join(mine.report, "inside"), { recursive: true })

    const closed = await holy(dir, ["intent", "close", "--reason", "shipped", "--drop", "stop"])

    expect(closed.code).toBe(0)
    // The CLI reports the path git resolves, which on Windows is the long form of the 8.3 temp directory.
    expect(String(toon(closed)["unremoved"])).toContain(await filesystem.realpath(mine.report))
    expect(await exist(mine.brief)).toEqual([false])
    expect(await exist(mine.report)).toEqual([true])
  })

  test("a remote that cannot be reached leaves the state branch starting from the base", async () => {
    const dir = await initRepo(OWNER)
    await sh(dir, ["git", "remote", "add", "origin", join(dir, "missing-remote")])
    const base = await seed(dir, { "a.txt": "a\n" })

    await createIntent(dir, "Ship the parser")

    expect((await sh(dir, ["git", "merge-base", STATE, "main"])).trim()).toBe(base)
  })
})

describe("a state commit", () => {
  test("takes the mode and branch it is given and does not read them from git config again", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    await createIntent(dir, "Ship the parser")
    const directory = join(await stateTree(dir), ".holyagent")
    const intents = join(directory, "intents")
    const file = join(
      intents,
      String(
        (await readdir(intents, { recursive: true })).find((name) => name.endsWith("intent.json")),
      ),
    )
    await writeFile(file, (await readFile(file, "utf8")).replace("Ship the parser", "Ship it"))
    const commit = (resolved: Parameters<typeof commitState>[4]) =>
      Effect.runPromise(commitState(directory, GIT_ENV, "chore(state): edit", [], resolved))
    const heads = async () => (await sh(dir, ["git", "rev-parse", STATE])).trim()
    const before = await heads()

    // Git config says branch mode on holyagent/state; the given values decide, not the config.
    expect(await commit({ mode: "work" })).toBe(false)
    expect(await commit({ mode: "branch", branch: "another" })).toBe(false)
    expect(await heads()).toBe(before)

    expect(await commit({ mode: "branch", branch: STATE })).toBe(true)
    expect(await heads()).not.toBe(before)
  })
})

describe("the fetch of the remote state branch", () => {
  /**
   * A clone whose origin is an ssh URL and whose `ssh` is a script that logs how it was called (its
   * arguments and the askpass variables) and then runs `behavior`, so nothing leaves the machine.
   */
  const overSsh = async (behavior: string) => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    // Even if ssh lookup fails, the fallback cannot reach an external host.
    await sh(dir, ["git", "remote", "add", "origin", "ssh://git@127.0.0.1:1/octo/project.git"])
    const bin = await scratch("holyagent-bin-")
    // Git runs the ssh command through a POSIX shell, where a backslash escapes the next character,
    // so the paths in the command and in the script are written the way git prints them.
    const log = toPosix(join(bin, "ssh.log"))
    const script = toPosix(join(bin, "ssh"))
    await writeFile(
      script,
      `#!/bin/sh\necho "args: $*" >> "${log}"\necho "askpass: [${"$"}{SSH_ASKPASS-unset}] [${"$"}{SSH_ASKPASS_REQUIRE-unset}] [${"$"}{GIT_ASKPASS-unset}]" >> "${log}"\n${behavior}\n`,
      { mode: 0o755 },
    )
    const logged = async () => ((await Bun.file(log).exists()) ? await Bun.file(log).text() : "")
    const path = `${bin}${delimiter}${process.env["PATH"] ?? process.env["Path"] ?? ""}`
    // Windows can inherit Path and PATH as separate object keys; Git may read either one.
    const env = { PATH: path, ...(process.platform === "win32" ? { Path: path } : {}) }
    return { dir, bin, script, env, logged }
  }

  test("the default ssh environment is non-interactive", () => {
    const env = fetchEnvironment(
      {
        ...GIT_ENV,
        GIT_SSH: undefined,
        GIT_SSH_COMMAND: undefined,
        SSH_ASKPASS: "/bin/false",
        SSH_ASKPASS_REQUIRE: "force",
        GIT_ASKPASS: "/bin/false",
      },
      undefined,
    )

    expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes -o ConnectTimeout=5")
    expect(env.SSH_ASKPASS).toBeUndefined()
    expect(env.SSH_ASKPASS_REQUIRE).toBeUndefined()
    expect(env.GIT_ASKPASS).toBe("")
    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
    expect(env.GCM_INTERACTIVE).toBe("never")
  })

  test("ssh runs in batch mode with a connect timeout and no askpass program", async () => {
    const { dir, env, logged } = await overSsh("exit 255")

    toon(
      await vcs(
        dir,
        ["intent", "create"],
        fakeGitHub().layer,
        { objective: "Ship the parser" },
        {
          ...env,
          SSH_ASKPASS: "/bin/false",
          SSH_ASKPASS_REQUIRE: "force",
          GIT_ASKPASS: "/bin/false",
        },
      ),
    )

    const log = await logged()
    expect(log).toContain("BatchMode=yes")
    expect(log).toContain("ConnectTimeout=5")
    expect(log).toContain("askpass: [unset] [unset] []")
    // An unreachable remote still leaves a working state branch.
    expect((await sh(dir, ["git", "rev-parse", "--verify", STATE])).trim()).not.toBe("")
  })

  test("an ssh command the user chose is kept", async () => {
    const { dir, script, logged } = await overSsh("exit 255")

    toon(
      await vcs(
        dir,
        ["intent", "create"],
        fakeGitHub().layer,
        { objective: "Ship the parser" },
        { GIT_SSH_COMMAND: `${script} -o Chosen=yes` },
      ),
    )

    const log = await logged()
    expect(log).toContain("Chosen=yes")
    expect(log).not.toContain("BatchMode")
  })

  test("a configured core.sshCommand is still used, in batch mode with a connect timeout", async () => {
    const { dir, script, logged } = await overSsh("exit 255")
    await sh(dir, ["git", "config", "core.sshCommand", `${script} -o Configured=yes`])

    toon(await vcs(dir, ["intent", "create"], fakeGitHub().layer, { objective: "Ship the parser" }))

    const log = await logged()
    expect(log).toContain("Configured=yes")
    expect(log).toContain("BatchMode=yes")
    expect(log).toContain("ConnectTimeout=")
  })

  test("a configured core.sshCommand wins over GIT_SSH, so it gets the batch options too", async () => {
    const { dir, script, logged } = await overSsh("exit 255")
    await sh(dir, ["git", "config", "core.sshCommand", `${script} -o Configured=yes`])

    toon(
      await vcs(
        dir,
        ["intent", "create"],
        fakeGitHub().layer,
        { objective: "Ship the parser" },
        { GIT_SSH: join(dir, "not-used-ssh") },
      ),
    )

    const log = await logged()
    expect(log).toContain("Configured=yes")
    expect(log).toContain("BatchMode=yes")
    expect(log).toContain("ConnectTimeout=")
  })

  test("the credential helpers the user configured still answer an https remote", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const bin = await scratch("holyagent-bin-")
    const log = toPosix(join(bin, "helper.log"))
    const helper = toPosix(join(bin, "helper.sh"))
    await writeFile(helper, `#!/bin/sh\necho "$1" >> "${log}"\n`, { mode: 0o755 })
    // A server that demands credentials, so git asks its helper for them.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("denied", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } }),
    })
    try {
      await sh(dir, [
        "git",
        "remote",
        "add",
        "origin",
        `http://localhost:${server.port}/octo/p.git`,
      ])
      await sh(dir, ["git", "config", "credential.helper", helper])

      const found = await Effect.runPromise(fetchRemoteBranch(dir, GIT_ENV, STATE))

      expect(found).toBe(false)
      expect(await Bun.file(log).text()).toContain("get")
    } finally {
      await server.stop(true)
    }
  })

  test("a fetch that hangs is killed at its timeout and counts as no remote branch", async () => {
    const { dir, script } = await overSsh("sleep 5")
    const started = Date.now()

    const found = await Effect.runPromise(
      fetchRemoteBranch(dir, { ...GIT_ENV, GIT_SSH_COMMAND: script }, STATE, 300),
    )

    expect(found).toBe(false)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  describe("the group kill", () => {
    /** Runs `body` with `process.kill` recorded instead of sent. */
    const recording = async (body: () => Promise<void>) => {
      const calls: Array<[number, string | number | undefined]> = []
      const spy = spyOn(process, "kill").mockImplementation((pid, signal) => {
        calls.push([pid, signal])
        return true
      })
      try {
        await body()
      } finally {
        spy.mockRestore()
      }
      return calls
    }
    const kill = () => {}
    const failed = Exit.fail("interrupted")

    test("never signals a pid of 1 or less, which would reach every process or none", async () => {
      const calls = await recording(async () => {
        for (const pid of [1, 0, -1, -7, 1.5, Number.NaN, undefined as unknown as number])
          await Effect.runPromise(killGroup({ pid, kill }, "linux"))
      })

      expect(calls).toEqual([])
    })

    test("signals the group of a child with a real pid", async () => {
      const calls = await recording(() =>
        Effect.runPromise(killGroup({ pid: 4242, kill }, "linux")),
      )

      expect(calls).toEqual([[-4242, "SIGKILL"]])
    })

    test("a failed use kills the group of a running child but not of one that already exited", async () => {
      const calls = await recording(async () => {
        await Effect.runPromise(releaseGroup({ pid: 4242, kill, exitCode: null }, failed, "linux"))
        await Effect.runPromise(releaseGroup({ pid: 4343, kill, exitCode: 0 }, failed, "linux"))
        await Effect.runPromise(releaseGroup({ pid: 4444, kill, exitCode: 128 }, failed, "linux"))
        await Effect.runPromise(
          releaseGroup({ pid: 4545, kill, exitCode: null }, Exit.succeed(0), "linux"),
        )
      })

      expect(calls).toEqual([[-4242, "SIGKILL"]])
    })

    test("on Windows, which has no process groups, the child is killed itself and no group is signalled", async () => {
      const killed: Array<string | number | undefined> = []
      // A pid no process has, so the tree kill that Windows runs first reaches nothing real.
      const child = {
        pid: 2_000_000_000,
        kill: (signal?: string | number) => void killed.push(signal),
      }

      const calls = await recording(() => Effect.runPromise(killGroup(child, "win32")))

      expect(calls).toEqual([])
      expect(killed).toEqual(["SIGKILL"])
    })
  })

  test("a fetch killed at its timeout leaves no helper process running", async () => {
    const pidFile = toPosix(join(await scratch("holyagent-pid-"), "helper.pid"))
    // The helper stands for an ssh or credential helper that git started and then hangs on.
    const { dir, script } = await overSsh(`sleep 30 &\necho $! > "${pidFile}"\nwait`)

    const found = await Effect.runPromise(
      fetchRemoteBranch(dir, { ...GIT_ENV, GIT_SSH_COMMAND: script }, STATE, 1500),
    )

    expect(found).toBe(false)
    const pid = Number((await Bun.file(pidFile).text()).trim())
    expect(pid).toBeGreaterThan(1)
    // A killed process nobody reaps stays a zombie (state Z) until its parent does; it runs no code.
    const alive = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const state = (await $`ps -o stat= -p ${pid}`.quiet().nothrow().text()).trim()
        if (state === "" || state.startsWith("Z")) return false
        await Bun.sleep(50)
      }
      return true
    }
    expect(await alive()).toBe(false)
  })

  test("a hook makes no network call, and the next command fetches", async () => {
    const { dir, env: pathEnv, logged } = await overSsh("exit 255")
    const env = {
      ...pathEnv,
      SSH_ASKPASS: "/bin/false",
      SSH_ASKPASS_REQUIRE: "force",
      GIT_ASKPASS: "/bin/false",
    }
    // A work tree that already holds state is a project that keeps state, which makes the state worktree.
    await put(dir, { ".holyagent/local/note.json": "{}\n" })
    const payload = { hook_event_name: "SessionStart", source: "startup" }

    const hooked = await vcs(dir, ["hook", "session-start"], fakeGitHub().layer, payload, env)

    expect(hooked.stderr).toBe("")
    expect(await logged()).toBe("")
    expect(await sh(dir, ["git", "branch", "--list", STATE])).toBe("")

    toon(await vcs(dir, ["intent", "list"], fakeGitHub().layer, undefined, env))

    const log = await logged()
    expect(log).toContain("BatchMode=yes")
    expect(log).toContain("ConnectTimeout=5")
    expect(log).toContain("askpass: [unset] [unset] []")
  })
})

describe("a base branch that ignores the state folder", () => {
  test("state transitions are still committed on the state branch, and the work branch's ignore rules stay", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n", ".gitignore": "/.holyagent/\n" })

    const intent = await createIntent(dir, "Ship the parser")

    const tracked = lines(await sh(dir, ["git", "ls-tree", "-r", "--name-only", STATE]))
    expect(tracked.some((path) => path.includes(`${intent}`))).toBe(true)
    expect(tracked.some((path) => path.startsWith(".holyagent/local/"))).toBe(false)
    expect(await sh(dir, ["git", "show", "main:.gitignore"])).toBe("/.holyagent/\n")
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
  })

  test("a stray file that its own ignore rule covers is never committed, a record always is", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n", ".gitignore": "/.holyagent/\n" })
    const first = await createIntent(dir, "Ship the parser")
    const tree = await stateTree(dir)
    const state = join(tree, ".holyagent")
    const folder = (await readdir(join(state, "intents")))[0] ?? ""
    await writeFile(join(state, ".gitignore"), "scratch.txt\nintents/*/notes.json\n")
    await writeFile(join(state, "scratch.txt"), "stray\n")
    await writeFile(join(state, "intents", folder, "notes.json"), "{}\n")
    await writeFile(join(state, "intents", folder, "draft.tmp"), "stray\n")

    const second = await createIntent(dir, "Ship the lexer")

    const tracked = lines(await sh(dir, ["git", "ls-tree", "-r", "--name-only", STATE]))
    expect(tracked.some((path) => path.includes(`${first}/intent.json`))).toBe(true)
    expect(tracked.some((path) => path.includes(`${second}/intent.json`))).toBe(true)
    for (const stray of ["scratch.txt", "notes.json", "draft.tmp", ".holyagent/.gitignore"])
      expect({ stray, committed: tracked.some((path) => path.endsWith(stray)) }).toEqual({
        stray,
        committed: false,
      })
  })
})

describe("the first commit on a state branch that tracks nothing yet", () => {
  test("git is never asked to update a pathspec that matches no tracked file", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    // A git that, like newer releases, rejects `add -u` for a pathspec that matches nothing tracked.
    const bin = await scratch("holyagent-git-")
    const real = Bun.which("git") ?? "git"
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        `if [ "$1" = add ] && [ "$2" = -u ]; then`,
        "  shift 3",
        `  if [ -z "$("${real}" ls-files -- "$@")" ]; then`,
        `    echo "error: pathspec '$1' did not match any file(s) known to git" >&2`,
        "    exit 128",
        "  fi",
        '  set -- add -u -- "$@"',
        "fi",
        `exec "${real}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    )

    const created = toon(
      await vcs(
        dir,
        ["intent", "create"],
        fakeGitHub().layer,
        { objective: "Ship the parser" },
        {
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        },
      ),
    ) as { id: string }

    const tracked = lines(await sh(dir, ["git", "ls-tree", "-r", "--name-only", STATE]))
    expect(tracked.some((path) => path.endsWith(`${created.id}/intent.json`))).toBe(true)
  })
})

describe("staging the state files of a long history", () => {
  // The git that counts arguments is a shell script, which Windows does not run as `git`.
  test.skipIf(process.platform === "win32")(
    "the command line of a state commit does not grow with the number of records",
    async () => {
      const dir = await initRepo(OWNER)
      await seed(dir, { "a.txt": "a\n" })
      await createIntent(dir, "Ship the parser")
      for (const name of ["a", "b", "c", "d", "e", "f"])
        await planAssignment(dir, `Build ${name}`, `src/${name}.ts`)
      // A git that records how many arguments each `add` got, then runs the real one.
      const bin = await scratch("holyagent-git-")
      const log = join(bin, "add-arguments")
      const real = Bun.which("git") ?? "git"
      await writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          `for argument in "$@"; do`,
          `  if [ "$argument" = add ]; then echo "$#" >> "${log}"; break; fi`,
          "done",
          `exec "${real}" "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      )

      const created = toon(
        await vcs(
          dir,
          ["assignment", "create"],
          fakeGitHub().layer,
          {
            roleTask: "Worker.implementation",
            objective: "Build g",
            criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
            evidence: ["tests"],
            ownershipPaths: ["src/g.ts"],
          },
          { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
        ),
      ) as { id: string }

      // The state holds eight records and the settings. None of their names is on the command line,
      // so the number of arguments does not depend on how many there are.
      const counts = lines(await readFile(log, "utf8")).map(Number)
      expect(counts.length).toBeGreaterThan(0)
      expect(Math.max(...counts)).toBeLessThanOrEqual(10)
      // The new record was still staged and committed.
      const tracked = lines(await sh(dir, ["git", "ls-tree", "-r", "--name-only", STATE]))
      expect(tracked.filter((path) => path.includes("/assignments/"))).toHaveLength(7)
      expect(tracked.some((path) => path.includes(created.id))).toBe(true)
      expect(await sh(await stateTree(dir), ["git", "status", "--porcelain"])).toBe("")
    },
  )
})

describe("migrating the legacy state", () => {
  test("every file migrate copied into an Intent folder is committed, a stray file beside them is not", async () => {
    const dir = await initRepo(OWNER)
    const folder = ".holyclaude/intents/take-over-legacy-state-intent-0mvp7hcqf-t7pm"
    await seed(dir, {
      "a.txt": "a\n",
      ".gitignore": "/.holyagent/\n",
      [`${folder}/intent.json`]: JSON.stringify({
        id: "intent-0mvp7hcqf-t7pm",
        objective: "Take over legacy state",
        requirements: "Convert it.",
        revision: 1,
      }),
      [`${folder}/resume-notes.md`]: "# Resume\n",
      [`${folder}/plan.toon`]: "plan: current\n",
      [`${folder}/plan.old-001.toon`]: "plan: old\n",
      [`${folder}/notes/design.md`]: "design\n",
      [`${folder}/notes/deep/more.md`]: "more\n",
      [`${folder}/notes/scratch.tmp`]: "temporary\n",
    })

    const done = toon(await holy(dir, ["migrate"])) as { migrated: boolean }
    expect(done.migrated).toBe(true)
    // A file that is neither a record, the settings nor a file migrate copied stays out of the commit.
    const state = join(await stateTree(dir), ".holyagent")
    const migrated = (await readdir(join(state, "intents")))[0] ?? ""
    await writeFile(join(state, "intents", migrated, "stray.md"), "stray\n")
    await createIntent(dir, "Ship the lexer")

    const tracked = lines(await sh(dir, ["git", "ls-tree", "-r", "--name-only", STATE]))
    const prefix = `.holyagent/intents/${migrated}/`
    const inside = tracked
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
    expect(inside.toSorted()).toEqual([
      "intent.json",
      "notes/deep/more.md",
      "notes/design.md",
      "plan.old-001.toon",
      "plan.toon",
      "resume-notes.md",
    ])
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
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
    await cp(join(plain, ".holyagent"), join(dir, ".holyagent"), { recursive: true })

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
    await cp(join(late.plain, ".holyagent"), join(dir, ".holyagent"), { recursive: true })
    const again = toon(await holy(dir, ["intent", "list"])) as { intents: Array<{ id: string }> }
    expect(again.intents.map((row) => row.id)).toEqual([id])
  })

  test("a new state worktree takes in the uncommitted state of every work tree of the clone", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const { plain, id } = await legacyState("Ship the parser")
    await cp(join(plain, ".holyagent"), join(dir, ".holyagent"), { recursive: true })
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
    await cp(join(plain, ".holyagent"), join(dir, ".holyagent"), { recursive: true })
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
    expect(await sh(dir, ["git", "status", "--porcelain"])).toContain(` M ${record}`)
    expect(JSON.parse(await readFile(join(dir, record), "utf8"))).toMatchObject({
      objective: "Ship the parser v2",
    })
    expect(JSON.parse(await sh(dir, ["git", "show", `${STATE}:${record}`]))).toMatchObject({
      objective: "Ship the parser v2",
    })
    expect(JSON.parse(await sh(dir, ["git", "show", `HEAD:${record}`]))).toMatchObject({
      objective: "Ship the parser",
    })
    expect((await stat(join(await stateTree(dir), record))).isFile()).toBe(true)
  })
})

describe("a lock file that Windows has not finished deleting", () => {
  /** Makes `open` of `file` for exclusive creation fail with EPERM while `blocked()` holds. */
  const refusing = (file: string, blocked: () => boolean) => {
    const original = filesystem.open
    return spyOn(filesystem, "open").mockImplementation(
      async (...args: Parameters<typeof filesystem.open>) => {
        if (args[0] === file && args[1] === "wx" && blocked())
          throw Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`), {
            code: "EPERM",
          })
        return original(...args)
      },
    )
  }

  test("a contender waits for it and takes the lock, as it does for a lock file that exists", async () => {
    const file = join(await scratch(), "worktree.lock")
    // The previous holder removed the lock while a contender still had it open: the file is gone for
    // good once that handle closes, and until then Windows refuses to create it with EPERM.
    await writeFile(
      file,
      JSON.stringify({ pid: process.pid, token: "held", acquiredAt: Date.now() }),
    )
    let pending = true
    const spy = refusing(file, () => pending)
    setTimeout(() => {
      pending = false
      void rm(file, { force: true })
    }, 150)
    try {
      const ran = await Effect.runPromise(withFileLock(file, Effect.succeed("ran"), "long"))

      expect(ran).toBe("ran")
    } finally {
      spy.mockRestore()
    }
  })

  test("a refusal with no file in the way is an I/O failure at once, not a wait", async () => {
    const file = join(await scratch(), "worktree.lock")
    const spy = refusing(file, () => true)
    const started = Date.now()
    try {
      const failure = await Effect.runPromise(
        Effect.flip(withFileLock(file, Effect.succeed("ran"), "long")),
      )

      expect(failure._tag).toBe("StateIo")
    } finally {
      spy.mockRestore()
    }
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe("breaking a stale lock", () => {
  test("a lock claimed after the stale check stays, on a file system without hard links", async () => {
    const file = join(await scratch(), "worktree.lock")
    const child = Bun.spawn([process.execPath, "-e", ""])
    await child.exited
    const gone = JSON.stringify({ pid: child.pid, token: "gone", acquiredAt: Date.now() - 60_000 })
    const live = JSON.stringify({ pid: process.pid, token: "live", acquiredAt: Date.now() })
    await writeFile(file, gone)
    // The contender has read the dead owner. Just before it first changes the lock file, another
    // process replaces the lock, as it could between the contender's read and its removal.
    let replaced = false
    const replacing = <A extends Array<unknown>, R>(original: (...args: A) => R) =>
      ((...args: A) => {
        if (!replaced && args[0] === file) {
          replaced = true
          writeFileSync(file, live)
        }
        return original(...args)
      }) as (...args: A) => R
    const [rename, remove] = [filesystem.rename, filesystem.rm]
    const renameSpy = spyOn(filesystem, "rename").mockImplementation(replacing(rename))
    const removeSpy = spyOn(filesystem, "rm").mockImplementation(replacing(remove))
    const linkSpy = spyOn(filesystem, "link").mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" }),
      ),
    )
    try {
      const failure = await Effect.runPromise(
        Effect.flip(
          deadlineIn(400).pipe(
            Effect.flatMap((deadline) => withFileLock(file, Effect.succeed("ran"), deadline)),
          ),
        ),
      )

      expect(failure._tag).toBe("StateLocked")
      expect(await readFile(file, "utf8")).toBe(live)
      expect((await readdir(join(file, ".."))).filter((name) => name.includes("stale"))).toEqual([])
    } finally {
      renameSpy.mockRestore()
      removeSpy.mockRestore()
      linkSpy.mockRestore()
    }
  })

  test("a lock created while a moved lock is put back is not overwritten", async () => {
    const file = join(await scratch(), "worktree.lock")
    const child = Bun.spawn([process.execPath, "-e", ""])
    await child.exited
    const owner = (token: string, pid: number) =>
      JSON.stringify({ pid, token, acquiredAt: Date.now() })
    const [gone, live, newer] = [
      owner("gone", child.pid),
      owner("live", process.pid),
      owner("newer", process.pid),
    ]
    await writeFile(file, gone)
    // The contender has read the dead owner. Just before it moves the lock file, another process
    // replaces the lock; then, just before the contender puts the moved lock back, a third process
    // creates a lock there, as it could in the gap after the contender found the place empty.
    let replaced = false
    const [rename, link] = [filesystem.rename, filesystem.link]
    const renameSpy = spyOn(filesystem, "rename").mockImplementation(
      (...args: Parameters<typeof rename>) => {
        if (!replaced && args[0] === file) {
          replaced = true
          writeFileSync(file, live)
        }
        if (args[1] === file) writeFileSync(file, newer)
        return rename(...args)
      },
    )
    const linkSpy = spyOn(filesystem, "link").mockImplementation(
      (...args: Parameters<typeof link>) => {
        if (args[1] === file) writeFileSync(file, newer)
        return link(...args)
      },
    )
    try {
      const failure = await Effect.runPromise(
        Effect.flip(
          deadlineIn(400).pipe(
            Effect.flatMap((deadline) => withFileLock(file, Effect.succeed("ran"), deadline)),
          ),
        ),
      )

      expect(failure._tag).toBe("StateLocked")
      expect(await readFile(file, "utf8")).toBe(newer)
      expect((await readdir(join(file, ".."))).filter((name) => name.includes("stale"))).toEqual([])
    } finally {
      renameSpy.mockRestore()
      linkSpy.mockRestore()
    }
  })

  test("a lock of a dead process is broken and taken", async () => {
    const file = join(await scratch(), "worktree.lock")
    const child = Bun.spawn([process.execPath, "-e", ""])
    await child.exited
    await writeFile(file, JSON.stringify({ pid: child.pid, token: "gone", acquiredAt: Date.now() }))

    const ran = await Effect.runPromise(withFileLock(file, Effect.succeed("ran")))

    expect(ran).toBe("ran")
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
    await put(tree, { ".holyagent/note.txt": "attacker\n" })

    const result = await holy(tree, ["intent", "list"])

    expect(result.code).toBe(4)
    expect(await Bun.file(victim).exists()).toBe(false)
  })

  test("migration does not write through a linked directory in the state worktree", async () => {
    const { tree, state } = await withLinked()
    const outside = await scratch("holyagent-outside-")
    await mkdir(join(outside, "shared"))
    await symlink(
      join(outside, "shared"),
      join(state, ".holyagent", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    )
    await put(tree, { ".holyagent/linked/p.txt": "attacker\n" })

    const result = await holy(tree, ["intent", "list"])

    expect(result.code).toBe(4)
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
    await symlink(
      outside,
      join(state, ".holyagent"),
      process.platform === "win32" ? "junction" : "dir",
    )
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
    await symlink(
      outside,
      join(tree, ".holyagent"),
      process.platform === "win32" ? "junction" : "dir",
    )

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
