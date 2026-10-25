import { afterEach, describe, expect, test } from "bun:test"

import { isGithubRemote, repoSlug, stripUserinfo } from "../src/vcs/git.ts"
import {
  cleanup,
  failure,
  fakeGitHub,
  initRepo,
  put,
  readVcs,
  sh,
  toon,
  user,
  vcs,
} from "./vcs-fixtures.ts"

afterEach(cleanup)

const OCTO = { name: "Octo Cat", email: "42+octo@users.noreply.github.com" }
const CLAUDE = { name: "Claude", email: "noreply@anthropic.com" }

/** A repository whose origin is a GitHub URL (never contacted) and whose identity is given. */
const repoAs = async (identity: { name: string; email: string }) => {
  const dir = await initRepo(identity)
  await sh(dir, ["git", "remote", "add", "origin", "https://github.com/octo/project.git"])
  return dir
}

const github = (
  over: { login?: Record<string, unknown>; graphql?: boolean; credential?: boolean } = {},
) =>
  fakeGitHub({
    rest: (request) =>
      request.path === "user"
        ? over.credential === false
          ? failure(401, "Bad credentials")
          : user(over.login)
        : undefined,
    graphql: () =>
      over.graphql === false ? failure(403, "not available") : { viewer: { login: "octo" } },
  })

describe("vcs detect", () => {
  test("the owner's own git identity commits with plain git", async () => {
    const dir = await repoAs(OCTO)
    const detected = toon(await vcs(dir, ["vcs", "detect"], github().layer))
    expect(detected).toMatchObject({
      path: "git",
      owner: "octo",
      repo: "octo/project",
      cached: false,
    })
    expect(detected["signed"]).toBe(false)
  })

  test("the owner's public email counts as the same identity", async () => {
    const dir = await repoAs({ name: "Octo", email: "octo@example.com" })
    const gh = github({ login: { email: "Octo@Example.com" } })
    expect(toon(await vcs(dir, ["vcs", "detect"], gh.layer))).toMatchObject({ path: "git" })
  })

  test("a signing identity is reported as signed", async () => {
    const dir = await repoAs(OCTO)
    await sh(dir, ["git", "config", "commit.gpgsign", "true"])
    expect(toon(await vcs(dir, ["vcs", "detect"], github().layer))["signed"]).toBe(true)
  })

  test("another identity with GraphQL available uses the API and is signed by GitHub", async () => {
    const dir = await repoAs(CLAUDE)
    expect(toon(await vcs(dir, ["vcs", "detect"], github().layer))).toMatchObject({
      path: "api",
      signed: true,
      owner: "octo",
    })
  })

  test("another identity with GraphQL blocked falls back to git as the owner, unsigned, and says why", async () => {
    const dir = await repoAs(CLAUDE)
    const detected = toon(await vcs(dir, ["vcs", "detect"], github({ graphql: false }).layer))
    expect(detected).toMatchObject({ path: "git-owner", signed: false })
    expect(String(detected["reason"])).toContain("GraphQL API is unavailable")
  })

  test("api false in the project config keeps another identity off the API", async () => {
    const dir = await repoAs(CLAUDE)
    await put(dir, { ".holyagent/config.json": JSON.stringify({ vcs: { api: false } }) })
    const gh = github()
    expect(toon(await vcs(dir, ["vcs", "detect"], gh.layer))).toMatchObject({ path: "git-owner" })
    expect(gh.calls.some((call) => call.kind === "graphql")).toBe(false)
  })

  test("a mistake inside the vcs config is reported with the file", async () => {
    const dir = await repoAs(CLAUDE)
    await put(dir, { ".holyagent/config.json": JSON.stringify({ vcs: { apy: false } }) })
    const result = await vcs(dir, ["vcs", "detect"], github().layer)
    expect(result.code).toBe(4)
    expect(result.stderr).toContain("config.json")
  })

  test("no credential and an agent-looking identity is refused with an explanation", async () => {
    const dir = await repoAs(CLAUDE)
    const result = await vcs(dir, ["vcs", "detect"], github({ credential: false }).layer)
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: NoCredential")
    expect(result.stderr).toContain("Bad credentials")
    expect(result.stderr).toContain("hint:")
  })

  test("no credential with the user's own identity still commits with git", async () => {
    const dir = await repoAs({ name: "Dana", email: "dana@example.com" })
    expect(
      toon(await vcs(dir, ["vcs", "detect"], github({ credential: false }).layer)),
    ).toMatchObject({
      path: "git",
    })
  })

  test("the result is cached until the identity, remote, owner or --refresh changes it", async () => {
    const dir = await repoAs(CLAUDE)
    const gh = github()
    expect(toon(await vcs(dir, ["vcs", "detect"], gh.layer))["cached"]).toBe(false)
    expect(toon(await vcs(dir, ["vcs", "detect"], gh.layer))["cached"]).toBe(true)
    expect(gh.calls.filter((call) => call.kind === "graphql")).toHaveLength(1)

    expect(toon(await vcs(dir, ["vcs", "detect", "--refresh"], gh.layer))["cached"]).toBe(false)
    expect(gh.calls.filter((call) => call.kind === "graphql")).toHaveLength(2)

    await sh(dir, ["git", "config", "user.email", OCTO.email])
    expect(toon(await vcs(dir, ["vcs", "detect"], gh.layer))).toMatchObject({
      path: "git",
      cached: false,
    })

    await sh(dir, ["git", "remote", "set-url", "origin", "https://github.com/octo/other.git"])
    expect(toon(await vcs(dir, ["vcs", "detect"], gh.layer))).toMatchObject({
      repo: "octo/other",
      cached: false,
    })

    const switched = github({ login: { login: "someone", id: 7 } })
    expect(toon(await vcs(dir, ["vcs", "detect"], switched.layer))).toMatchObject({
      owner: "someone",
      path: "api",
      cached: false,
    })
  })

  test("the cache lives in the ignored local folder", async () => {
    const dir = await repoAs(CLAUDE)
    toon(await vcs(dir, ["vcs", "detect"], github().layer))
    const cached = await readVcs(dir)
    expect(cached.detection).toMatchObject({ graphql: true, verified: false })
    expect(await sh(dir, ["git", "status", "--porcelain", "--untracked-files=all"])).not.toContain(
      "local",
    )
  })

  test("a detection made while GitHub failed is returned but never cached", async () => {
    const dir = await repoAs({ name: "Dana", email: "dana@example.com" })

    const degraded = toon(await vcs(dir, ["vcs", "detect"], github({ credential: false }).layer))
    expect(degraded).toMatchObject({ path: "git", cached: false })
    expect((await readVcs(dir)).detection).toBeUndefined()
    expect(
      toon(await vcs(dir, ["vcs", "detect"], github({ credential: false }).layer)),
    ).toMatchObject({ cached: false })

    const recovered = toon(await vcs(dir, ["vcs", "detect"], github().layer))
    expect(recovered).toMatchObject({ path: "api", owner: "octo", cached: false })
    expect((await readVcs(dir)).detection).toMatchObject({ graphql: true })
  })

  test("credentials in the remote URL are neither shown nor stored", async () => {
    const dir = await repoAs(OCTO)
    await sh(dir, [
      "git",
      "remote",
      "set-url",
      "origin",
      "https://octo:s3cret-token@github.com/octo/project.git",
    ])
    const result = await vcs(dir, ["vcs", "detect"], github().layer)
    expect(toon(result)).toMatchObject({ repo: "octo/project" })
    expect(result.stdout).not.toContain("s3cret-token")
    expect(await Bun.file(`${dir}/.holyagent/local/vcs.json`).text()).not.toContain("s3cret-token")
  })

  test("changing commit.gpgsign recomputes the detection", async () => {
    const dir = await repoAs(OCTO)
    expect(toon(await vcs(dir, ["vcs", "detect"], github().layer))).toMatchObject({ signed: false })
    await sh(dir, ["git", "config", "commit.gpgsign", "true"])
    expect(toon(await vcs(dir, ["vcs", "detect"], github().layer))).toMatchObject({
      signed: true,
      cached: false,
    })
  })

  test("a cache file that is in an old shape or does not decode is ignored and rewritten", async () => {
    const dir = await repoAs(CLAUDE)
    toon(await vcs(dir, ["vcs", "detect"], github().layer))
    const path = `${dir}/.holyagent/local/vcs.json`
    const cached = JSON.parse(await Bun.file(path).text()) as { detection: Record<string, unknown> }
    const recomputed = async (detection: unknown) => {
      await Bun.write(path, JSON.stringify({ detection }))
      expect(await vcs(dir, ["status"], github().layer)).toMatchObject({ code: 0 })
      const result = toon(await vcs(dir, ["vcs", "detect"], github().layer))
      expect((await readVcs(dir)).detection).toMatchObject({ graphql: true, verified: false })
      return result
    }

    // The shape an earlier version wrote had no probe result, and carried its own path and owner.
    const { graphql: _probe, ...earlier } = cached.detection
    expect(await recomputed({ ...earlier, path: "git", owner: { login: "evil" } })).toMatchObject({
      path: "api",
      owner: "octo",
      cached: false,
    })
    // Extra fields in a current-shape file are never read: the decision stays the live one.
    await Bun.write(
      path,
      JSON.stringify({ detection: { ...cached.detection, path: "git", owner: { login: "evil" } } }),
    )
    expect(toon(await vcs(dir, ["vcs", "detect"], github().layer))).toMatchObject({
      path: "api",
      owner: "octo",
    })
    expect(await recomputed({ ...cached.detection, pending: "HEAD~1" })).toMatchObject({
      cached: false,
    })
    expect(await recomputed("not an object")).toMatchObject({ cached: false })
  })

  test("a pending commit may be a SHA-1 or a SHA-256 id and anything else drops the cache", async () => {
    const dir = await repoAs(CLAUDE)
    toon(await vcs(dir, ["vcs", "detect"], github().layer))
    const path = `${dir}/.holyagent/local/vcs.json`
    const cached = JSON.parse(await Bun.file(path).text()) as { detection: Record<string, unknown> }
    for (const pending of ["a".repeat(40), "b".repeat(64)]) {
      await Bun.write(path, JSON.stringify({ detection: { ...cached.detection, pending } }))
      expect(toon(await vcs(dir, ["vcs", "detect"], github().layer))).toMatchObject({
        cached: true,
      })
      expect((await readVcs(dir)).detection?.pending).toBe(pending)
    }
    await Bun.write(
      path,
      JSON.stringify({ detection: { ...cached.detection, pending: "a".repeat(41) } }),
    )
    expect(toon(await vcs(dir, ["vcs", "detect"], github().layer))).toMatchObject({ cached: false })
  })

  test("the host and slug come from the URL git really uses, after insteadOf", async () => {
    const dir = await repoAs(CLAUDE)
    await sh(dir, ["git", "remote", "set-url", "origin", "gh:octo/project"])
    await sh(dir, ["git", "config", "url.git@github.com:.insteadOf", "gh:"])
    expect(toon(await vcs(dir, ["vcs", "detect"], github().layer))).toMatchObject({
      path: "api",
      repo: "octo/project",
    })

    await sh(dir, ["git", "config", "url.https://git.example.com/.insteadOf", "gh:"])
    await sh(dir, ["git", "config", "--unset", "url.git@github.com:.insteadOf"])
    expect(toon(await vcs(dir, ["vcs", "detect"], github().layer))).toMatchObject({
      path: "git-owner",
      cached: false,
    })
  })

  test("an unknown flag is a usage error", async () => {
    const dir = await repoAs(OCTO)
    const result = await vcs(dir, ["vcs", "detect", "--force"], github().layer)
    expect(result.code).toBe(2)
  })
})

describe("remote URLs", () => {
  test.each([
    ["https://github.com/o/r.git", true],
    ["https://user:pw@github.com/o/r", true],
    ["http://github.com/o/r", true],
    ["git@github.com:o/r.git", true],
    ["github.com:o/r.git", true],
    ["ssh://git@github.com/o/r.git", true],
    ["ssh://github.com/o/r.git", true],
    ["ssh://git@github.com:22/o/r.git", true],
    ["git://github.com/o/r.git", true],
    ["https://GitHub.com/o/r", true],
    ["https://github.com.evil.io/o/r", false],
    ["https://github.com@evil.io/o/r", false],
    ["https://evil.io/github.com/o/r", false],
    ["git@gitlab.com:o/r.git", false],
    ["git@github.com.evil.io:o/r.git", false],
    ["http://local_proxy@127.0.0.1:4242/git/o/r", false],
    ["/tmp/some/remote.git", false],
    ["", false],
  ])("%s is a github.com remote: %p", (url, expected) => {
    expect(isGithubRemote(stripUserinfo(url))).toBe(expected)
    expect(isGithubRemote(url)).toBe(expected)
  })

  test.each([
    ["https://github.com/o/r.git", "o/r"],
    ["git@github.com:o/r", "o/r"],
    ["ssh://git@github.com/o/r.git/", "o/r"],
    ["http://127.0.0.1:4242/git/o/r", "o/r"],
    ["https://github.com/../r", undefined],
    ["https://github.com/o/..", undefined],
    ["https://github.com/./r", undefined],
    ["https://github.com/o/..git", undefined],
    ["https://github.com/o/r r", undefined],
    ["r", undefined],
  ])("%s names %p", (url, slug) => {
    expect(repoSlug(url)).toBe(slug)
  })
})
