import type { Config, ConfigFile, PiProvider } from "../config/schema.ts"
import type { AgentHost } from "../domain/host.ts"
import { type RoleTask, routeFor } from "../domain/route.ts"
import { PROVIDERS, routeModel, subagentModel } from "../pi/provider.ts"
import { type Candidate, selectRoute } from "./evidence.ts"

/** The role launch selected from declared configuration and its evidence diagnostics. */
export interface RoutingSelection {
  readonly provider: string
  readonly model: string
  readonly effort: string
  readonly profile: "normal" | "fast"
  readonly kind: "ranked" | "unscored-policy"
  readonly score?: number
  readonly coverage: "complete" | "pending"
  readonly evidenceRevision?: string
  readonly plan?: string
  readonly monthlyUsd?: number
  readonly taskCostUsd?: number
  readonly measuredAt?: string
  readonly reason: string
  /** The call must not be launched if the explicit route conflicts with a screen policy. */
  readonly error?: string
}

/** Select a role's configured evidence winner, or the existing explicitly unscored policy. */
export const selectConfiguredRoute = (
  config: Config,
  written: ConfigFile,
  host: AgentHost,
  role: RoleTask,
  screen: boolean,
  profile: "normal" | "fast",
  now: string,
): RoutingSelection => {
  const override = host === "pi" ? written.pi?.routes?.[role] : undefined
  const base = host === "pi" ? routeModel(config, role, { screen }) : undefined
  const fallback = {
    provider: base?.provider ?? "anthropic",
    model: base === undefined ? routeFor(role).model : subagentModel(base),
    effort: base?.thinking ?? routeFor(role).effort,
  }
  const screenConflict =
    screen &&
    override !== undefined &&
    ((override.model !== undefined && override.model !== base?.model) ||
      (override.thinking !== undefined && override.thinking !== base?.thinking))
  const policy = (reason: string): RoutingSelection => ({
    ...fallback,
    profile,
    kind: "unscored-policy",
    coverage: "pending",
    ...(config.routing === undefined ? {} : { evidenceRevision: config.routing.evidence.revision }),
    reason,
    ...(screenConflict
      ? {
          error:
            "The explicit Pi route conflicts with the screen model or minimum thinking; choose a screen-compatible route.",
        }
      : {}),
  })
  const settings = config.routing
  if (settings === undefined)
    return policy("No subscription evidence configured; existing policy is unscored.")
  const benchmarks = settings.benchmarks.filter(
    (item) => item.role === role && item.harness === host,
  )
  const benchmark = benchmarks[0]
  if (
    benchmarks.length !== 1 ||
    benchmark === undefined ||
    !benchmark.benchmark ||
    !benchmark.benchmarkVersion ||
    !benchmark.benchmarkHarness ||
    !benchmark.qualityUnit
  )
    return policy("No unique comparable role benchmark; existing policy is unscored.")
  const configuredProviders = new Set([
    config.pi.provider,
    ...Object.values(config.pi.routes).flatMap((row) =>
      row.provider === undefined ? [] : [row.provider],
    ),
  ])
  const candidates: Candidate[] = settings.candidates
    .filter(
      (candidate) =>
        candidate.role === role && candidate.harness === host && candidate.tier === profile,
    )
    .map((candidate) => {
      const compatibleProvider =
        host === "pi"
          ? candidate.provider !== "anthropic" && configuredProviders.has(candidate.provider)
          : candidate.provider === "anthropic" &&
            ["sonnet", "opus", "haiku", "fable"].includes(candidate.model)
      const compatibleEffort =
        host === "pi"
          ? !(
              candidate.model === "gpt-6.1-terra" &&
              !["low", "medium", "high", "xhigh"].includes(candidate.effort)
            ) && !(screen && ["off", "minimal", "low"].includes(candidate.effort))
          : ["medium", "high", "xhigh"].includes(candidate.effort)
      const compatibleOverride =
        override === undefined ||
        ((override.provider === undefined || override.provider === candidate.provider) &&
          (override.model === undefined || override.model === candidate.model) &&
          (override.thinking === undefined || override.thinking === candidate.effort))
      return {
        ...candidate,
        requiredCapabilities: [...candidate.requiredCapabilities, "configured-route"],
        capabilities: {
          ...candidate.capabilities,
          "configured-route":
            compatibleProvider && compatibleEffort && compatibleOverride ? "yes" : "no",
        },
      }
    })
  const comparison = {
    role,
    harness: host,
    tier: profile,
    benchmark: benchmark.benchmark,
    benchmarkVersion: benchmark.benchmarkVersion,
    benchmarkHarness: benchmark.benchmarkHarness,
    qualityUnit: benchmark.qualityUnit,
    now,
    maxAgeDays: settings.maxAgeDays,
    requiredCapabilities: [
      ...new Set(["tools", ...benchmark.requiredCapabilities, ...(screen ? ["vision"] : [])]),
    ],
  }
  // Fallback is reported separately below; it is not asserted to have the required capabilities.
  const decision = selectRoute(settings.evidence, candidates, comparison, {
    role,
    harness: host,
    provider: "",
    model: "",
    effort: "",
    plan: "",
    tier: profile,
    availability: "unknown",
    capabilities: {},
    requiredCapabilities: [],
    identityStable: false,
  })
  if (decision.kind !== "ranked") {
    const reasons = decision.diagnostics
      .flatMap((item) => item.reasons.map((reason) => `${item.candidate.model}:${reason}`))
      .slice(0, 3)
    return policy(
      `No eligible comparable subscription evidence; existing policy is unscored${reasons.length === 0 ? "; no declared candidates" : `; ${reasons.join(", ")}`}.`,
    )
  }
  const selected = decision.candidate
  const evidence = settings.evidence.rows.find(
    (row) =>
      row.role === role &&
      row.harness === host &&
      row.tier === profile &&
      row.provider === selected.provider &&
      row.model === selected.model &&
      row.effort === selected.effort &&
      row.plan === selected.plan &&
      row.benchmark === benchmark.benchmark &&
      row.benchmarkVersion === benchmark.benchmarkVersion &&
      row.benchmarkHarness === benchmark.benchmarkHarness &&
      row.qualityUnit === benchmark.qualityUnit,
  )
  const provider = host === "pi" ? PROVIDERS[selected.provider as PiProvider].id : "anthropic"
  return {
    provider,
    model: host === "pi" ? `${provider}/${selected.model}` : selected.model,
    effort: selected.effort,
    profile,
    kind: "ranked",
    score: decision.score,
    coverage: decision.optimization,
    evidenceRevision: settings.evidence.revision,
    plan: selected.plan,
    ...(evidence === undefined
      ? {}
      : {
          monthlyUsd: evidence.monthlyUsd,
          taskCostUsd: evidence.taskCostUsd,
          measuredAt: evidence.measuredAt,
        }),
    reason: `Configured declarations; entitlement unknown; benchmark proxy ${benchmark.benchmarkHarness}.`,
  }
}
