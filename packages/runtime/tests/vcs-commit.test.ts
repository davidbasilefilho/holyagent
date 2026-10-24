import { afterEach, describe, expect, test } from "bun:test"
import { chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  cleanup,
  failure,
  fakeGitHub,
  initRepo,
  put,
  seed,
  sh,
  toon,
  user,
  vcs,
} from "./vcs-fixtures.ts"

afterEach(cleanup)

const OWNER = { name: "Octo", email: "42+octo@users.noreply.github.com" }

/** GitHub where the credential owner is octo and GraphQL is available or blocked. */
const github = (graphql = true) =>
  fakeGitHub({
    rest: (request) => (request.path === "user" ? user() : undefined),
    graphql: () => (graphql ? { viewer: { login: "octo" } } : failure(403, "not available")),
  })

const filesOf = async (dir: string, rev = "HEAD") =>
  (await sh(dir, ["git", "show", "--name-only", "--format=", rev])).trim().split("\n").sort()

describe("commit on the git path", () => {
  test("only the named paths are committed", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n", "b.txt": "b\n" })
    await put(dir, { "a.txt": "a2\n", "b.txt": "b2\n", "new.txt": "new\n" })

    const done = toon(
      await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt", "new.txt"], github().layer),
    )

    expect(done).toMatchObject({ path: "git", branch: "main", files: 2 })
    expect(await filesOf(dir)).toEqual(["a.txt", "new.txt"])
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe(" M b.txt\n")
  })

  test("a changed Intent state folder rides along with the work commit", async () => {
    const dir = await initRepo(OWNER)
    await seed(dir, { "a.txt": "a\n" })
    const created = await vcs(dir, ["intent", "create"], github().layer, {
      objective: "Ship the parser",
    })
    expect(created.code).toBe(0)
    await put(dir, { "a.txt": "a2\n" })

    const first = toon(
      await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"], github().layer),
    )
    const files = await filesOf(dir)
    expect(files).toHaveLength(2)
    expect(files).toContain("a.txt")
    expect(files.find((file) => file !== "a.txt")).toMatch(
      /^\.holyagent\/intents\/ship-the-parser-[^/]+\/intent\.json$/,
    )
    expect(String(first["state"])).toMatch(/^\.holyagent\/intents\/ship-the-parser-/)

    await put(dir, { "a.txt": "a3\n" })
    const second = toon(
      await vcs(dir, ["vcs", "commit", "-m", "Change a again", "--", "a.txt"], github().layer),
    )
    expect(await filesOf(dir)).toEqual(["a.txt"])
    expect(second).not.toHaveProperty("state")
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
})

describe("commit on the git-owner path", () => {
  test("author and committer are the owner and the commit is unsigned even when signing is configured", async () => {
    const dir = await initRepo({ name: "Claude", email: "noreply@anthropic.com" })
    await seed(dir, { "a.txt": "a\n" })
    await sh(dir, ["git", "config", "commit.gpgsign", "true"])
    await sh(dir, ["git", "config", "gpg.program", "/nonexistent-gpg"])
    await put(dir, { "a.txt": "a2\n" })

    const done = toon(
      await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"], github(false).layer),
    )

    expect(done).toMatchObject({ path: "git-owner", signed: false })
    expect((await sh(dir, ["git", "log", "-1", "--format=%an <%ae>|%cn <%ce>|%G?"])).trim()).toBe(
      "Octo Cat <42+octo@users.noreply.github.com>|Octo Cat <42+octo@users.noreply.github.com>|N",
    )
  })
})
