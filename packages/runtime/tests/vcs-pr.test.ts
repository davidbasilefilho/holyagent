import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { MAX_BODY_BYTES } from "../src/vcs/pr.ts"
import { cleanup, fakeGitHub, initRepo, put, scratch, seed, sh, toon, vcs } from "./vcs-fixtures.ts"

afterEach(cleanup)

const OWNER = { name: "Octo", email: "42+octo@users.noreply.github.com" }

describe("vcs pr", () => {
  const prGithub = () =>
    fakeGitHub({
      rest: (request) =>
        request.method === "POST" && request.path.endsWith("/pulls")
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
    await mkdir(join(dir, ".holyagent/local"), { recursive: true })
    await writeFile(join(dir, ".holyagent/local/.gitignore"), "*\n")
    await writeFile(join(dir, ".holyagent/local/vcs.json"), "{}\n")
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

  test("the commands left are commit, pr and identity: push, branch, ci and detect are gone", async () => {
    const dir = await withOrigin()
    for (const gone of ["push", "branch", "ci", "detect"]) {
      const result = await vcs(dir, ["vcs", gone], prGithub().layer)
      expect([gone, result.code]).toEqual([gone, 2])
      expect(result.stderr).toContain("Unknown command")
    }
    const help = await vcs(dir, ["vcs", "--help"], prGithub().layer)
    expect(help.stdout).toContain("vcs commit")
    expect(help.stdout).toContain("vcs pr")
    expect(help.stdout).toContain("vcs identity")
    for (const gone of ["vcs push", "vcs branch", "vcs ci", "vcs detect"])
      expect(help.stdout).not.toContain(gone)
  })
})
