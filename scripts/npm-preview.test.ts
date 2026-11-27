import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { comparePreviewControls, packPreview, previewTree } from "./npm-preview-archive.ts"
import { readPreviewEvidence, readPreviewPlan } from "./npm-preview-live.ts"
import { planPreview, previewVersion, verifyPreviewTransition } from "./npm-preview.ts"

const head = "1".repeat(40)
const prior = "2".repeat(40)
const policy = "3".repeat(40)
const integrity = `sha512-${"A".repeat(86)}==`
const otherIntegrity = `sha512-${"B".repeat(86)}==`
const now = "2026-11-27T01:02:03Z"
const before = "2026-11-26T12:03:04Z"
const preview = previewVersion("0.4.0", 3, now, head)
const older = previewVersion("0.4.0", 1, before, prior)

const candidate = (number: number, sha: string, committerUtc: string) => ({
  number,
  sha,
  committerUtc,
  base: "dev",
  head: "trusted/topic",
  open: true,
  draft: false,
  sameRepository: true,
  author: "writer",
  baseVersion: "0.4.0",
  controls: { source: policy, sha, unchanged: true },
  reviews: [{ reviewer: "Maintainer", sha, state: "APPROVED" }],
  validation: { sha, state: "success" },
  artifact: { sha, expectedIntegrity: integrity, registryIntegrity: integrity },
})

const first = () => candidate(3, head, now)
const second = () => candidate(1, prior, before)
const snapshot = (
  candidates: ReadonlyArray<unknown> = [first(), second()],
  tags: Record<string, string> = { latest: "0.3.4", dev: "0.4.0-dev.1" },
) => ({
  repository: "davidbasilefilho/holyagent",
  source: { checkout: policy, sha: policy, protected: true },
  trustedReviewers: ["maintainer"],
  complete: true,
  candidates,
  tags,
})
const plan = (input: unknown) => Effect.runPromise(planPreview(input))
const block = (input: unknown) => Effect.runPromise(Effect.flip(planPreview(input)))

describe("preview channel evidence", () => {
  test("selects by HEAD committer UTC with a stable PR-id tie and leaves latest/dev alone", async () => {
    const a = await plan(snapshot([second(), first(), candidate(2, prior, now)]))
    const b = await plan(snapshot([candidate(2, prior, now), first(), second()]))
    expect(a).toEqual(b)
    expect(a.selected).toBe(3)
    expect(a.changes).toEqual([
      { op: "add", tag: "pr-3", version: preview },
      { op: "add", tag: "pr-2", version: previewVersion("0.4.0", 2, now, prior) },
      { op: "add", tag: "pr-1", version: older },
      { op: "add", tag: "pr", version: preview },
    ])
  })
  test("does not promote an older ready preview when latest HEAD is not eligible or ready", async () => {
    for (const top of [
      { ...first(), sameRepository: false },
      { ...first(), draft: true },
      { ...first(), reviews: [] },
      { ...first(), controls: { source: policy, sha: head, unchanged: false } },
      { ...first(), controls: { source: prior, sha: head, unchanged: true } },
      { ...first(), controls: { source: policy, sha: prior, unchanged: true } },
      { ...first(), validation: { sha: head, state: "pending" } },
      { ...first(), validation: { sha: head, state: "failure" } },
      { ...first(), validation: { sha: prior, state: "success" } },
      { ...first(), artifact: { ...first().artifact, registryIntegrity: null } },
      { ...first(), artifact: { ...first().artifact, sha: prior } },
    ]) {
      const result = await plan(snapshot([second(), top], { pr: older, "pr-1": older }))
      expect(result.selected).toBe(3)
      expect(result.changes).toEqual([{ op: "remove", tag: "pr", previous: older }])
    }
  })
  test("requires the independent exact-head effective review", async () => {
    for (const reviews of [
      [{ reviewer: "writer", sha: head, state: "APPROVED" }],
      [{ reviewer: "someone", sha: head, state: "APPROVED" }],
      [{ reviewer: "maintainer", sha: prior, state: "APPROVED" }],
      [...first().reviews, { reviewer: "maintainer", sha: head, state: "DISMISSED" }],
      [...first().reviews, { reviewer: "maintainer", sha: head, state: "CHANGES_REQUESTED" }],
    ]) {
      const result = await plan({
        ...snapshot([{ ...first(), reviews }]),
        trustedReviewers: ["maintainer", "writer"],
      })
      expect(result.candidates[0]?.status).toBe("ineligible")
    }
    const result = await plan(
      snapshot([
        {
          ...first(),
          reviews: [...first().reviews, { reviewer: "Maintainer", sha: head, state: "COMMENTED" }],
        },
      ]),
    )
    expect(result.candidates[0]?.status).toBe("ready")
  })
  test("closes, reopens, and removes stale or superseded tags without republishing immutable bytes", async () => {
    const tags = { pr: preview, "pr-3": preview, unrelated: "stable", latest: "0.3.4" }
    const closed = await plan(snapshot([{ ...first(), open: false }, second()], tags))
    expect(closed.selected).toBe(1)
    expect(closed.changes).toContainEqual({ op: "remove", tag: "pr-3", previous: preview })
    expect(closed.changes).toContainEqual({ op: "add", tag: "pr", version: older })
    expect(await plan(snapshot([first()], tags))).toMatchObject({ selected: 3, changes: [] })
    const pushed = { ...first(), sha: prior }
    expect((await plan(snapshot([pushed], tags))).changes).toHaveLength(2)
  })
  test("fails closed for incomplete GitHub reads, moved policy, conflicting bytes and foreign tag values", async () => {
    expect((await block({ ...snapshot(), complete: false })).detail).toContain("complete")
    expect(
      (await block({ ...snapshot(), source: { sha: head, checkout: policy, protected: true } }))
        .detail,
    ).toContain("protected dev")
    expect(
      (await block({ ...snapshot(), source: { sha: policy, checkout: policy, protected: false } }))
        .detail,
    ).toContain("protected dev")
    expect(
      (
        await block(
          snapshot([
            { ...first(), artifact: { ...first().artifact, registryIntegrity: otherIntegrity } },
          ]),
        )
      ).detail,
    ).toContain("Immutable")
    expect((await block(snapshot([first()], { pr: "0.3.4" }))).detail).toContain("ownership")
    expect((await block(snapshot([first()], { "pr-3": older }))).detail).toContain("ownership")
    expect((await block(snapshot([first(), first()]))).detail).toContain("Duplicate")
    expect(
      (await block(snapshot([{ ...first(), committerUtc: "2026-02-31T01:02:03Z" }]))).detail,
    ).toContain("invalid commit UTC")
  })
  test("readback checks drift and refuses unrelated changes, even with a nominally successful write", async () => {
    const old = snapshot([first()], { latest: "0.3.4", dev: "0.4.0-dev.1", "pr-3": preview })
    const after = { ...old, tags: { ...old.tags, pr: preview } }
    const op = { op: "add", tag: "pr", version: preview } as const
    expect(await Effect.runPromise(verifyPreviewTransition(old, after, op))).toBeUndefined()
    for (const moved of [
      old,
      { ...after, tags: { ...after.tags, latest: "0.4.0" } },
      { ...after, candidates: [{ ...first(), sha: prior }] },
      { ...after, candidates: [first(), candidate(4, head, now)] },
    ])
      expect(
        await Effect.runPromise(Effect.flip(verifyPreviewTransition(old, moved, op))),
      ).toBeDefined()
    expect(
      await Effect.runPromise(
        Effect.flip(
          verifyPreviewTransition(old, old, { op: "add", tag: "latest", version: preview }),
        ),
      ),
    ).toBeDefined()
  })
})

describe("controlled exact-Git preview packaging", () => {
  const prefix = "packages/integrations/pi/dist/"
  const blob = (path: string, mode = "100644", bytes = "10") =>
    `${mode} blob ${head} ${bytes}\t${prefix}${path}\x00`
  const entries =
    blob("package.json") +
    blob("scripts/holyagent-cli-bin.js", "100755") +
    blob("scripts/holyagent-public-bin.js", "100755")
  test("rejects object types, traversal, unexpected names, duplicate aliases and oversize content", () => {
    expect(previewTree(entries)).toHaveLength(3)
    for (const content of [
      blob("../script") + entries,
      blob("scripts/.npmrc") + entries,
      blob("scripts/alias.") + entries,
      blob("scripts/CON.txt") + entries,
      blob("node_modules/pkg") + entries,
      blob("scripts/symlink", "120000") + entries,
      blob("scripts/release", "160000") + entries,
      blob("PACKAGE.json") + entries,
      blob("scripts/x", "100644", "90000000") + entries,
      blob("scripts/" + "x".repeat(95)) + entries,
      entries.slice(0, -1),
    ])
      expect(() => previewTree(content)).toThrow()
  })
  test("packs readable, deterministic exact Git tree files and does not use the working tree", async () => {
    const git = Bun.spawnSync(["git", "show", "-s", "--format=%H%n%cI", "HEAD"])
    expect(git.exitCode).toBe(0)
    const [sha = "", date = ""] = git.stdout.toString().trim().split(/\r?\n/)
    expect(await Effect.runPromise(comparePreviewControls(process.cwd(), sha, sha))).toEqual({
      source: sha,
      sha,
      unchanged: true,
    })
    const utc = new Date(date).toISOString().replace(".000Z", "Z")
    const one = await Effect.runPromise(packPreview(process.cwd(), 123, sha, utc))
    const two = await Effect.runPromise(packPreview(process.cwd(), 123, sha, utc))
    expect(one.integrity).toBe(two.integrity)
    expect(one.version).toEndWith(`.g${sha}`)
    const manifest = Bun.spawnSync(["tar", "-xOzf", "-", "package/package.json"], {
      stdin: one.archive,
    })
    expect(manifest.exitCode).toBe(0)
    expect(JSON.parse(manifest.stdout.toString())).toMatchObject({
      name: "holyagent",
      version: one.version,
    })
    expect(
      await Effect.runPromise(Effect.flip(packPreview(process.cwd(), 123, sha, before))),
    ).toMatchObject({ detail: "The candidate committer UTC has changed" })
  }, 20000)
})

test("live read binds a reviewed HEAD and workflow attempt, but a newer fork still wins the global ranking", async () => {
  const git = Bun.spawnSync(["git", "show", "-s", "--format=%H%n%cI", "HEAD"])
  const [source = "", date = ""] = git.stdout.toString().trim().split(/\r?\n/)
  const utc = new Date(date).toISOString().replace(".000Z", "Z")
  const packed = await Effect.runPromise(packPreview(process.cwd(), 1, source, utc))
  const auth: string[] = []
  let moved = false
  let listReads = 0
  let attempt = ""
  const request = (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    const headers = new Headers(init.headers)
    expect(init.redirect).toBe("error")
    const json = (v: unknown) => Promise.resolve(Response.json(v))
    if (new URL(url).origin === "https://registry.npmjs.org") {
      expect(headers.has("authorization")).toBe(false)
      if (path.endsWith("/dist-tags")) return json({ latest: "0.3.4", pr: packed.version })
      expect(path).toBe(`/holyagent/${packed.version}`)
      return json({
        name: "holyagent",
        version: packed.version,
        dist: { integrity: packed.integrity },
      })
    }
    expect(headers.get("authorization")).toBe("Bearer test-token")
    auth.push(path)
    if (path.endsWith("/branches/dev"))
      return json({ name: "dev", protected: true, commit: { sha: source } })
    if (path.endsWith("/pulls")) {
      listReads++
      const row = {
        state: "open",
        draft: false,
        user: { login: "writer" },
        base: { ref: "dev", sha: source, repo: { id: 10 } },
      }
      return json([
        { ...row, number: 1, head: { ref: "approved/pr", sha: source, repo: { id: 10 } } },
        {
          ...row,
          number: 2,
          head: { ref: "fork/pr", sha: moved && listReads === 2 ? prior : head, repo: { id: 20 } },
        },
      ])
    }
    if (path.endsWith(`/git/commits/${source}`))
      return json({ sha: source, committer: { date: utc } })
    if (path.endsWith(`/git/commits/${head}`))
      return json({ sha: head, committer: { date: "2099-01-01T00:00:00Z" } })
    if (path.endsWith("/pulls/1/reviews"))
      return json([{ user: { login: "maintainer" }, commit_id: source, state: "APPROVED" }])
    if (path.endsWith("/actions/workflows/validation.yml/runs"))
      return json({
        total_count: 1,
        workflow_runs: [
          {
            id: 51,
            run_attempt: 2,
            path: ".github/workflows/validation.yml",
            event: "pull_request",
            head_branch: "approved/pr",
            head_sha: source,
            status: "completed",
            conclusion: "success",
            created_at: now,
            pull_requests: [{ number: 1, head: { sha: source }, base: { sha: source } }],
          },
        ],
      })
    if (path.includes("/actions/runs/")) {
      attempt = path
      return json({
        total_count: 4,
        jobs: ["branch-model", "check", "windows", "installers"].map((name) => ({
          name,
          head_sha: source,
          status: "completed",
          conclusion: "success",
        })),
      })
    }
    throw new Error(`Unexpected request: ${path}`)
  }
  const raw = await Effect.runPromise(
    readPreviewEvidence(process.cwd(), ["maintainer"], "test-token", request),
  )
  expect(raw.candidates.find((pull) => pull.number === 1)).toMatchObject({
    sha: source,
    committerUtc: utc,
    artifact: {
      sha: source,
      expectedIntegrity: packed.integrity,
      registryIntegrity: packed.integrity,
    },
  })
  const loaded = await plan(raw)
  expect(loaded.selected).toBe(2)
  expect(loaded.changes).toEqual([
    { op: "remove", tag: "pr", previous: packed.version },
    { op: "add", tag: "pr-1", version: packed.version },
  ])
  expect(attempt).toEndWith("/actions/runs/51/attempts/2/jobs")
  expect(auth.some((url) => url.endsWith("/pulls/2/reviews"))).toBe(false)
  moved = true
  listReads = 0
  expect(
    await Effect.runPromise(
      Effect.flip(readPreviewPlan(process.cwd(), ["maintainer"], "test-token", request)),
    ),
  ).toMatchObject({ detail: "Protected dev or the open PR set moved during the evidence read" })
}, 20000)
