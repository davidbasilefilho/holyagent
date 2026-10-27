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
