import { afterEach, describe, expect, test } from "bun:test"
import { chmod, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { MAX_BODY_BYTES } from "../src/vcs/pr.ts"
import {
  bareBackedGitHub,
  cleanup,
  commitView,
  connect,
  failure,
  fakeGitHub,
  headOf,
  initBare,
  initRepo,
  put,
  readVcs,
  scratch,
  seed,
  sh,
  toon,
  user,
  vcs,
} from "./vcs-fixtures.ts"

afterEach(cleanup)

const OWNER = { name: "Octo", email: "42+octo@users.noreply.github.com" }
const AGENT = { name: "Claude", email: "noreply@anthropic.com" }

/**
 * The owner's own clone of a bare "GitHub" whose main is already pushed; GitHub is faked on top of
 * the bare repo.
 */
const owned = async (identity = OWNER) => {
  const bare = await initBare()
  const dir = await initRepo(identity)
  await connect(dir, bare)
  await seed(dir, { "a.txt": "a\n" })
  await sh(dir, ["git", "push", "-q", "-u", "origin", "main"])
  return { bare, dir }
}

const countPushes = async (dir: string) => {
  const hook = join(dir, ".git/hooks/pre-push")
  await writeFile(hook, `#!/bin/sh\necho "$@" >> "${join(dir, "pushes")}"\n`)
  await chmod(hook, 0o755)
  return async () =>
    (await Bun.file(join(dir, "pushes")).exists())
      ? (await Bun.file(join(dir, "pushes")).text()).trim().split("\n").length
      : 0
}

describe("vcs push", () => {
  test("all named branches go in one git push and the current branch is the default", async () => {
    const { bare, dir } = await owned()
    const pushes = await countPushes(dir)
    await sh(dir, ["git", "branch", "one"])
    await sh(dir, ["git", "branch", "two"])
    const gh = bareBackedGitHub(bare)

    const several = toon(await vcs(dir, ["vcs", "push", "one", "two"], gh.layer))
    expect(several).toMatchObject({ path: "git", pushed: true })
    expect(await pushes()).toBe(1)
    expect(await headOf(bare, "one")).toBe(await headOf(dir, "one"))
    expect(await headOf(bare, "two")).toBe(await headOf(dir, "two"))

    await put(dir, { "a.txt": "a2\n" })
    await sh(dir, ["git", "commit", "-q", "-am", "next"])
    toon(await vcs(dir, ["vcs", "push"], gh.layer))
    expect(await headOf(bare, "main")).toBe(await headOf(dir))
  })

  test("a push that is not a fast-forward fails and the remote keeps its commits", async () => {
    const { bare, dir } = await owned()
    const other = await initRepo(OWNER)
    await sh(other, ["git", "remote", "add", "origin", bare])
    await sh(other, ["git", "pull", "-q", "origin", "main"])
    const theirs = await seed(other, { "x.txt": "x\n" })
    await sh(other, ["git", "push", "-q", "origin", "main"])
    await put(dir, { "a.txt": "mine\n" })
    await sh(dir, ["git", "commit", "-q", "-am", "mine"])

    const result = await vcs(dir, ["vcs", "push"], bareBackedGitHub(bare).layer)

    expect(result.code).toBe(4)
    expect(result.stderr).toContain("GitFailed")
    expect(await headOf(bare, "main")).toBe(theirs)
  })

  test.each([["+main"], ["--force"], ["--force-with-lease"], ["-f"], ["main:main"]])(
    "%s cannot make the push a forced one",
    async (argument) => {
      const { bare, dir } = await owned()
      const before = await headOf(bare, "main")
      await put(dir, { "a.txt": "a2\n" })
      await sh(dir, ["git", "commit", "-q", "-am", "next"])

      const result = await vcs(dir, ["vcs", "push", argument], bareBackedGitHub(bare).layer)

      expect(result.code).toBe(2)
      expect(await headOf(bare, "main")).toBe(before)
    },
  )

  test("on the api path push changes nothing and reports the heads on GitHub", async () => {
    const { bare, dir } = await owned(AGENT)
    const gh = bareBackedGitHub(bare)
    await put(dir, { "a.txt": "changed\n" })
    toon(await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"], gh.layer))
    const remote = await headOf(bare, "main")

    const pushed = toon(await vcs(dir, ["vcs", "push"], gh.layer))

    expect(pushed).toMatchObject({
      path: "api",
      pushed: false,
      heads: [`main=${remote?.slice(0, 7)}`],
    })
    expect(await headOf(bare, "main")).toBe(remote)
  })

  test("the first git commit is read back from GitHub once it is pushed", async () => {
    const { bare, dir } = await owned()
    const gh = bareBackedGitHub(bare, () => commitView({ verified: false }))
    await put(dir, { "a.txt": "a2\n" })
    toon(await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"], gh.layer))
    expect(gh.routes().filter((route) => route.includes("/commits/"))).toHaveLength(0)

    toon(await vcs(dir, ["vcs", "push"], gh.layer))
    const read = gh.routes().filter((route) => route.includes("/commits/"))
    expect(read).toHaveLength(1)
    expect(read[0]).toContain(await headOf(dir))

    await put(dir, { "a.txt": "a3\n" })
    toon(await vcs(dir, ["vcs", "commit", "-m", "Again", "--", "a.txt"], gh.layer))
    toon(await vcs(dir, ["vcs", "push"], gh.layer))
    expect(gh.routes().filter((route) => route.includes("/commits/"))).toHaveLength(1)
  })

  test("a read-back that cannot reach GitHub is a note, not a failure, and is tried again later", async () => {
    const { bare, dir } = await owned()
    let readable = false
    const gh = bareBackedGitHub(bare, () =>
      readable ? commitView({ verified: false }) : failure(403, "no access"),
    )
    await put(dir, { "a.txt": "a2\n" })
    toon(await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"], gh.layer))

    const first = toon(await vcs(dir, ["vcs", "push"], gh.layer))
    expect(String(first["note"])).toContain("no access")
    expect((await readVcs(dir)).detection?.verified).toBe(false)

    readable = true
    await put(dir, { "a.txt": "a3\n" })
    toon(await vcs(dir, ["vcs", "commit", "-m", "Again", "--", "a.txt"], gh.layer))
    const second = toon(await vcs(dir, ["vcs", "push"], gh.layer))
    expect(second).not.toHaveProperty("note")
    expect((await readVcs(dir)).detection?.verified).toBe(true)
  })

  test("a pushed commit with another author on GitHub stops with exit 3", async () => {
    const { bare, dir } = await owned()
    const gh = bareBackedGitHub(bare, () => commitView({ login: null }))
    await put(dir, { "a.txt": "a2\n" })
    toon(await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"], gh.layer))

    const result = await vcs(dir, ["vcs", "push"], gh.layer)

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: VerificationMismatch")
  })
})

describe("vcs branch", () => {
  test("on a git path the branch is local until pushed", async () => {
    const { bare, dir } = await owned()
    const gh = bareBackedGitHub(bare)

    const made = toon(await vcs(dir, ["vcs", "branch", "feature/x", "--from", "main"], gh.layer))

    expect(made).toMatchObject({ branch: "feature/x", remote: false })
    expect((await sh(dir, ["git", "branch", "--show-current"])).trim()).toBe("feature/x")
    expect(await headOf(bare, "feature/x")).toBeUndefined()
    expect(gh.routes().some((route) => route.startsWith("POST"))).toBe(false)
  })

  test("on the api path the branch is created on GitHub at the same commit", async () => {
    const { bare, dir } = await owned(AGENT)
    const gh = bareBackedGitHub(bare)

    const made = toon(await vcs(dir, ["vcs", "branch", "feature/x"], gh.layer))

    expect(made).toMatchObject({ branch: "feature/x", remote: true })
    const post = gh.calls.find((call) => call.route.startsWith("POST"))
    expect(post?.body).toEqual({ ref: "refs/heads/feature/x", sha: await headOf(dir, "main") })
    expect(await headOf(bare, "feature/x")).toBe(await headOf(dir, "main"))
    expect((await sh(dir, ["git", "branch", "--show-current"])).trim()).toBe("feature/x")
  })

  test("a start point that looks like an option is refused", async () => {
    const { bare, dir } = await owned()
    const result = await vcs(
      dir,
      ["vcs", "branch", "feature", "--from=--output=/tmp/x"],
      bareBackedGitHub(bare).layer,
    )
    expect(result.code).toBe(2)
    expect((await sh(dir, ["git", "branch", "--show-current"])).trim()).toBe("main")
  })

  test("a name git rejects is a usage error", async () => {
    const { bare, dir } = await owned()
    const result = await vcs(dir, ["vcs", "branch", "bad..name"], bareBackedGitHub(bare).layer)
    expect(result.code).toBe(2)
  })
})

describe("vcs pr", () => {
  const prGithub = () =>
    fakeGitHub({
      rest: (request) =>
        request.path === "user"
          ? user()
          : request.method === "POST" && request.path.endsWith("/pulls")
            ? { number: 7, html_url: "https://github.com/octo/project/pull/7" }
            : request.method === "PATCH"
              ? { number: 7, html_url: "https://github.com/octo/project/pull/7" }
              : undefined,
    })

  const withOrigin = async () => {
    const dir = await initRepo(OWNER)
    await sh(dir, ["git", "remote", "add", "origin", "https://github.com/octo/project.git"])
    await seed(dir, { "a.txt": "a\n" })
    await sh(dir, ["git", "switch", "-q", "-c", "feature"])
    return dir
  }

  test("creates a pull request from the current branch with cleaned title and body", async () => {
    const dir = await withOrigin()
    await writeFile(
      join(dir, "body.md"),
      "Adds the parser.\n\nGenerated with Claude Code\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
    )
    const gh = prGithub()

    const made = toon(
      await vcs(
        dir,
        [
          "vcs",
          "pr",
          "--base",
          "main",
          "--title",
          "Add parser\nClaude-Session: https://claude.ai/code/s",
          "--body-file",
          "body.md",
        ],
        gh.layer,
      ),
    )

    expect(made).toEqual({
      number: 7,
      url: "https://github.com/octo/project/pull/7",
      created: true,
    })
    const post = gh.calls.find((call) => call.route === "POST repos/octo/project/pulls")
    expect(post?.body).toEqual({
      title: "Add parser",
      body: "Adds the parser.",
      base: "main",
      head: "feature",
    })
    const cached = await readVcs(dir)
    expect(cached).toMatchObject({ branch: "feature", base: "main", pullRequest: "7" })
  })

  test("--update changes the pull request in place", async () => {
    const dir = await withOrigin()
    const gh = prGithub()

    const made = toon(
      await vcs(dir, ["vcs", "pr", "--update", "7", "--title", "Better title"], gh.layer),
    )

    expect(made).toMatchObject({ number: 7, created: false })
    const patch = gh.calls.find((call) => call.route === "PATCH repos/octo/project/pulls/7")
    expect(patch?.body).toEqual({ title: "Better title" })
  })

  test("text about the user is refused before anything is sent", async () => {
    const dir = await withOrigin()
    const gh = prGithub()
    const result = await vcs(
      dir,
      ["vcs", "pr", "--base", "main", "--title", "Do it as requested"],
      gh.layer,
    )
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: MessageRefused")
    expect(gh.routes().some((route) => route.startsWith("POST"))).toBe(false)
  })

  test("a body file must be a small project file, not a path out of the project", async () => {
    const dir = await withOrigin()
    const outside = await scratch()
    await writeFile(join(outside, "secret.txt"), "top secret\n")
    await symlink(join(outside, "secret.txt"), join(dir, "link.md"))
    await writeFile(join(dir, "big.md"), "x".repeat(MAX_BODY_BYTES + 1))
    const gh = prGithub()

    for (const file of [
      join(outside, "secret.txt"),
      "../secret.txt",
      "link.md",
      "big.md",
      "missing.md",
      ".",
    ]) {
      const result = await vcs(
        dir,
        ["vcs", "pr", "--base", "main", "--title", "Add it", "--body-file", file],
        gh.layer,
      )
      expect([file, result.code]).toEqual([file, 2])
    }
    expect(gh.routes().some((route) => route.startsWith("POST"))).toBe(false)
  })

  test("a body file inside .git or ignored by git is not published", async () => {
    const dir = await withOrigin()
    await put(dir, {
      ".gitignore": ".env\nprivate/\n",
      ".env": "TOKEN=abc\n",
      "private/notes.md": "private\n",
      "ok.md": "fine\n",
    })
    const gh = prGithub()
    for (const file of [
      ".env",
      "private/notes.md",
      ".git/config",
      ".GIT/config",
      ".holyagent/local/vcs.json",
    ]) {
      const result = await vcs(
        dir,
        ["vcs", "pr", "--base", "main", "--title", "Add it", "--body-file", file],
        gh.layer,
      )
      expect([file, result.code]).toEqual([file, 2])
    }
    expect(gh.routes().some((route) => route.startsWith("POST"))).toBe(false)

    const fine = await vcs(
      dir,
      ["vcs", "pr", "--base", "main", "--title", "Add it", "--body-file", "ok.md"],
      gh.layer,
    )
    expect(fine.code).toBe(0)
    expect(gh.calls.find((call) => call.route.startsWith("POST"))?.body).toMatchObject({
      body: "fine",
    })
  })

  test("--update takes a plain pull request number only", async () => {
    const dir = await withOrigin()
    for (const bad of ["0", "07", "1e3", "-1", "7;x", ""]) {
      const result = await vcs(
        dir,
        ["vcs", "pr", "--update", bad, "--title", "x"],
        prGithub().layer,
      )
      expect([bad, result.code]).toEqual([bad, 2])
    }
  })

  test("creating needs a base and a title", async () => {
    const dir = await withOrigin()
    expect((await vcs(dir, ["vcs", "pr", "--title", "x"], prGithub().layer)).code).toBe(2)
    expect((await vcs(dir, ["vcs", "pr", "--base", "main"], prGithub().layer)).code).toBe(2)
  })
})
