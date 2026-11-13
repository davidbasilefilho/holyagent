import { type Effect, Schema } from "effect"

/** Versioned evidence imported from a subscription benchmark, never an API-price estimate. */
export const EvidenceDataset = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.String,
  retrievedAt: Schema.String,
  generatedAt: Schema.String,
  rows: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      harness: Schema.String,
      provider: Schema.String,
      model: Schema.String,
      effort: Schema.String,
      plan: Schema.String,
      region: Schema.String,
      monthlyUsd: Schema.Number,
      allowance: Schema.String,
      utilization: Schema.String,
      cacheAssumptions: Schema.String,
      tier: Schema.Literals(["normal", "fast"]),
      benchmark: Schema.String,
      benchmarkVersion: Schema.String,
      benchmarkHarness: Schema.String,
      qualityUnit: Schema.String,
      direction: Schema.Literals(["higher", "lower"]),
      quality: Schema.Number,
      taskCostUsd: Schema.Number,
      costKind: Schema.Literals(["subscription", "api-fallback"]),
      measuredAt: Schema.String,
      sourceUrl: Schema.String,
      planSourceUrl: Schema.String,
      planSourceDate: Schema.String,
      confidence: Schema.String,
    }),
  ),
})
/** A decoded immutable evidence snapshot. */
export type EvidenceDataset = typeof EvidenceDataset.Type

/** Candidate identity and configured declarations; they do not prove live entitlement. */
export interface Candidate {
  readonly role: string
  readonly harness: string
  readonly provider: string
  readonly model: string
  readonly effort: string
  readonly plan: string
  readonly tier: "normal" | "fast"
  readonly availability: "yes" | "no" | "unknown"
  readonly capabilities: Readonly<Record<string, "yes" | "no" | "unknown">>
  readonly requiredCapabilities: ReadonlyArray<string>
  /** Mutable aliases cannot be compared without an observed concrete identity. */
  readonly identityStable: boolean
}

/** A candidate remains visible even when its score cannot be established. */
export interface RankedCandidate {
  readonly candidate: Candidate
  readonly eligibility: "eligible" | "excluded" | "unknown"
  readonly reasons: ReadonlyArray<string>
  readonly score?: number
}

/** Decode an imported dataset, rejecting unexpected fields at the data boundary. */
export const importEvidence = (
  input: unknown,
): Effect.Effect<EvidenceDataset, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(EvidenceDataset, { onExcessProperty: "error" })(input)

/**
 * Rank candidates on the requested comparable benchmark. Missing or stale data is not a zero. `now`
 * and `maxAgeDays` make the freshness policy explicit and reproducible.
 */
export const rankCandidates = (
  dataset: EvidenceDataset,
  candidates: ReadonlyArray<Candidate>,
  comparison: {
    readonly role: string
    readonly harness: string
    readonly tier: "normal" | "fast"
    readonly benchmark: string
    readonly benchmarkVersion: string
    readonly benchmarkHarness: string
    readonly qualityUnit: string
    readonly now: string
    readonly maxAgeDays: number
    readonly requiredCapabilities: ReadonlyArray<string>
  },
): {
  readonly candidates: ReadonlyArray<RankedCandidate>
  readonly optimization: "complete" | "pending"
} => {
  const now = Date.parse(comparison.now)
  const fresh = (date: string) => {
    const age = now - Date.parse(date)
    return Number.isFinite(age) && age >= 0 && age <= comparison.maxAgeDays * 86_400_000
  }
  const evaluated = candidates.map((candidate) => {
    const reasons: Array<string> = []
    let unknown = false
    if (
      candidate.role !== comparison.role ||
      candidate.harness !== comparison.harness ||
      candidate.tier !== comparison.tier
    )
      reasons.push("noncomparable_candidate")
    if (candidate.availability !== "yes") {
      reasons.push(`availability_${candidate.availability}`)
      unknown ||= candidate.availability === "unknown"
    }
    for (const capability of new Set([
      ...comparison.requiredCapabilities,
      ...candidate.requiredCapabilities,
    ])) {
      const state = candidate.capabilities[capability] ?? "unknown"
      if (state !== "yes") {
        reasons.push(`capability_${capability}_${state}`)
        unknown ||= state === "unknown"
      }
    }
    if (!candidate.identityStable) reasons.push("unstable_identity")
    const rows = dataset.rows.filter(
      (row) =>
        row.role === candidate.role &&
        row.harness === candidate.harness &&
        row.provider === candidate.provider &&
        row.model === candidate.model &&
        row.effort === candidate.effort &&
        row.plan === candidate.plan &&
        row.tier === candidate.tier &&
        row.benchmark === comparison.benchmark &&
        row.benchmarkVersion === comparison.benchmarkVersion &&
        row.benchmarkHarness === comparison.benchmarkHarness &&
        row.qualityUnit === comparison.qualityUnit,
    )
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      reasons.push(rows.length === 0 ? "missing_evidence" : "ambiguous_evidence")
    else {
      if (
        !fresh(dataset.retrievedAt) ||
        !fresh(dataset.generatedAt) ||
        !fresh(row.measuredAt) ||
        !fresh(row.planSourceDate)
      )
        reasons.push("stale_evidence")
      if (row.costKind !== "subscription") reasons.push("api_price_fallback")
      if (row.monthlyUsd > (comparison.tier === "normal" ? 100 : 20))
        reasons.push("plan_exceeds_target")
      if (
        row.direction !== "higher" ||
        !Number.isFinite(row.quality) ||
        row.quality < 0 ||
        !Number.isFinite(row.taskCostUsd) ||
        row.taskCostUsd <= 0 ||
        !/^https?:\/\/\S+$/i.test(row.sourceUrl) ||
        !/^https?:\/\/\S+$/i.test(row.planSourceUrl) ||
        !row.confidence.trim() ||
        !row.region.trim() ||
        !row.allowance.trim() ||
        !row.utilization.trim() ||
        !row.cacheAssumptions.trim() ||
        !candidate.plan.trim() ||
        !row.benchmark.trim() ||
        !row.benchmarkVersion.trim() ||
        !row.benchmarkHarness.trim() ||
        !row.qualityUnit.trim() ||
        !Number.isFinite(row.monthlyUsd) ||
        row.monthlyUsd <= 0 ||
        !dataset.revision.trim()
      )
        reasons.push("noncomparable_evidence")
    }
    const value = row === undefined ? 0 : row.quality / row.taskCostUsd
    if (reasons.length === 0 && !Number.isFinite(value)) reasons.push("noncomparable_evidence")
    return { candidate, reasons, unknown, value }
  })
  const max = Math.max(
    0,
    ...evaluated.filter((item) => item.reasons.length === 0).map((item) => item.value),
  )
  return {
    candidates: evaluated.map(({ candidate, reasons, unknown, value }) =>
      reasons.length > 0
        ? { candidate, eligibility: unknown ? "unknown" : "excluded", reasons }
        : { candidate, eligibility: "eligible", reasons, score: max === 0 ? 0 : value / max },
    ),
    optimization: evaluated.some(({ reasons }) => reasons.length > 0) ? "pending" : "complete",
  }
}

/** A scored selection or the caller's deliberately separate, unscored policy route. */
export type RouteDecision =
  | {
      readonly kind: "ranked"
      readonly candidate: Candidate
      readonly score: number
      readonly optimization: "complete" | "pending"
      readonly diagnostics: ReadonlyArray<RankedCandidate>
    }
  | {
      readonly kind: "unscored-policy"
      readonly candidate: Candidate
      readonly optimization: "pending"
      readonly diagnostics: ReadonlyArray<RankedCandidate>
    }
  | {
      readonly kind: "unavailable"
      readonly reasons: ReadonlyArray<string>
      readonly optimization: "pending"
      readonly diagnostics: ReadonlyArray<RankedCandidate>
    }

/** Select the highest eligible score, or a separately identified policy fallback. */
export const selectRoute = (
  dataset: EvidenceDataset,
  candidates: ReadonlyArray<Candidate>,
  comparison: Parameters<typeof rankCandidates>[2],
  policy: Candidate,
): RouteDecision => {
  const ranked = rankCandidates(dataset, candidates, comparison)
  const winner = ranked.candidates
    .filter((item) => item.eligibility === "eligible" && item.score !== undefined)
    .toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
  if (winner?.score !== undefined)
    return {
      kind: "ranked",
      candidate: winner.candidate,
      score: winner.score,
      optimization: ranked.optimization,
      diagnostics: ranked.candidates,
    }
  const reasons = [
    ...(policy.role === comparison.role &&
    policy.harness === comparison.harness &&
    policy.tier === comparison.tier
      ? []
      : ["noncomparable_policy"]),
    ...(policy.availability === "yes" ? [] : [`availability_${policy.availability}`]),
    ...[...new Set([...comparison.requiredCapabilities, ...policy.requiredCapabilities])].flatMap(
      (capability) =>
        policy.capabilities[capability] === "yes"
          ? []
          : [`capability_${capability}_${policy.capabilities[capability] ?? "unknown"}`],
    ),
  ]
  return reasons.length > 0
    ? { kind: "unavailable", reasons, optimization: "pending", diagnostics: ranked.candidates }
    : {
        kind: "unscored-policy",
        candidate: policy,
        optimization: "pending",
        diagnostics: ranked.candidates,
      }
}
