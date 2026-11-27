import { Console, Data, Effect, Schema } from "effect"

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const Version = Schema.String.check(Schema.isPattern(/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/))
const PrNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/))
const Integrity = Schema.String.check(Schema.isPattern(/^sha512-[A-Za-z0-9+/]{86}==$/))
const Review = Schema.Struct({
  reviewer: Schema.String,
  sha: Sha,
  state: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"]),
})
const Candidate = Schema.Struct({
  number: PrNumber,
  open: Schema.Boolean,
  draft: Schema.Boolean,
  base: Schema.String,
  head: Schema.String,
  sameRepository: Schema.Boolean,
  author: Schema.String,
  sha: Sha,
  committerUtc: Timestamp,
  baseVersion: Schema.optionalKey(Version),
  controls: Schema.optionalKey(Schema.Struct({ source: Sha, sha: Sha, unchanged: Schema.Boolean })),
  reviews: Schema.Array(Review),
  validation: Schema.Struct({
    sha: Sha,
    state: Schema.Literals(["success", "pending", "failure"]),
  }),
  artifact: Schema.optionalKey(
    Schema.Struct({
      sha: Sha,
      expectedIntegrity: Integrity,
      registryIntegrity: Schema.NullOr(Integrity),
    }),
  ),
})
const Snapshot = Schema.Struct({
  repository: Schema.Literal("davidbasilefilho/holyagent"),
  source: Schema.Struct({ sha: Sha, checkout: Sha, protected: Schema.Boolean }),
  complete: Schema.Boolean,
  trustedReviewers: Schema.Array(Schema.NonEmptyString),
  candidates: Schema.Array(Candidate),
  tags: Schema.Record(Schema.String, Schema.NonEmptyString),
})

/** Schema-checked input to preview planning, with the exact commit, time and artifact digest. */
export type PreviewEvidence = typeof Snapshot.Type

type Pull = PreviewEvidence["candidates"][number]

/** One allowed tag mutation, never a stable or dev channel. */
export type PreviewChange =
  | { readonly op: "add"; readonly tag: string; readonly version: string }
  | { readonly op: "remove"; readonly tag: string; readonly previous: string }

/** Reconciliation for one complete, already authenticated evidence snapshot. */
export interface PreviewPlan {
  readonly sourceSha: string
  readonly selected: number | null
  readonly candidates: readonly {
    readonly number: number
    readonly sha: string
    readonly version: string | null
    readonly status: "ineligible" | "ready" | "waiting-validation" | "waiting-artifact"
  }[]
  readonly changes: readonly PreviewChange[]
}

/** Evidence is incomplete, ambiguous, drifting, or inconsistent with immutable npm content. */
export class PreviewBlocked extends Data.TaggedError("PreviewBlocked")<{
  readonly detail: string
}> {}

const refused = (detail: string) => new PreviewBlocked({ detail })

/** Validate the evidence shape; use the planner to check the authorization and consistency rules. */
export const parsePreviewEvidence = (
  input: unknown,
): Effect.Effect<PreviewEvidence, PreviewBlocked> =>
  Schema.decodeUnknownEffect(Snapshot, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => refused("Malformed preview evidence")),
  )
const normalized = (value: string) => value.toLowerCase()
const ownedTag = /^pr(?:-([1-9]\d*))?$/
const ownedVersion =
  /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-pr\.([1-9]\d*)\.\d{4}-\d\d-\d\d\.\d\d-\d\d-\d\d\.g[a-f0-9]{40}$/

const reviewAllows = (pull: Pull, reviewers: ReadonlySet<string>) => {
  const effective = new Map<string, Pull["reviews"][number]>()
  for (const review of pull.reviews) {
    const author = normalized(review.reviewer)
    if (
      author !== normalized(pull.author) &&
      reviewers.has(author) &&
      review.state !== "COMMENTED" &&
      review.state !== "PENDING"
    )
      effective.set(author, review)
  }
  const reviews = [...effective.values()]
  return (
    !reviews.some(({ state }) => state === "CHANGES_REQUESTED") &&
    reviews.some(({ sha, state }) => sha === pull.sha && state === "APPROVED")
  )
}

const inScope = (pull: Pull) => pull.open && (pull.base === "main" || pull.base === "dev")
const eligible = (pull: Pull, source: string, reviewers: ReadonlySet<string>) =>
  !pull.draft &&
  pull.sameRepository &&
  pull.head !== pull.base &&
  pull.controls?.source === source &&
  pull.controls.sha === pull.sha &&
  pull.controls.unchanged &&
  reviewAllows(pull, reviewers)

/** Version identity is bound to a PR number, canonical committer UTC, and the full HEAD SHA. */
export const previewVersion = (
  base: string,
  number: number,
  committerUtc: string,
  sha: string,
): string =>
  `${base}-pr.${number}.${committerUtc.slice(0, 10)}.${committerUtc.slice(11, 19).replaceAll(":", "-")}.g${sha}`

const canonicalDate = (input: string) => {
  const ms = Date.parse(input)
  return Number.isFinite(ms) && new Date(ms).toISOString().replace(".000Z", "Z") === input
}

const rank = (a: Pull, b: Pull) =>
  a.committerUtc < b.committerUtc ? 1 : a.committerUtc > b.committerUtc ? -1 : b.number - a.number

/** Decode and plan without credentials, I/O, trusting tags as proof, or selecting an older fallback. */
export const planPreview = (input: unknown): Effect.Effect<PreviewPlan, PreviewBlocked> =>
  Effect.gen(function* () {
    const s = yield* parsePreviewEvidence(input)
    if (!s.complete || !s.source.protected || s.source.sha !== s.source.checkout)
      return yield* refused("Require a complete snapshot and the current protected dev checkout")
    const reviewers = new Set(s.trustedReviewers.map(normalized))
    if (!reviewers.size || s.trustedReviewers.some((login) => !/^[A-Za-z0-9-]+$/.test(login)))
      return yield* refused("An explicit independent reviewer list is required")
    const ids = new Set<number>()
    for (const pull of s.candidates) {
      if (ids.has(pull.number) || !canonicalDate(pull.committerUtc))
        return yield* refused("Duplicate PR or invalid commit UTC")
      ids.add(pull.number)
    }

    const desired = new Map<string, string>()
    // Rank open heads even if we could not publish one. Do not quietly substitute an older PR.
    const selection = s.candidates.filter(inScope).toSorted(rank)
    const candidates: PreviewPlan["candidates"][number][] = []
    for (const pull of selection) {
      if (!eligible(pull, s.source.sha, reviewers)) {
        candidates.push({ number: pull.number, sha: pull.sha, version: null, status: "ineligible" })
        continue
      }
      if (!pull.baseVersion) return yield* refused("Missing base version for an eligible PR")
      const version = previewVersion(pull.baseVersion, pull.number, pull.committerUtc, pull.sha)
      const artifact = pull.artifact
      const reviewedCI = pull.validation.sha === pull.sha && pull.validation.state === "success"
      if (
        artifact?.sha === pull.sha &&
        artifact.registryIntegrity !== null &&
        artifact.registryIntegrity !== artifact.expectedIntegrity
      )
        return yield* refused(`Immutable npm bytes conflict for ${version}`)
      const ready = reviewedCI && artifact?.sha === pull.sha && artifact.registryIntegrity !== null
      candidates.push({
        number: pull.number,
        sha: pull.sha,
        version,
        status: ready ? "ready" : reviewedCI ? "waiting-artifact" : "waiting-validation",
      })
      if (ready) desired.set(`pr-${pull.number}`, version)
    }

    const first = candidates[0]
    if (first?.status === "ready" && first.version !== null) desired.set("pr", first.version)
    const changes: PreviewChange[] = []
    for (const [tag, version] of Object.entries(s.tags).sort(([a], [b]) => a.localeCompare(b))) {
      const named = ownedTag.exec(tag)
      if (!named) continue
      const owned = ownedVersion.exec(version)
      if (!owned || (named[1] !== undefined && named[1] !== owned[1]))
        return yield* refused(`Cannot establish ownership of existing tag ${tag}`)
      if (!desired.has(tag)) changes.push({ op: "remove", tag, previous: version })
    }
    for (const [tag, version] of desired)
      if (s.tags[tag] !== version) changes.push({ op: "add", tag, version })
    return { sourceSha: s.source.sha, selected: first?.number ?? null, candidates, changes }
  })

const read = (path: string) =>
  Effect.tryPromise({
    try: async (): Promise<unknown> => JSON.parse(await Bun.file(path).text()),
    catch: () => refused("Could not read the preview snapshot"),
  })

/** Compare trusted previews just before applying one operation and verify observed tag readback. */
export const verifyPreviewTransition = (
  before: unknown,
  after: unknown,
  operation: PreviewChange,
): Effect.Effect<void, PreviewBlocked> =>
  Effect.gen(function* () {
    const plan = yield* planPreview(before)
    const observed = yield* planPreview(after)
    const decode = Schema.decodeUnknownSync(Snapshot)
    const old = decode(before)
    const next = decode(after)
    if (
      plan.sourceSha !== observed.sourceSha ||
      plan.selected !== observed.selected ||
      JSON.stringify(plan.candidates) !== JSON.stringify(observed.candidates) ||
      !plan.changes.some((change) => JSON.stringify(change) === JSON.stringify(operation))
    )
      return yield* refused(
        "Promotion evidence moved or the requested tag operation was not planned",
      )
    const expected = { ...old.tags }
    if (operation.op === "add") expected[operation.tag] = operation.version
    else delete expected[operation.tag]
    const keys = new Set([...Object.keys(expected), ...Object.keys(next.tags)])
    if ([...keys].some((key) => expected[key] !== next.tags[key]))
      return yield* refused("Registry readback changed a different tag or did not complete")
  })

// This entry point only prints a plan. It must not be installed as a publisher.
if (import.meta.main) {
  const path = Bun.argv[2]
  await Effect.runPromise(
    (path && Bun.argv.length === 3
      ? read(path).pipe(Effect.flatMap(planPreview))
      : Effect.fail(refused("Usage: bun scripts/npm-preview.ts <complete-evidence.json>"))
    ).pipe(
      Effect.andThen((plan) => Console.log(JSON.stringify(plan, null, 2))),
      Effect.catch((error) =>
        Console.error(error.detail).pipe(
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
