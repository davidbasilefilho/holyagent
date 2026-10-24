import { afterEach, describe, expect, test } from "bun:test"

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
    expect(cached.detection).toMatchObject({ path: "api", verified: false })
    expect(await sh(dir, ["git", "status", "--porcelain", "--untracked-files=all"])).not.toContain(
      "local",
    )
  })

  test("an unknown flag is a usage error", async () => {
    const dir = await repoAs(OCTO)
    const result = await vcs(dir, ["vcs", "detect", "--force"], github().layer)
    expect(result.code).toBe(2)
  })
})
