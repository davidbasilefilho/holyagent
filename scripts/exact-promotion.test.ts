import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import {
  checkCandidateJobs,
  checkCandidateRun,
  checkExactPromotion,
  checkPromotionReadiness,
  checkSourceJobs,
  type PromotionEvidence,
  promotionPrefix,
} from "./exact-promotion.ts"

const main = "56d8b8758b001c4eb0599ee9276aa02607310795"
const dev = "d".repeat(40)
const head = "e".repeat(40)
const tree = "b".repeat(40)
const changed = "c".repeat(40)
const headRef = `${promotionPrefix}${main}/${dev}/${head}`
const proof: PromotionEvidence = {
  headRef,
  eventBase: main,
  eventHead: head,
  currentMain: { protected: true, commit: { sha: main } },
  currentDev: { protected: true, commit: { sha: dev } },
  currentHead: head,
  checkedOutPolicy: dev,
  devContainsBaseline: true,
  version: "0.4.0",
  headObject: { sha: head, tree: { sha: tree }, parents: [{ sha: main }] },
  devObject: { sha: dev, tree: { sha: tree }, parents: [] },
  publishRun: {
    id: 45908297590,
    run_attempt: 1,
    path: ".github/workflows/publish.yml",
    event: "push",
    head_branch: "dev",
    head_sha: dev,
    status: "completed",
    conclusion: "success",
  },
}

describe("the one-time exact promotion exception", () => {
  test("accepts the anchored base, validated dev tree and sole-parent head", async () => {
    expect(await Effect.runPromise(checkExactPromotion(proof))).toBeUndefined()
  })

  const denied: [string, Partial<PromotionEvidence>, RegExp][] = [
    ["unqualified head", { headRef: "release/0.4.0/promote/short" }, /three full/],
    ["event base moved", { eventBase: changed }, /Main moved/],
    [
      "main moved after CI started",
      { currentMain: { protected: true, commit: { sha: changed } } },
      /Main moved/,
    ],
    ["event head moved despite a rerun", { eventHead: changed }, /head moved/],
    ["head moved after CI started", { currentHead: changed }, /head moved/],
    [
      "header SHA differs from the object",
      { headObject: { ...proof.headObject, sha: changed } },
      /head moved/,
    ],
    [
      "dev moved after checkout",
      { currentDev: { protected: true, commit: { sha: changed } } },
      /Dev,/,
    ],
    ["policy checkout SHA differs", { checkedOutPolicy: changed }, /Dev,/],
    [
      "main-only edit re-pinned into the ref",
      { headRef: `${promotionPrefix}${changed}/${dev}/${head}`, eventBase: changed },
      /Main-only/,
    ],
    ["new dev history omits the audited baseline", { devContainsBaseline: false }, /Main-only/],
    [
      "unapproved release bytes",
      { headObject: { ...proof.headObject, tree: { sha: changed } } },
      /content does not equal/,
    ],
    [
      "two parents are not accepted by this route",
      { headObject: { ...proof.headObject, parents: [{ sha: main }, { sha: dev }] } },
      /sole parent/,
    ],
    ["downgrade with otherwise valid evidence", { version: "0.3.3" }, /Only the 0.4.0 upgrade/],
    ["same-version release", { version: "0.3.4" }, /Only the 0.4.0 upgrade/],
    [
      "branch protection is gone",
      { currentDev: { protected: false, commit: { sha: dev } } },
      /still be protected/,
    ],
    [
      "dev verification is pending",
      { publishRun: { ...proof.publishRun!, status: "in_progress", conclusion: null } },
      /not green/,
    ],
    [
      "green check is from a different SHA",
      { publishRun: { ...proof.publishRun!, head_sha: changed } },
      /not green/,
    ],
    [
      "green run is from the PR not the protected dev push",
      { publishRun: { ...proof.publishRun!, event: "pull_request" } },
      /not green/,
    ],
    ["dev has no Publish run", { publishRun: undefined }, /not green/],
  ]

  for (const [name, variation, error] of denied)
    test(`rejects ${name}`, async () => {
      const result = await Effect.runPromise(
        Effect.flip(checkExactPromotion({ ...proof, ...variation })),
      )
      expect(result.detail).toMatch(error)
    })
})

test("source validation and prerelease jobs cannot be skipped in a green aggregate run", async () => {
  const required = [
    "validation / check",
    "validation / windows",
    "validation / macos",
    "validation / installers",
    "dev / publish",
    "dev / prerelease",
  ]
  const jobs = required.map((name) => ({
    name,
    head_sha: dev,
    status: "completed",
    conclusion: "success",
  }))
  expect(await Effect.runPromise(checkSourceJobs({ jobs }, dev))).toBeUndefined()
  for (const name of ["dev / publish", "validation / macos"]) {
    const skipped = jobs.map((job) => (job.name === name ? { ...job, conclusion: "skipped" } : job))
    const failure = await Effect.runPromise(Effect.flip(checkSourceJobs({ jobs: skipped }, dev)))
    expect(failure.detail).toContain(name)
  }
})

describe("official candidate workflow provenance", () => {
  const expected = {
    number: 77,
    repositoryId: 9,
    base: { ref: "main", sha: main },
    head: { ref: headRef, sha: head },
  }
  const linked = {
    number: expected.number,
    base: { ...expected.base, repo: { id: expected.repositoryId } },
    head: { ...expected.head, repo: { id: expected.repositoryId } },
  }
  const run = {
    id: 901,
    run_attempt: 2,
    path: ".github/workflows/validation.yml",
    event: "pull_request",
    head_branch: headRef,
    head_sha: head,
    status: "completed",
    conclusion: "success",
    pull_requests: [linked],
  }
  test("accepts the exact official main candidate rather than a check label", async () => {
    expect(await Effect.runPromise(checkCandidateRun(run, expected))).toBe(run)
  })
  test("rejects other workflows, pending attempts, dev-targeted and stale or ambiguous associations", async () => {
    for (const evidence of [
      undefined,
      { ...run, path: ".github/workflows/not-validation.yml" },
      { ...run, event: "push" },
      { ...run, status: "in_progress", conclusion: null },
      { ...run, run_attempt: 0 },
      { ...run, pull_requests: [{ ...linked, number: 78 }] },
      { ...run, pull_requests: [{ ...linked, base: { ...linked.base, ref: "dev" } }] },
      { ...run, pull_requests: [{ ...linked, base: { ...linked.base, sha: changed } }] },
      { ...run, pull_requests: [{ ...linked, head: { ...linked.head, sha: changed } }] },
      { ...run, pull_requests: [{ ...linked, head: { ...linked.head, repo: { id: 10 } } }] },
      { ...run, pull_requests: [linked, { ...linked, number: 78 }] },
    ]) {
      const outcome = await Effect.runPromise(Effect.flip(checkCandidateRun(evidence, expected)))
      expect(outcome.detail).toContain("exact PR, base and head")
    }
  })
  test("candidate attempt must actually finish every required job at the exact SHA", async () => {
    const jobs = ["branch-model", "version", "check", "windows", "macos", "installers"].map(
      (name) => ({
        name,
        head_sha: head,
        status: "completed",
        conclusion: "success",
      }),
    )
    expect(await Effect.runPromise(checkCandidateJobs({ jobs }, head))).toBeUndefined()
    const noMac = jobs.filter(({ name }) => name !== "macos")
    const missing = await Effect.runPromise(Effect.flip(checkCandidateJobs({ jobs: noMac }, head)))
    expect(missing.detail).toContain("did not finish macos")
    for (const version of [
      { conclusion: "skipped" },
      { head_sha: changed },
      { status: "in_progress", conclusion: null },
    ]) {
      const rows = jobs.map((job) => (job.name === "version" ? { ...job, ...version } : job))
      const outcome = await Effect.runPromise(Effect.flip(checkCandidateJobs({ jobs: rows }, head)))
      expect(outcome.detail).toContain("did not finish version")
    }
  })
})

describe("read-only preflight before any merge", () => {
  const names = ["branch-model", "version", "check", "windows", "installers"]
  const green = names.map((name) => ({
    name,
    workflowName: "Validation",
    status: "COMPLETED",
    conclusion: "SUCCESS",
  }))
  const activeRules = [
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: names.map((context) => ({ context })),
      },
    },
  ]
  const pr = {
    headRefName: headRef,
    headRefOid: head,
    baseRefName: "main",
    state: "OPEN",
    mergeStateStatus: "CLEAN",
    isDraft: false,
    isCrossRepository: false,
    autoMergeRequest: null,
    statusCheckRollup: green,
  }
  test("requires live PR metadata and all active main checks", async () => {
    expect(
      await Effect.runPromise(checkPromotionReadiness(pr, activeRules, headRef, head)),
    ).toBeUndefined()
  })
  test("rejects pending, skipped, failed, missing, foreign and duplicate checks", async () => {
    const [one, ...rest] = green
    if (!one) throw new Error("missing fixture")
    for (const list of [
      rest,
      [...green, one],
      [{ ...one, status: "IN_PROGRESS" }, ...rest],
      [{ ...one, workflowName: "Publish" }, ...rest],
      ...["SKIPPED", "FAILURE"].map((conclusion) => [{ ...one, conclusion }, ...rest]),
    ]) {
      const result = await Effect.runPromise(
        Effect.flip(
          checkPromotionReadiness({ ...pr, statusCheckRollup: list }, activeRules, headRef, head),
        ),
      )
      expect(result.detail).toContain("required PR check")
    }
  })
  test("keeps strict protection and requires newly added checks as well", async () => {
    const withoutStrict = [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: names.map((context) => ({ context })),
        },
      },
    ]
    const extra = [
      ...activeRules,
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "Another required check" }],
        },
      },
    ]
    for (const testRules of [withoutStrict, extra]) {
      const result = await Effect.runPromise(
        Effect.flip(checkPromotionReadiness(pr, testRules, headRef, head)),
      )
      expect(result.detail).toMatch(/strict main checks|required PR check/)
    }
    const context = { context: "Another required check", state: "SUCCESS" }
    expect(
      await Effect.runPromise(
        checkPromotionReadiness(
          { ...pr, statusCheckRollup: [...green, context] },
          extra,
          headRef,
          head,
        ),
      ),
    ).toBeUndefined()
  })
  test("rejects green checks on a moved head, a PR that is behind, or auto-merge", async () => {
    for (const row of [
      { ...pr, headRefOid: changed },
      { ...pr, mergeStateStatus: "BEHIND" },
      { ...pr, autoMergeRequest: {} },
    ]) {
      const result = await Effect.runPromise(
        Effect.flip(checkPromotionReadiness(row, activeRules, headRef, head)),
      )
      expect(result.detail).toContain("exact head")
    }
  })
})
