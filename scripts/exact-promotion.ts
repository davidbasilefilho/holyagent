import { $ } from "bun"
import { Console, Data, Effect, Schema } from "effect"

import { readVersion } from "./bump-version.ts"

/** One-time release path, distinct from the same-version publication repair. */
export const promotionPrefix = "release/0.4.0/promote/"

// Audited pair from the 0.3.4 reconciliation. Only version substitutions separate the
// protected stable tree from the initial 0.4.0 development tree. Never admit a different main.
const stableMain = "56d8b8758b001c4eb0599ee9276aa02607310795"
const devBaseline = "7b0aca66b52f0c2ce47f8ae9eb84ae1474a90863"
const workflow = ".github/workflows/publish.yml"
const validationWorkflow = ".github/workflows/validation.yml"
const required = ["branch-model", "version", "check", "windows", "installers"]
const sha = "[a-f0-9]{40}"
const RefPattern = new RegExp(`^${promotionPrefix}(${sha})/(${sha})/(${sha})$`)

const open = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)])
const Sha = Schema.String.check(Schema.isPattern(new RegExp(`^${sha}$`)))
const branch = open({ protected: Schema.Boolean, commit: open({ sha: Sha }) })
const ref = open({ object: open({ sha: Sha, type: Schema.Literal("commit") }) })
const tree = open({ sha: Sha, tree: open({ sha: Sha }), parents: Schema.Array(open({ sha: Sha })) })
const history = open({ status: Schema.String })
const attemptIdentity = { id: Schema.Int, run_attempt: Schema.Int }
const runFields = {
  ...attemptIdentity,
  path: Schema.String,
  event: Schema.String,
  head_branch: Schema.String,
  head_sha: Sha,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
}
const run = open(runFields)
const runs = open({ workflow_runs: Schema.Array(run) })
const associatedRef = open({ ref: Schema.String, sha: Sha, repo: open({ id: Schema.Int }) })
const candidateRun = open({
  ...runFields,
  pull_requests: Schema.Array(
    open({ number: Schema.Int, base: associatedRef, head: associatedRef }),
  ),
})
const candidateRuns = open({ workflow_runs: Schema.Array(candidateRun) })
const repositoryIdentity = open({ id: Schema.Int })
const jobs = open({
  jobs: Schema.Array(
    open({
      name: Schema.String,
      head_sha: Sha,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
    }),
  ),
})
const rollup = Schema.Array(
  open({
    name: Schema.optional(Schema.String),
    context: Schema.optional(Schema.String),
    workflowName: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    conclusion: Schema.optional(Schema.String),
    state: Schema.optional(Schema.String),
  }),
)
const rules = Schema.Array(
  open({
    type: Schema.String,
    parameters: Schema.optional(
      open({
        strict_required_status_checks_policy: Schema.optional(Schema.Boolean),
        required_status_checks: Schema.optional(Schema.Array(open({ context: Schema.String }))),
      }),
    ),
  }),
)
const pr = open({
  headRefName: Schema.String,
  headRefOid: Sha,
  baseRefName: Schema.String,
  state: Schema.String,
  mergeStateStatus: Schema.String,
  isDraft: Schema.Boolean,
  isCrossRepository: Schema.Boolean,
  autoMergeRequest: Schema.NullOr(open({})),
  statusCheckRollup: rollup,
})

/** The proposed exact-SHA promotion cannot proceed. */
export class PromotionBlocked extends Data.TaggedError("PromotionBlocked")<{
  readonly detail: string
}> {}

const reject = (detail: string) => Effect.fail(new PromotionBlocked({ detail }))
const runJson = <S extends Schema.Top>(command: Bun.$.ShellPromise, schema: S) =>
  Effect.tryPromise({
    try: async (): Promise<unknown> => command.quiet().json(),
    catch: () =>
      new PromotionBlocked({ detail: "GitHub evidence is unavailable or checks are not green" }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })),
    Effect.mapError(
      () =>
        new PromotionBlocked({
          detail: "GitHub evidence is unavailable, malformed or checks are not green",
        }),
    ),
  )

/** Live and immutable evidence for the promotion candidate. */
export interface PromotionEvidence {
  readonly headRef: string
  readonly eventBase: string
  readonly eventHead: string
  readonly currentMain: typeof branch.Type
  readonly currentDev: typeof branch.Type
  readonly currentHead: string
  readonly headObject: typeof tree.Type
  readonly devObject: typeof tree.Type
  readonly checkedOutPolicy: string
  readonly devContainsBaseline: boolean
  readonly version: string
  readonly publishRun: typeof run.Type | undefined
}

/** Verify the exception without treating a newer or merely equivalent Git ref as approval. */
export const checkExactPromotion = (
  proof: PromotionEvidence,
): Effect.Effect<void, PromotionBlocked> =>
  Effect.gen(function* () {
    const tuple = RefPattern.exec(proof.headRef)
    if (tuple === null) return yield* reject("Promotion ref must pin three full commit SHAs")
    const [, target, source, head] = tuple
    if (target !== stableMain || !proof.devContainsBaseline)
      return yield* reject("Main-only source changes are outside the audited 0.4.0 baseline")
    if (proof.version !== "0.4.0") return yield* reject("Only the 0.4.0 upgrade is authorized")
    if (!proof.currentMain.protected || !proof.currentDev.protected)
      return yield* reject("Both main and dev must still be protected")
    if (proof.eventBase !== target || proof.currentMain.commit.sha !== target)
      return yield* reject("Main moved or the PR base SHA differs")
    if (proof.eventHead !== head || proof.currentHead !== head || proof.headObject.sha !== head)
      return yield* reject("The promotion head moved or its SHA differs")
    if (
      proof.currentDev.commit.sha !== source ||
      proof.devObject.sha !== source ||
      proof.checkedOutPolicy !== source
    )
      return yield* reject("Dev, the promoted source SHA and the checked-out policy must agree")
    if (proof.headObject.parents.length !== 1 || proof.headObject.parents[0]?.sha !== target)
      return yield* reject("The candidate must have the audited main as its sole parent")
    if (proof.headObject.tree.sha !== proof.devObject.tree.sha)
      return yield* reject("Candidate content does not equal validated dev")
    const publish = proof.publishRun
    if (
      publish?.path !== workflow ||
      publish.event !== "push" ||
      publish.head_branch !== "dev" ||
      publish.head_sha !== source ||
      publish.status !== "completed" ||
      publish.conclusion !== "success"
    )
      return yield* reject("The latest official Publish run for the exact dev SHA is not green")
  })

/** Confirm that the official dev run did not skip validation or publication. */
export const checkSourceJobs = (
  evidence: typeof jobs.Type,
  head: string,
): Effect.Effect<void, PromotionBlocked> =>
  checkJobNames(
    evidence,
    [
      "validation / check",
      "validation / windows",
      "validation / macos",
      "validation / installers",
      "dev / publish",
      "dev / prerelease",
    ],
    head,
    "Source dev",
  )

const checkJobNames = (
  evidence: typeof jobs.Type,
  names: readonly string[],
  head: string,
  description: string,
) =>
  Effect.gen(function* () {
    for (const name of names) {
      const rows = evidence.jobs.filter((job) => job.name === name)
      if (
        rows.length !== 1 ||
        rows[0]?.head_sha !== head ||
        rows[0]?.status !== "completed" ||
        rows[0]?.conclusion !== "success"
      )
        return yield* reject(`${description} run did not finish ${name} successfully`)
    }
  })

/** Immutable PR identity expected from the official Validation workflow. */
export interface CandidateValidationIdentity {
  readonly number: number
  readonly repositoryId: number
  readonly base: { readonly ref: string; readonly sha: string }
  readonly head: { readonly ref: string; readonly sha: string }
}

/** Bind candidate checks to one specific official workflow, PR, base, head and attempt. */
export const checkCandidateRun = (
  evidence: typeof candidateRun.Type | undefined,
  expected: CandidateValidationIdentity,
): Effect.Effect<typeof candidateRun.Type, PromotionBlocked> =>
  Effect.gen(function* () {
    const linked = evidence?.pull_requests[0]
    if (
      evidence?.path !== validationWorkflow ||
      evidence.event !== "pull_request" ||
      evidence.head_branch !== expected.head.ref ||
      evidence.head_sha !== expected.head.sha ||
      evidence.status !== "completed" ||
      evidence.conclusion !== "success" ||
      evidence.id < 1 ||
      evidence.run_attempt < 1 ||
      evidence.pull_requests.length !== 1 ||
      linked === undefined ||
      linked.number !== expected.number ||
      linked.base.ref !== expected.base.ref ||
      linked.base.sha !== expected.base.sha ||
      linked.head.ref !== expected.head.ref ||
      linked.head.sha !== expected.head.sha ||
      linked.base.repo.id !== expected.repositoryId ||
      linked.head.repo.id !== expected.repositoryId
    )
      return yield* reject("Official Validation is not green at the exact PR, base and head")
    return evidence
  })

/** Required promotion jobs must run on the verified candidate attempt. */
export const checkCandidateJobs = (
  evidence: typeof jobs.Type,
  head: string,
): Effect.Effect<void, PromotionBlocked> =>
  checkJobNames(evidence, [...required, "macos"], head, "Candidate Validation")

/** Read-only release-operator preflight, not a human review or a merge command. */
export const checkPromotionReadiness = (
  row: typeof pr.Type,
  activeRules: typeof rules.Type,
  headRef: string,
  head: string,
): Effect.Effect<void, PromotionBlocked> =>
  Effect.gen(function* () {
    if (
      row.headRefName !== headRef ||
      row.headRefOid !== head ||
      row.baseRefName !== "main" ||
      row.state !== "OPEN" ||
      row.isDraft ||
      row.isCrossRepository ||
      row.autoMergeRequest !== null ||
      row.mergeStateStatus !== "CLEAN"
    )
      return yield* reject("The live PR is not clean and open at the exact head on main")
    const protection = activeRules.filter(({ type }) => type === "required_status_checks")
    const contexts = new Set(
      protection.flatMap(
        ({ parameters }) => parameters?.required_status_checks?.map(({ context }) => context) ?? [],
      ),
    )
    if (
      !protection.some(
        ({ parameters }) =>
          parameters?.strict_required_status_checks_policy === true &&
          required.every((name) =>
            parameters.required_status_checks?.some(({ context }) => context === name),
          ),
      )
    )
      return yield* reject("The existing strict main checks are not all active")
    const green = (context: string) => {
      const matches = row.statusCheckRollup.filter(
        (entry) => (entry.name ?? entry.context) === context,
      )
      const status = matches[0]
      return (
        matches.length === 1 &&
        status !== undefined &&
        (!required.includes(context) || status.workflowName === "Validation") &&
        (status.name === undefined
          ? status.state === "SUCCESS"
          : status.status === "COMPLETED" && status.conclusion === "SUCCESS")
      )
    }
    if (![...contexts].every(green))
      return yield* reject("A required PR check is pending, failed, missing or ambiguous")
  })

/** Read official GitHub evidence. This command does not approve, merge, or publish anything. */
export const verify = (
  repository: string,
  headRef: string,
  eventBase: string,
  eventHead: string,
  number?: string,
) =>
  Effect.gen(function* () {
    const tuple = RefPattern.exec(headRef)
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      tuple === null ||
      (number !== undefined && !/^[1-9]\d*$/.test(number))
    )
      return yield* reject("Invalid repository, promotion ref or PR number")
    const [, target = "", source = "", head = ""] = tuple
    if (target !== stableMain) return yield* reject("The main SHA is not the audited 0.4.0 base")
    const api = <S extends Schema.Top>(path: string, schema: S) =>
      runJson($`gh api ${`repos/${repository}/${path}`}`, schema)
    const readMain = () => api("branches/main", branch)
    const readDev = () => api("branches/dev", branch)
    const readHead = () => api(`git/ref/heads/${headRef}`, ref)
    const [
      currentMain,
      currentDev,
      branchHead,
      headObject,
      devObject,
      ancestry,
      publication,
      local,
      version,
    ] = yield* Effect.all(
      [
        readMain(),
        readDev(),
        readHead(),
        api(`git/commits/${head}`, tree),
        api(`git/commits/${source}`, tree),
        api(`compare/${devBaseline}...${source}?per_page=1`, history),
        api(
          `actions/workflows/publish.yml/runs?branch=dev&event=push&head_sha=${source}&per_page=1`,
          runs,
        ),
        Effect.tryPromise({
          try: () => $`git rev-parse HEAD`.quiet().text(),
          catch: () => new PromotionBlocked({ detail: "Cannot read checked-out policy commit" }),
        }),
        readVersion(".", "package.json"),
      ],
      { concurrency: 5 },
    )
    const publishRun = publication.workflow_runs[0]
    const evidence: PromotionEvidence = {
      headRef,
      eventBase,
      eventHead,
      currentMain,
      currentDev,
      currentHead: branchHead.object.sha,
      headObject,
      devObject,
      checkedOutPolicy: local.trim(),
      version,
      devContainsBaseline: ancestry.status === "ahead" || ancestry.status === "identical",
      publishRun,
    }
    yield* checkExactPromotion(evidence)
    if (publishRun === undefined || publishRun.id < 1 || publishRun.run_attempt < 1)
      return yield* reject("Source dev run or attempt ID is missing")
    const exactJobs = yield* api(
      `actions/runs/${publishRun.id}/attempts/${publishRun.run_attempt}/jobs`,
      jobs,
    )
    yield* checkSourceJobs(exactJobs, source)
    if (number !== undefined) {
      const [candidate, repo] = yield* Effect.all(
        [
          api(
            `actions/workflows/validation.yml/runs?event=pull_request&head_sha=${head}&per_page=1`,
            candidateRuns,
          ),
          runJson($`gh api ${`repos/${repository}`}`, repositoryIdentity),
        ],
        { concurrency: 2 },
      )
      const validated = yield* checkCandidateRun(candidate.workflow_runs[0], {
        number: Number(number),
        repositoryId: repo.id,
        base: { ref: "main", sha: target },
        head: { ref: headRef, sha: head },
      })
      const candidateJobs = yield* api(
        `actions/runs/${validated.id}/attempts/${validated.run_attempt}/jobs`,
        jobs,
      )
      yield* checkCandidateJobs(candidateJobs, head)

      // Read mutable merge metadata after verifying both sets of immutable job receipts.
      const [row, activeRules, latestMain, latestDev, latestHead] = yield* Effect.all(
        [
          runJson(
            $`gh pr view ${number} -R ${repository} --json headRefName,headRefOid,baseRefName,state,mergeStateStatus,isDraft,isCrossRepository,autoMergeRequest,statusCheckRollup`,
            pr,
          ),
          api("rules/branches/main", rules),
          readMain(),
          readDev(),
          readHead(),
        ],
        { concurrency: 5 },
      )
      yield* checkPromotionReadiness(row, activeRules, headRef, head)
      yield* checkExactPromotion({
        ...evidence,
        currentMain: latestMain,
        currentDev: latestDev,
        currentHead: latestHead.object.sha,
      })
    }
  })

if (import.meta.main) {
  const [repository = "", head = "", baseSha = "", headSha = "", number] = Bun.argv.slice(2)
  await Effect.runPromise(
    verify(repository, head, baseSha, headSha, number).pipe(
      Effect.andThen(Console.log("Exact 0.4.0 promotion evidence passed")),
      Effect.catch((error) =>
        Console.error(error instanceof PromotionBlocked ? error.detail : error.message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1
            }),
          ),
        ),
      ),
    ),
  )
}
