import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect } from "effect"

import { commitScope } from "../src/vcs/commit.ts"
import { cleanup, fakeGitHub, initRepo, put, scratch, seed, sh, toon, vcs } from "./vcs-fixtures.ts"

afterEach(cleanup)

const OWNER = { name: "Octo", email: "42+octo@users.noreply.github.com" }

const holy = (dir: string, argv: ReadonlyArray<string>, stdin?: unknown) =>
  vcs(dir, argv, fakeGitHub().layer, stdin)

const createIntent = async (dir: string) =>
  String(toon(await holy(dir, ["intent", "create"], { objective: "Ship the parser" })).id)

/** A seeded repository with the state mode set through the CLI. */
const repoIn = async (mode?: string) => {
  const dir = await initRepo(OWNER)
  await seed(dir, { "a.txt": "a\n" })
  if (mode !== undefined) toon(await holy(dir, ["state", "mode", mode]))
  return dir
}

const filesOf = async (dir: string, rev: string) =>
  (await sh(dir, ["git", "show", "--name-only", "--format=", rev])).split("\n").filter(Boolean)

const stateFolder = (dir: string) => readdir(join(dir, ".holyagent")).catch(() => [])

const excludeFile = async (dir: string) =>
  readFile(join(dir, ".git", "info", "exclude"), "utf8").catch(() => "")

describe("the state mode command", () => {
  test("a clone with no mode set is in branch mode and keeps its state on the state branch", async () => {
    const dir = await repoIn()

    expect(toon(await holy(dir, ["state", "mode"]))).toMatchObject({
      mode: "branch",
      configured: false,
    })
    await createIntent(dir)

    expect(await sh(dir, ["git", "branch", "--list", "holyagent/state"])).not.toBe("")
    expect(await stateFolder(dir)).toEqual([])
  })

  test("setting a mode stores it in git config and reads back, and an unknown mode is a usage error", async () => {
    const dir = await repoIn()

    const set = toon(await holy(dir, ["state", "mode", "work"]))
    expect(set).toMatchObject({ mode: "work", previous: "branch", configured: true })
    expect(String(set["directory"])).toEndWith(join(".holyagent"))
    expect((await sh(dir, ["git", "config", "--local", "holyagent.stateMode"])).trim()).toBe("work")
    expect(toon(await holy(dir, ["state", "mode"]))).toMatchObject({ mode: "work" })

    const unknown = await holy(dir, ["state", "mode", "everywhere"])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain("holyagent state mode [branch|work|local]")
    const outside = await holy(await scratch(), ["state", "mode"])
    expect(outside.code).toBe(4)
    expect(outside.stderr).toContain("not a git repository")
  })

  test("a mode written in a repository file is not read", async () => {
    const dir = await repoIn()
    await put(dir, { ".holyagent/config.json": JSON.stringify({ vcs: { stateMode: "work" } }) })

    expect(toon(await holy(dir, ["state", "mode"]))).toMatchObject({ mode: "branch" })
  })

  test("a value of the git config that is not a mode fails the commands that use the state", async () => {
    const dir = await repoIn()
    await sh(dir, ["git", "config", "holyagent.stateMode", "bogus"])

    const result = await holy(dir, ["intent", "list"])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain("holyagent.stateMode")
  })
})

describe("the work mode", () => {
  test("state is kept in the work tree, no state branch is made and no transition is committed", async () => {
    const dir = await repoIn("work")
    const intent = await createIntent(dir)

    expect(await stateFolder(dir)).toContain("intents")
    expect(await sh(dir, ["git", "branch", "--list", "holyagent/*"])).toBe("")
    expect(await sh(dir, ["git", "worktree", "list"])).not.toContain("holyagent/")
    expect(await sh(dir, ["git", "log", "--format=%s"])).toBe("seed\n")
    expect(toon(await holy(dir, ["intent", "show", intent]))).toMatchObject({ id: intent })
  })

  test("vcs commit stages the changed state files with the work, and never the per-clone ones", async () => {
    const dir = await repoIn("work")
    const intent = await createIntent(dir)
    await put(dir, { "a.txt": "a2\n" })

    toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))

    const files = await filesOf(dir, "HEAD")
    expect(files).toContain("a.txt")
    expect(files.some((file) => file.includes(`${intent}/intent.json`))).toBe(true)
    expect(files.some((file) => file.startsWith(".holyagent/local/"))).toBe(false)
    // Recording the commit on the Intent changes state again; that change waits for the next commit.
    expect(await sh(dir, ["git", "status", "--porcelain"])).toContain(".holyagent")
  })

  test("a work commit with no state change holds only the named paths, and the state folder may be named", async () => {
    const dir = await repoIn("work")
    await put(dir, { "a.txt": "a2\n" })
    toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))
    expect(await filesOf(dir, "HEAD")).toEqual(["a.txt"])

    await createIntent(dir)
    await put(dir, { "a.txt": "a3\n" })
    toon(await holy(dir, ["vcs", "commit", "-m", "Change a again", "--", "a.txt", ".holyagent"]))
    expect((await filesOf(dir, "HEAD")).some((file) => file.startsWith(".holyagent/"))).toBe(true)
  })

  test("a state commit is never made on a branch that happens to be named like the state branch", async () => {
    const dir = await repoIn("work")
    await sh(dir, ["git", "switch", "-q", "-c", "holyagent/state"])

    await createIntent(dir)

    expect(await sh(dir, ["git", "log", "--format=%s"])).toBe("seed\n")
  })
})

describe("the local mode", () => {
  test("state is kept in the work tree and out of git through .git/info/exclude, not .gitignore", async () => {
    const dir = await repoIn("local")
    await createIntent(dir)

    expect(await excludeFile(dir)).toContain("/.holyagent/")
    expect(await Bun.file(join(dir, ".gitignore")).exists()).toBe(false)
    expect(await stateFolder(dir)).toContain("intents")
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
    expect(await sh(dir, ["git", "branch", "--list", "holyagent/*"])).toBe("")
    expect(await sh(dir, ["git", "log", "--format=%s"])).toBe("seed\n")
  })

  test("a work commit holds only the named paths, and a path under .holyagent is refused", async () => {
    const dir = await repoIn("local")
    await createIntent(dir)
    await put(dir, { "a.txt": "a2\n" })

    toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))
    expect(await filesOf(dir, "HEAD")).toEqual(["a.txt"])

    const refused = await holy(dir, ["vcs", "commit", "-m", "State", "--", ".holyagent"])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("state mode local")
    expect(await sh(dir, ["git", "log", "--format=%s"])).toBe("Change a\nseed\n")
  })

  test("the exclude entry is made once, shared by linked worktrees, and removed by another mode", async () => {
    const dir = await repoIn("local")
    toon(await holy(dir, ["state", "mode", "local"]))
    await createIntent(dir)

    expect((await excludeFile(dir)).match(/\/\.holyagent\//g)).toHaveLength(1)
    toon(await holy(dir, ["state", "mode", "work"]))
    expect(await excludeFile(dir)).not.toContain(".holyagent")
  })
})

describe("the branch mode refuses state paths", () => {
  test("a path under .holyagent is refused and says the state branch holds it", async () => {
    const dir = await repoIn("branch")
    await put(dir, { ".holyagent/intents/note.md": "note\n" })

    const result = await holy(dir, ["vcs", "commit", "-m", "Note", "--", ".holyagent"])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain("state branch")
  })
})

describe("changing the mode of a clone that has records", () => {
  test("a clone with a state branch stays in branch mode", async () => {
    const dir = await repoIn()
    await createIntent(dir)

    const result = await holy(dir, ["state", "mode", "work"])

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("StateModeRefused")
    expect(toon(await holy(dir, ["state", "mode"]))).toMatchObject({ mode: "branch" })
  })

  test("records in the work tree cannot be moved onto the state branch", async () => {
    const dir = await repoIn("work")
    await createIntent(dir)

    const result = await holy(dir, ["state", "mode", "branch"])

    expect(result.code).toBe(3)
    expect(toon(await holy(dir, ["state", "mode"]))).toMatchObject({ mode: "work" })
  })

  test("a repository that tracks .holyagent can use the work mode but not the local one", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, {
      "a.txt": "a\n",
      ".holyagent/config.json": "{}\n",
      ".holyagent/note.md": "x\n",
    })

    const local = await holy(dir, ["state", "mode", "local"])
    expect(local.code).toBe(3)
    expect(local.stderr).toContain("work mode")
    expect(await excludeFile(dir)).not.toContain(".holyagent")

    expect(toon(await holy(dir, ["state", "mode", "work"]))).toMatchObject({ mode: "work" })
  })

  test("work and local switch freely and keep the records where they are", async () => {
    const dir = await repoIn("local")
    const intent = await createIntent(dir)

    toon(await holy(dir, ["state", "mode", "work"]))
    expect(toon(await holy(dir, ["intent", "show", intent]))).toMatchObject({ id: intent })
    toon(await holy(dir, ["state", "mode", "local"]))
    expect(toon(await holy(dir, ["intent", "show", intent]))).toMatchObject({ id: intent })
  })
})

describe("a repository that tracks only the project's config.json", () => {
  const configOnly = async (mode?: string) => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n", ".holyagent/config.json": "{}\n" })
    if (mode !== undefined) toon(await holy(dir, ["state", "mode", mode]))
    return dir
  }

  test("is not tracked state, so the local mode is allowed and hides the records", async () => {
    const dir = await configOnly("local")
    await createIntent(dir)

    expect(await excludeFile(dir)).toContain("/.holyagent/")
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
    await put(dir, { "a.txt": "a2\n" })
    toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))
    expect(await filesOf(dir, "HEAD")).toEqual(["a.txt"])
  })

  test("work mode stages the records but not a config change nobody named", async () => {
    const dir = await configOnly("work")
    const intent = await createIntent(dir)
    await put(dir, { "a.txt": "a2\n", ".holyagent/config.json": '{"vcs":{"allowWords":["x"]}}\n' })

    toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))

    const files = await filesOf(dir, "HEAD")
    expect(files.some((file) => file.includes(`${intent}/intent.json`))).toBe(true)
    expect(files).not.toContain(".holyagent/config.json")
    expect(await sh(dir, ["git", "status", "--porcelain"])).toContain(".holyagent/config.json")
  })

  test("work mode never stages an untracked config.json either, but stages it when named", async () => {
    const dir = await repoIn("work")
    await createIntent(dir)
    await put(dir, { "a.txt": "a2\n", ".holyagent/config.json": "{}\n" })

    toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))
    expect(await filesOf(dir, "HEAD")).not.toContain(".holyagent/config.json")

    await put(dir, { "a.txt": "a3\n" })
    toon(
      await holy(dir, [
        "vcs",
        "commit",
        "-m",
        "Change a again",
        "--",
        "a.txt",
        ".holyagent/config.json",
      ]),
    )
    expect(await filesOf(dir, "HEAD")).toContain(".holyagent/config.json")
  })
})

describe("local mode and files that git tracks under .holyagent", () => {
  const trackedNote = async () => {
    const dir = await repoIn("local")
    await put(dir, { ".holyagent/note.md": "x\n", "a.txt": "a2\n" })
    await sh(dir, ["git", "add", "-f", ".holyagent/note.md"])
    await sh(dir, ["git", "commit", "-q", "-m", "track"])
    return dir
  }

  test("vcs commit is refused while the staged set holds state git tracks", async () => {
    const dir = await trackedNote()
    await put(dir, { ".holyagent/note.md": "y\n", "a.txt": "a3\n" })
    await sh(dir, ["git", "add", "-f", ".holyagent/note.md"])

    const result = await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain("files under .holyagent/ are staged")
    expect(result.stderr).not.toContain("git tracks")
    expect(await sh(dir, ["git", "log", "--format=%s"])).toBe("track\nseed\n")
  })

  test("vcs commit is not refused when the staged set touches none of the state git tracks", async () => {
    const dir = await trackedNote()
    await put(dir, { ".holyagent/note.md": "y\n", "a.txt": "a3\n" })

    toon(await holy(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"]))

    expect(await filesOf(dir, "HEAD")).toEqual(["a.txt"])
  })

  test("outside the work mode a path under .holyagent is refused in any letter case, whatever core.ignorecase says", async () => {
    for (const mode of ["local", "branch"] as const)
      for (const ignoreCase of [true, false])
        for (const path of [".HolyAgent/x", ".HOLYAGENT"]) {
          const failure = await Effect.runPromise(
            Effect.flip(commitScope([path], "/", mode, ignoreCase)),
          )
          expect(failure.message).toContain("Intent state")
        }
  })

  test("the commit refuses a differently cased state folder even when core.ignorecase is off", async () => {
    const dir = await repoIn("local")
    await put(dir, { ".HolyAgent/x": "x\n" })
    await sh(dir, ["git", "config", "core.ignorecase", "false"])

    const refused = await holy(dir, ["vcs", "commit", "-m", "State", "--", ".HolyAgent/x"])

    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("Intent state")
  })

  test("the short name of the state folder is refused in every mode, in any case", async () => {
    for (const mode of ["local", "branch", "work"] as const)
      for (const path of ["HOLYAG~1", "holyag~1/x", "HolyAg~12/a/b"]) {
        const failure = await Effect.runPromise(Effect.flip(commitScope([path], "/", mode, true)))
        expect(failure.message).toContain("short name")
      }
    expect(await Effect.runPromise(commitScope(["src/HOLYAG~1"], "/", "local"))).toEqual([
      "src/HOLYAG~1",
    ])
  })

  test("in the work mode a staged path in another case is in scope when core.ignorecase is on", async () => {
    const dir = await repoIn("work")
    await createIntent(dir)
    await sh(dir, ["git", "config", "core.ignorecase", "false"])
    await put(dir, { ".HolyAgent/x": "x\n", "a.txt": "a2\n" })
    await sh(dir, ["git", "add", ".HolyAgent/x"])
    await sh(dir, ["git", "config", "core.ignorecase", "true"])

    toon(await holy(dir, ["vcs", "commit", "-m", "All state", "--", "a.txt", ".holyagent"]))

    expect(await filesOf(dir, "HEAD")).toContain(".HolyAgent/x")
  })

  test("in the work mode the state folder named in another case is the whole folder", async () => {
    expect(await Effect.runPromise(commitScope([".HolyAgent"], "/", "work", true))).toEqual([
      ".holyagent",
    ])
    expect(await Effect.runPromise(commitScope([".HolyAgent/a"], "/", "work", true))).toEqual([
      ".holyagent/a",
    ])
    expect(await Effect.runPromise(commitScope([".HolyAgent"], "/", "work", false))).toEqual([
      ".HolyAgent",
    ])

    const dir = await repoIn("work")
    await createIntent(dir)
    await sh(dir, ["git", "config", "core.ignorecase", "true"])
    await put(dir, { "a.txt": "a2\n", ".holyagent/config.json": "{}\n" })

    toon(await holy(dir, ["vcs", "commit", "-m", "All state", "--", "a.txt", ".HolyAgent"]))

    expect(await filesOf(dir, "HEAD")).toContain(".holyagent/config.json")
  })
})

describe("the exclude file", () => {
  test("a line the user wrote stays through every mode change, and none is added twice", async () => {
    const dir = await repoIn()
    await mkdir(join(dir, ".git", "info"), { recursive: true })
    await writeFile(join(dir, ".git", "info", "exclude"), "# mine\n/.holyagent/\n")

    for (const mode of ["local", "work", "local", "work"])
      toon(await holy(dir, ["state", "mode", mode]))

    expect(await excludeFile(dir)).toBe("# mine\n/.holyagent/\n")
  })

  test("only the line holyagent added is removed, the rest of the file is kept, and no temporary file stays", async () => {
    const dir = await repoIn()
    await mkdir(join(dir, ".git", "info"), { recursive: true })
    await writeFile(join(dir, ".git", "info", "exclude"), "*.log\n")

    toon(await holy(dir, ["state", "mode", "local"]))
    expect(await excludeFile(dir)).toContain("*.log\n")
    expect(await excludeFile(dir)).toContain("/.holyagent/")
    toon(await holy(dir, ["state", "mode", "work"]))

    expect(await excludeFile(dir)).toBe("*.log\n")
    expect(await readdir(join(dir, ".git", "info"))).toEqual(["exclude"])
  })

  test("entering local writes the exclude entry first: a failure leaves the mode unchanged", async () => {
    const dir = await repoIn()
    await rm(join(dir, ".git", "info", "exclude"), { force: true, recursive: true })
    await mkdir(join(dir, ".git", "info", "exclude"), { recursive: true })

    const result = await holy(dir, ["state", "mode", "local"])

    expect(result.code).not.toBe(0)
    expect(toon(await holy(dir, ["state", "mode"]))).toMatchObject({ mode: "branch" })
  })
})

describe("the exclude file edge cases", () => {
  const MARK = "# added by holyagent (state mode local)"
  const writeExclude = async (dir: string, text: string) => {
    await mkdir(join(dir, ".git", "info"), { recursive: true })
    await writeFile(join(dir, ".git", "info", "exclude"), text)
  }
  const holdExcludeLock = async (dir: string) => {
    const lock = join(dir, ".git", "holyagent", "exclude.lock")
    await mkdir(join(dir, ".git", "holyagent"), { recursive: true })
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "held", acquiredAt: 0 }))
    return lock
  }

  test("an unmarked line is never removed: not one found in local, and not one added after entering it", async () => {
    const dir = await repoIn()
    await writeExclude(dir, "*.log\n/.holyagent/\n")
    await sh(dir, ["git", "config", "holyagent.stateMode", "local"])
    await createIntent(dir)

    toon(await holy(dir, ["state", "mode", "work"]))
    expect(await excludeFile(dir)).toBe("*.log\n/.holyagent/\n")

    await writeExclude(dir, "")
    toon(await holy(dir, ["state", "mode", "local"]))
    await writeExclude(dir, "*.log\n/.holyagent/\n")
    toon(await holy(dir, ["state", "mode", "work"]))
    expect(await excludeFile(dir)).toBe("*.log\n/.holyagent/\n")
  })

  test("a leading space makes another pattern: the entry is added and only it is removed", async () => {
    const dir = await repoIn()
    await writeExclude(dir, " /.holyagent/\n")

    toon(await holy(dir, ["state", "mode", "local"]))

    expect(await excludeFile(dir)).toBe(` /.holyagent/\n${MARK}\n/.holyagent/\n`)
    await put(dir, { ".holyagent/x": "x\n" })
    expect(await sh(dir, ["git", "status", "--porcelain", "--", ".holyagent"])).toBe("")
    toon(await holy(dir, ["state", "mode", "work"]))
    expect(await excludeFile(dir)).toBe(" /.holyagent/\n")
  })

  test("a line with trailing whitespace or a carriage return still counts as the entry", async () => {
    const dir = await repoIn()
    await writeExclude(dir, "/.holyagent/ \r\n")

    toon(await holy(dir, ["state", "mode", "local"]))
    toon(await holy(dir, ["state", "mode", "work"]))

    expect(await excludeFile(dir)).toBe("/.holyagent/ \r\n")
  })

  // The exclude file read fine, but the temporary file next to it has a name too long to create,
  // so the removal of the entry fails after the mode was written.
  const withUnwritableExclude = async (dir: string, text: string) => {
    const folder = await scratch()
    const exclude = join(dir, ".git", "info", "exclude")
    await rm(exclude, { force: true })
    await writeFile(join(folder, "e".repeat(230)), text)
    await symlink(join(folder, "e".repeat(230)), exclude)
  }

  test("a failure after the mode was written leaves the clone in the mode it was in", async () => {
    const dir = await repoIn("local")
    await withUnwritableExclude(dir, `${MARK}\n/.holyagent/\n`)

    const result = await holy(dir, ["state", "mode", "work"])

    expect(result.code).not.toBe(0)
    expect(toon(await holy(dir, ["state", "mode"]))).toMatchObject({
      mode: "local",
      configured: true,
    })
  })

  test("a failed leave of a clone with no mode configured leaves it unconfigured", async () => {
    const dir = await repoIn()
    await withUnwritableExclude(dir, `*.log\n${MARK}\n`)

    const result = await holy(dir, ["state", "mode", "work"])

    expect(result.code).not.toBe(0)
    expect(toon(await holy(dir, ["state", "mode"]))).toMatchObject({
      mode: "branch",
      configured: false,
    })
  })

  test("the exclude edit waits as long as the worktree lock for a command that holds the lock", async () => {
    const dir = await repoIn()
    const lock = await holdExcludeLock(dir)

    const change = holy(dir, ["state", "mode", "local"])
    await Bun.sleep(2500)
    await rm(lock)

    expect(toon(await change)).toMatchObject({ mode: "local" })
    expect(await excludeFile(dir)).toContain("/.holyagent/")
  })

  test("a line the user had before local stays when the clone leaves it, and a line from branch stays", async () => {
    const dir = await repoIn()
    await writeExclude(dir, "/.holyagent/\n")

    toon(await holy(dir, ["state", "mode", "work"]))
    expect(await excludeFile(dir)).toBe("/.holyagent/\n")
    toon(await holy(dir, ["state", "mode", "local"]))
    toon(await holy(dir, ["state", "mode", "local"]))
    toon(await holy(dir, ["state", "mode", "branch"]))

    expect(await excludeFile(dir)).toBe("/.holyagent/\n")
  })

  test("a marker comment whose line was deleted gets the line back instead of a second pair", async () => {
    const dir = await repoIn()
    await writeExclude(dir, `*.log\n${MARK}\n*.tmp\n`)

    toon(await holy(dir, ["state", "mode", "local"]))

    expect(await excludeFile(dir)).toBe(`*.log\n${MARK}\n/.holyagent/\n*.tmp\n`)
    toon(await holy(dir, ["state", "mode", "work"]))
    expect(await excludeFile(dir)).toBe("*.log\n*.tmp\n")
  })

  test("a stray marker comment goes when the clone leaves local", async () => {
    const dir = await repoIn()
    toon(await holy(dir, ["state", "mode", "local"]))
    await writeExclude(dir, `*.log\n${MARK}\n`)

    toon(await holy(dir, ["state", "mode", "work"]))

    expect(await excludeFile(dir)).toBe("*.log\n")
  })

  test("editing the exclude file waits for the lock another command holds", async () => {
    const dir = await repoIn()
    const lock = await holdExcludeLock(dir)

    let finished = false
    const change = holy(dir, ["state", "mode", "local"]).then((result) => {
      finished = true
      return result
    })
    await Bun.sleep(300)
    expect(finished).toBe(false)
    await rm(lock)

    expect(toon(await change)).toMatchObject({ mode: "local" })
    expect(await excludeFile(dir)).toContain("/.holyagent/")
  })

  test("a command that waited for the lock does not bring the entry back after the mode left local", async () => {
    const dir = await repoIn("local")
    await writeExclude(dir, "")
    const lock = await holdExcludeLock(dir)

    const created = holy(dir, ["intent", "create"], { objective: "Ship the parser" })
    await Bun.sleep(300)
    await sh(dir, ["git", "config", "holyagent.stateMode", "work"])
    await rm(lock)

    expect((await created).code).toBe(0)
    expect(await excludeFile(dir)).toBe("")
  })

  test("a failed mode write takes the entry it was preceded by out again", async () => {
    const dir = await repoIn()
    await writeExclude(dir, "*.log\n")
    await writeFile(join(dir, ".git", "config.lock"), "")

    const result = await holy(dir, ["state", "mode", "local"])

    expect(result.code).not.toBe(0)
    expect(await excludeFile(dir)).toBe("*.log\n")
    await rm(join(dir, ".git", "config.lock"))
    expect(toon(await holy(dir, ["state", "mode"]))).toMatchObject({ mode: "branch" })
  })

  test("a symbolic link at the exclude file is kept and the file it names is edited", async () => {
    const dir = await repoIn()
    const target = join(await scratch(), "shared-exclude")
    await writeFile(target, "*.log\n")
    await mkdir(join(dir, ".git", "info"), { recursive: true })
    await rm(join(dir, ".git", "info", "exclude"), { force: true })
    await symlink(target, join(dir, ".git", "info", "exclude"))

    toon(await holy(dir, ["state", "mode", "local"]))

    expect((await lstat(join(dir, ".git", "info", "exclude"))).isSymbolicLink()).toBe(true)
    expect(await readFile(target, "utf8")).toContain("/.holyagent/")
    toon(await holy(dir, ["state", "mode", "work"]))
    expect(await readFile(target, "utf8")).toBe("*.log\n")
  })
})

describe("changing the mode across work trees and under the lock", () => {
  test("records in another linked work tree stop a move onto the state branch", async () => {
    const dir = await repoIn("work")
    await createIntent(dir)
    const other = join(await scratch(), "linked")
    await sh(dir, ["git", "worktree", "add", "-q", "-b", "other", other])

    const result = await holy(other, ["state", "mode", "branch"])

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("StateModeRefused")
    expect(toon(await holy(dir, ["state", "mode"]))).toMatchObject({ mode: "work" })
    expect(await sh(dir, ["git", "branch", "--list", "holyagent/*"])).toBe("")
  })

  const holdLock = async (dir: string) => {
    const lock = join(dir, ".git", "holyagent", "worktree.lock")
    await mkdir(join(dir, ".git", "holyagent"), { recursive: true })
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "held", acquiredAt: 0 }))
    return lock
  }

  test("a mode change waits for the command that holds the worktree lock", async () => {
    const dir = await repoIn()
    const lock = await holdLock(dir)

    let finished = false
    const change = holy(dir, ["state", "mode", "work"]).then((result) => {
      finished = true
      return result
    })
    await Bun.sleep(300)
    expect(finished).toBe(false)
    await rm(lock)

    expect(toon(await change)).toMatchObject({ mode: "work" })
  })

  test("a command that waited for the lock makes no state branch once the mode changed", async () => {
    const dir = await repoIn()
    const lock = await holdLock(dir)

    const created = holy(dir, ["intent", "create"], { objective: "Ship the parser" })
    await Bun.sleep(300)
    await sh(dir, ["git", "config", "holyagent.stateMode", "work"])
    await rm(lock)

    expect((await created).code).toBe(0)
    expect(await sh(dir, ["git", "branch", "--list", "holyagent/*"])).toBe("")
    expect(await stateFolder(dir)).toContain("intents")
  })
})

describe("the help of vcs commit", () => {
  test("describes the commit by state mode", async () => {
    const help = await holy(await repoIn(), ["vcs", "commit", "--help"])

    expect(help.stdout).toContain("state mode")
    expect(help.stdout).not.toContain("never part of the commit")
  })
})
