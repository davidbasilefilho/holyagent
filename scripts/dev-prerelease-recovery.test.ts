import { describe, expect, test } from "bun:test"

import { Effect, Exit } from "effect"

import {
  type DevReleaseState,
  type DevReleaseStep,
  planDevRelease,
  reconcileDevRelease,
  RecoveryError,
  verifyOriginalDevRun,
} from "./dev-prerelease-recovery.ts"

const commit = "a".repeat(40)
const other = "b".repeat(40)
const repo = "davidbasilefilho/holyagent"
const version = "0.4.0-dev.2026-11-27.20-54-33.gaaaaaaa"
const target = { commit, version, sha256: "c".repeat(64) }
const tag = { tagCommit: commit }
const release = { tag_name: `holyagent-${version}`, draft: false, prerelease: true, assets: [] }
const asset = { name: `holyagent-${version}.tgz`, digest: `sha256:${target.sha256}` }
const done = { ...tag, release: { ...release, assets: [asset] } }

describe("idempotent GitHub dev prerelease recovery", () => {
  test("only missing exact records are written, including when resuming after a tag or release", async () => {
    for (const [initial, expected] of [
      [{}, ["tag", "release", "asset"]],
      [tag, ["release", "asset"]],
      [{ ...tag, release }, ["asset"]],
      [done, []],
    ] as const) {
      const writes: DevReleaseStep[] = []
      let state: DevReleaseState = initial
      const run = reconcileDevRelease(target, {
        observe: Effect.sync(() => state),
        confirmCurrentDev: Effect.void,
        write: (step) =>
          Effect.sync(() => {
            writes.push(step)
            state = step === "tag" ? tag : step === "release" ? { ...tag, release } : done
          }),
      })
      await Effect.runPromise(run)
      expect(writes).toEqual([...expected])
      expect(state).toEqual(done)
      await Effect.runPromise(run)
      expect(writes).toEqual([...expected])
    }
  })

  test("rejects conflicting tags, draft / stable releases and absent or differing asset digests", async () => {
    for (const state of [
      { tagCommit: other },
      { release },
      { ...tag, release: { ...release, tag_name: "holyagent-0.4.0" } },
      { ...tag, release: { ...release, draft: true } },
      { ...tag, release: { ...release, prerelease: false } },
      { ...tag, release: { ...release, assets: [{ ...asset, digest: null }] } },
      { ...tag, release: { ...release, assets: [{ ...asset, digest: `sha256:${other}` }] } },
      { ...tag, release: { ...release, assets: [asset, asset] } },
    ]) {
      const calls: string[] = []
      const result = await Effect.runPromiseExit(
        reconcileDevRelease(target, {
          observe: Effect.succeed(state),
          confirmCurrentDev: Effect.void,
          write: (step) =>
            Effect.sync(() => {
              calls.push(step)
            }),
        }),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(calls).toEqual([])
    }
  })

  test("an exact concurrent completion is accepted, an unrelated or unchanged result is not", async () => {
    for (const next of [done, { tagCommit: other }, { ...tag, release }]) {
      let state: DevReleaseState = { ...tag, release }
      let writes = 0
      const result = await Effect.runPromiseExit(
        reconcileDevRelease(target, {
          observe: Effect.sync(() => state),
          confirmCurrentDev: Effect.void,
          write: () =>
            Effect.sync(() => {
              state = next
              writes++
            }).pipe(
              Effect.andThen(Effect.fail(new RecoveryError({ detail: "concurrent upload" }))),
            ),
        }),
      )
      expect(Exit.isSuccess(result)).toBe(next === done)
      expect(writes).toBe(1)
    }
  })

  test("rechecks live protected dev before each write and never overwrites after it moves", async () => {
    let state: DevReleaseState = {}
    const writes: string[] = []
    const result = await Effect.runPromiseExit(
      reconcileDevRelease(target, {
        observe: Effect.sync(() => state),
        confirmCurrentDev: Effect.suspend(() =>
          writes.length === 0
            ? Effect.void
            : Effect.fail(new RecoveryError({ detail: "The protected dev head moved" })),
        ),
        write: (step) =>
          Effect.sync(() => {
            state = tag
            writes.push(step)
          }),
      }),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(writes).toEqual(["tag"])
    expect(await Effect.runPromise(planDevRelease(target, state))).toBe("release")
  })
})

describe("the historical dev publication is bound to its first, signed attempt", () => {
  const identity = { runId: 19, attempt: 1 }
  const repository = { full_name: repo }
  const run = {
    id: identity.runId,
    run_attempt: identity.attempt,
    head_sha: commit,
    head_branch: "dev",
    path: ".github/workflows/publish.yml",
    event: "push",
    status: "completed",
    conclusion: "failure",
    repository,
    head_repository: repository,
  }
  const rows = ["check", "windows", "macos", "installers"].map((job) => ({
    name: `validation / ${job}`,
    head_sha: commit,
    status: "completed",
    conclusion: "success",
  }))
  const publish = {
    name: "dev / publish",
    head_sha: commit,
    status: "completed",
    conclusion: "failure",
  }
  const jobs = { total_count: 5, jobs: [...rows, publish] }

  test("authorizes a late publication after independently verified provenance and validation", async () => {
    expect(
      await Effect.runPromise(verifyOriginalDevRun(commit, identity, run, jobs)),
    ).toBeUndefined()
  })

  test("cannot use later attempts, wrong workflows, branches, repositories or commits", async () => {
    for (const changed of [
      { id: 20 },
      { run_attempt: 2 },
      { head_sha: other },
      { head_branch: "main" },
      { path: ".github/workflows/npm-preview.yml" },
      { event: "pull_request" },
      { head_repository: { full_name: "another/holyagent" } },
      { status: "in_progress" },
      { conclusion: "cancelled" },
    ]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(
            verifyOriginalDevRun(commit, identity, { ...run, ...changed }, jobs),
          ),
        ),
      ).toBe(true)
    }
  })

  test("no skipped, duplicated, failed validation, wrong SHA or incomplete job list is accepted", async () => {
    for (const changedJobs of [
      { total_count: 7, jobs: jobs.jobs },
      { total_count: 4, jobs: rows },
      { total_count: 6, jobs: [...jobs.jobs, publish] },
      { total_count: 5, jobs: [...rows, { ...publish, conclusion: "skipped" }] },
      ...["failure", "skipped", null].map((conclusion) => ({
        total_count: 5,
        jobs: [
          ...rows.map((row) => (row.name.endsWith("windows") ? { ...row, conclusion } : row)),
          publish,
        ],
      })),
      { total_count: 5, jobs: [...rows, { ...publish, head_sha: other }] },
    ]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(verifyOriginalDevRun(commit, identity, run, changedJobs)),
        ),
      ).toBe(true)
    }
  })
})
