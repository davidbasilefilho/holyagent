import { afterEach, describe, expect, test } from "bun:test"
import { chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { cleanup, fakeGitHub, initRepo, put, seed, sh, toon, vcs } from "./vcs-fixtures.ts"

afterEach(cleanup)

const OWNER = { name: "Octo", email: "42+octo@users.noreply.github.com" }

const github = () => fakeGitHub()

const filesOf = async (dir: string, rev = "HEAD") =>
  (await sh(dir, ["git", "show", "--name-only", "--format=", rev])).trim().split("\n").sort()

describe("vcs commit", () => {
  test("only the named paths are committed, with the configured git identity", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n", "b.txt": "b\n" })
    await put(dir, { "a.txt": "a2\n", "b.txt": "b2\n", "new.txt": "new\n" })

    const done = toon(
      await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt", "new.txt"], github().layer),
    )

    expect(done).toMatchObject({ branch: "main", files: 2 })
    expect(await filesOf(dir)).toEqual(["a.txt", "new.txt"])
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe(" M b.txt\n")
    expect((await sh(dir, ["git", "log", "-1", "--format=%an <%ae>|%cn <%ce>"])).trim()).toBe(
      "Octo <42+octo@users.noreply.github.com>|Octo <42+octo@users.noreply.github.com>",
    )
  })

  test("an identity that looks like an agent's is refused and nothing is committed", async () => {
    const dir = await initRepo({ name: "Claude", email: "noreply@anthropic.com" })
    await seed(dir, { "a.txt": "a\n" })
    await put(dir, { "a.txt": "a2\n" })
    const before = (await sh(dir, ["git", "rev-parse", "HEAD"])).trim()

    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Change a", "--", "a.txt"],
      github().layer,
    )

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: AgentIdentity")
    expect(result.stderr).toContain("git config user.name")
    expect((await sh(dir, ["git", "rev-parse", "HEAD"])).trim()).toBe(before)
  })

  test("Intent state never rides along: it is committed on the state branch, and the work commit holds only the named paths", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    expect(
      (await vcs(dir, ["intent", "create"], github().layer, { objective: "Ship the parser" })).code,
    ).toBe(0)
    await put(dir, { "a.txt": "a2\n" })

    const first = toon(
      await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"], github().layer),
    )

    expect(await filesOf(dir)).toEqual(["a.txt"])
    expect(first).not.toHaveProperty("state")
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
    expect(await sh(dir, ["git", "ls-files", ".holyagent"])).toBe("")
  })

  test("a path under .holyagent is refused, so a work branch never carries Intent state", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    await put(dir, { ".holyagent/intents/note.md": "note\n" })

    for (const path of [".holyagent", ".holyagent/intents/note.md", ".holyagent/"]) {
      const result = await vcs(dir, ["vcs", "commit", "-m", "Add note", "--", path], github().layer)
      expect([path, result.code]).toEqual([path, 2])
      expect(result.stderr).toContain("state branch")
    }
    expect(await sh(dir, ["git", "log", "--format=%s"])).toBe("seed\n")
  })

  test("changes staged outside the named paths refuse the commit and are left alone", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n", "b.txt": "b\n" })
    await put(dir, { "a.txt": "a2\n", "b.txt": "b2\n" })
    await sh(dir, ["git", "add", "b.txt"])
    const before = (await sh(dir, ["git", "rev-parse", "HEAD"])).trim()

    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Change a", "--", "a.txt"],
      github().layer,
    )

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: StagedOutsideScope")
    expect(result.stderr).toContain("b.txt")
    expect((await sh(dir, ["git", "rev-parse", "HEAD"])).trim()).toBe(before)
    expect(await sh(dir, ["git", "diff", "--cached", "--name-only"])).toBe("b.txt\n")
  })

  test("a rename staged outside the named paths refuses the commit, naming both sides", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n", "b.txt": "b\n" })
    await put(dir, { "a.txt": "a2\n" })
    await sh(dir, ["git", "mv", "b.txt", "c.txt"])

    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Change a", "--", "a.txt"],
      github().layer,
    )

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: StagedOutsideScope")
    expect(result.stderr).toContain("b.txt")
    expect(result.stderr).toContain("c.txt")
  })

  test("a human co-author stays in the commit and the agent's trailer does not", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    await put(dir, { "a.txt": "a2\n" })

    toon(
      await vcs(
        dir,
        [
          "vcs",
          "commit",
          "-m",
          "Change a",
          "-m",
          "Co-authored-by: Dana <dana@example.com>\nCo-Authored-By: Claude <noreply@anthropic.com>",
          "--",
          "a.txt",
        ],
        github().layer,
      ),
    )

    expect((await sh(dir, ["git", "log", "-1", "--format=%B"])).trim()).toBe(
      "Change a\n\nCo-authored-by: Dana <dana@example.com>",
    )
  })

  test("nothing changed in the named paths is refused", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "No change", "--", "a.txt"],
      github().layer,
    )
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: NothingToCommit")
  })

  test("paths outside the project and globs are usage errors", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n", "b.txt": "b\n" })
    await put(dir, { "a.txt": "a2\n", "b.txt": "b2\n" })
    expect(
      (await vcs(dir, ["vcs", "commit", "-m", "x", "--", "../a.txt"], github().layer)).code,
    ).toBe(2)
    const glob = await vcs(dir, ["vcs", "commit", "-m", "x", "--", "*.txt"], github().layer)
    expect(glob.code).toBe(2)
    expect(await sh(dir, ["git", "log", "--format=%s"])).toBe("seed\n")
  })

  test("the repository's own hooks run", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const hook = join(dir, ".git/hooks/pre-commit")
    await writeFile(hook, "#!/bin/sh\necho ran > hook-ran\n")
    await chmod(hook, 0o755)
    await put(dir, { "a.txt": "a2\n" })
    toon(await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"], github().layer))
    expect(await Bun.file(join(dir, "hook-ran")).text()).toBe("ran\n")
  })

  test("a commit-msg hook that refuses the message stops the commit", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const hook = join(dir, ".git/hooks/commit-msg")
    await writeFile(hook, "#!/bin/sh\necho 'no way' >&2\nexit 1\n")
    await chmod(hook, 0o755)
    await put(dir, { "a.txt": "a2\n" })
    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Change a", "--", "a.txt"],
      github().layer,
    )
    expect(result.code).toBe(4)
    expect(result.stderr).toContain("no way")
    expect(await sh(dir, ["git", "log", "--format=%s"])).toBe("seed\n")
  })
})

const CLAUDE = { name: "Claude", email: "noreply@anthropic.com" }
const CLOUD = { CLAUDE_CODE_REMOTE: "true" }
const USER_EMAIL = "39467981+octocat@users.noreply.github.com"

/** The head commit as `author|committer`. */
const whoOf = async (dir: string) =>
  (await sh(dir, ["git", "log", "-1", "--format=%an <%ae>|%cn <%ce>"])).trim()

/** A repository configured as a cloud session is: the committer identity is Claude's. */
const cloudRepo = async () => {
  const dir = await initRepo(CLAUDE)
  await seed(dir, { "a.txt": "a\n" })
  await put(dir, { "a.txt": "a2\n" })
  return dir
}

const commitA = (dir: string, env: Record<string, string>) =>
  vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"], github().layer, undefined, env)

describe("vcs identity", () => {
  test("writes exactly author.name and author.email to the local git config and no file of the tree", async () => {
    const dir = await cloudRepo()
    const before = await sh(dir, ["git", "config", "--local", "--list"])

    const done = toon(
      await vcs(
        dir,
        ["vcs", "identity", "--name", "Octo Cat", "--email", USER_EMAIL],
        github().layer,
        undefined,
        CLOUD,
      ),
    )

    expect(done.author).toBe(`Octo Cat <${USER_EMAIL}>`)
    const after = await sh(dir, ["git", "config", "--local", "--list"])
    expect(after.split("\n").filter((line) => !before.split("\n").includes(line))).toEqual([
      "author.name=Octo Cat",
      `author.email=${USER_EMAIL}`,
    ])
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe(" M a.txt\n")
    expect(await sh(dir, ["git", "ls-files"])).toBe("a.txt\n")
  })

  test("refuses an identity that looks like an agent's or is not a name and an address, writing nothing", async () => {
    const dir = await cloudRepo()
    const before = await sh(dir, ["git", "config", "--local", "--list"])
    const attempts = [
      ["--name", "Claude", "--email", USER_EMAIL],
      ["--name", "Octo", "--email", "noreply@anthropic.com"],
      ["--name", "Octo <x>", "--email", USER_EMAIL],
      ["--name", "Octo", "--email", "not-an-address"],
      ["--name", " ", "--email", USER_EMAIL],
    ]
    for (const flags of attempts) {
      const result = await vcs(dir, ["vcs", "identity", ...flags], github().layer)
      expect([flags, result.code]).toEqual([flags, 2])
    }
    for (const flags of [
      ["--name", "Octo"],
      ["--email", USER_EMAIL],
    ])
      expect((await vcs(dir, ["vcs", "identity", ...flags], github().layer)).code).toBe(2)
    expect(await sh(dir, ["git", "config", "--local", "--list"])).toBe(before)
  })
})

describe("vcs commit in a claude.ai cloud session", () => {
  test("the author is the user and the committer stays Claude", async () => {
    const dir = await cloudRepo()
    toon(
      await vcs(
        dir,
        ["vcs", "identity", "--name", "Octo Cat", "--email", USER_EMAIL],
        github().layer,
        undefined,
        CLOUD,
      ),
    )

    toon(await commitA(dir, CLOUD))

    expect(await whoOf(dir)).toBe(`Octo Cat <${USER_EMAIL}>|Claude <noreply@anthropic.com>`)
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
  })

  test("an author given by GIT_AUTHOR_* is accepted too", async () => {
    const dir = await cloudRepo()

    toon(
      await commitA(dir, {
        ...CLOUD,
        GIT_AUTHOR_NAME: "Octo Cat",
        GIT_AUTHOR_EMAIL: USER_EMAIL,
      }),
    )

    expect(await whoOf(dir)).toBe(`Octo Cat <${USER_EMAIL}>|Claude <noreply@anthropic.com>`)
  })

  test("a missing author is refused with the steps to set one, and nothing is committed", async () => {
    const dir = await cloudRepo()
    const before = (await sh(dir, ["git", "rev-parse", "HEAD"])).trim()

    const result = await commitA(dir, CLOUD)

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: CloudAuthor")
    expect(result.stderr).toContain("get_me")
    expect(result.stderr).toContain("holyagent vcs identity --name")
    expect((await sh(dir, ["git", "rev-parse", "HEAD"])).trim()).toBe(before)
  })

  test("an author that looks like an agent's is refused, whichever way it was set", async () => {
    const dir = await cloudRepo()
    const before = (await sh(dir, ["git", "rev-parse", "HEAD"])).trim()

    await sh(dir, ["git", "config", "author.name", "Claude"])
    await sh(dir, ["git", "config", "author.email", USER_EMAIL])
    expect((await commitA(dir, CLOUD)).stderr).toContain("error: CloudAuthor")

    await sh(dir, ["git", "config", "author.name", "Octo Cat"])
    await sh(dir, ["git", "config", "author.email", "noreply@anthropic.com"])
    expect((await commitA(dir, CLOUD)).code).toBe(3)

    await sh(dir, ["git", "config", "--unset", "author.name"])
    await sh(dir, ["git", "config", "--unset", "author.email"])
    const byEnv = await commitA(dir, { ...CLOUD, GIT_AUTHOR_NAME: "Claude Code" })
    expect(byEnv.code).toBe(3)
    expect((await sh(dir, ["git", "rev-parse", "HEAD"])).trim()).toBe(before)
  })
})

describe("vcs commit outside a claude.ai cloud session", () => {
  test("the author setting is ignored: an agent's user identity is still refused, and the user's is used", async () => {
    for (const env of [{}, { CLAUDE_CODE_REMOTE: "false" }, { CLAUDE_CODE_REMOTE: "1" }]) {
      const dir = await cloudRepo()
      await sh(dir, ["git", "config", "author.name", "Octo Cat"])
      await sh(dir, ["git", "config", "author.email", USER_EMAIL])
      const result = await commitA(dir, env)
      expect([env, result.code, result.stderr.includes("error: AgentIdentity")]).toEqual([
        env,
        3,
        true,
      ])
    }

    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    await put(dir, { "a.txt": "a2\n" })
    toon(await commitA(dir, {}))
    expect(await whoOf(dir)).toBe(`Octo <${OWNER.email}>|Octo <${OWNER.email}>`)
  })
})
