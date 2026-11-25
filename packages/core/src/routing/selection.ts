import type { Config, ConfigFile, PiProvider } from "../config/schema.ts"
import type { AgentHost } from "../domain/host.ts"
import { type RoleTask, routeFor } from "../domain/route.ts"
import {
  enabledPiProviders,
  enabledProviderRoute,
  PROVIDERS,
  routeModel,
  subagentModel,
} from "../pi/provider.ts"
import { AA_PI_COMPARISON, type Candidate, selectRoute } from "./evidence.ts"

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

/** The authenticated model catalog supplied by Pi, never by tool arguments. */
export type PiRoutingAvailability = ReadonlyArray<{
  readonly provider: string
  readonly id: string
}>

/** Explicit provider enablement takes the exact-launch path even without a selected cost profile. */
export const piRoutingProfile = (pi: Pick<Config["pi"], "providers" | "profile">) =>
  pi.profile ?? (pi.providers === undefined ? undefined : "normal")

/** Select a role's configured evidence winner, or the existing explicitly unscored policy. */
export const selectConfiguredRoute = (
  config: Config,
  written: ConfigFile,
  host: AgentHost,
  role: RoleTask,
  screen: boolean,
  profile: "normal" | "fast",
  now: string,
  available?: PiRoutingAvailability,
): RoutingSelection => {
  const settings = config.routing
  const override = host === "pi" ? written.pi?.routes?.[role] : undefined
  const explicit = host === "pi" && config.pi.providers !== undefined
  const enabled = enabledPiProviders(config)
  const mixed = explicit && enabled.length > 1
  const hasModel = (provider: string, id: string) =>
    available?.some((entry) => entry.provider === provider && entry.id === id)
  const screenCompatible = (route: ReturnType<typeof routeModel>) =>
    !screen ||
    ((override?.model === undefined || override.model === route.model) &&
      (override?.thinking === undefined || override.thinking === route.thinking))
  const pool = !explicit
    ? host === "pi"
      ? [routeModel(config, role, { screen })]
      : []
    : enabled
        .filter((provider) => override?.provider === undefined || override.provider === provider)
        .toSorted()
        .map((provider) => enabledProviderRoute(role, provider, override, screen))
  const excludedByDeclaration = (route: ReturnType<typeof routeModel>) =>
    settings?.candidates.some(
      (candidate) =>
        candidate.availability === "no" &&
        candidate.harness === host &&
        candidate.role === role &&
        candidate.tier === profile &&
        candidate.provider !== "anthropic" &&
        PROVIDERS[candidate.provider].id === route.provider &&
        candidate.model === route.model &&
        candidate.effort === route.thinking,
    ) ?? false
  const eligible = pool.filter(
    (route) =>
      screenCompatible(route) &&
      (!explicit || !excludedByDeclaration(route)) &&
      (available === undefined || hasModel(route.provider, route.model)),
  )
  // Unscored policy rotates by role across confirmed routes, not checkbox order or a global default.
  const roleOffset = Array.from(role).reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const ambiguousOffline = mixed && available === undefined && override?.provider === undefined
  const base =
    ambiguousOffline || eligible.length === 0 ? undefined : eligible[roleOffset % eligible.length]
  const fallback = {
    provider: base?.provider ?? (host === "pi" ? "" : "anthropic"),
    model: base === undefined ? (host === "pi" ? "" : routeFor(role).model) : subagentModel(base),
    effort: base?.thinking ?? (host === "pi" ? "" : routeFor(role).effort),
  }
  const fallbackError =
    host !== "pi" || base !== undefined
      ? undefined
      : override?.provider !== undefined && !enabled.includes(override.provider)
        ? "The explicit Pi route uses a disabled provider; enable it or change the route."
        : pool.length > 0 && pool.every((route) => !screenCompatible(route))
          ? "The explicit Pi route conflicts with the screen model or minimum thinking; choose a screen-compatible route."
          : ambiguousOffline
            ? "Several Pi providers are enabled but the current Pi model catalog could not be read. Dispatch through Pi or set an explicit role provider."
            : "No enabled Pi provider has the exact role model available with configured authentication. Check the route and sign in through Pi."
  const policy = (reason: string): RoutingSelection => ({
    ...fallback,
    profile,
    kind: "unscored-policy",
    coverage: "pending",
    ...(config.routing === undefined ? {} : { evidenceRevision: config.routing.evidence.revision }),
    reason,
    ...(fallbackError === undefined ? {} : { error: fallbackError }),
  })
  if (ambiguousOffline)
    return policy("Benchmark evidence cannot establish current Pi model availability.")
  const benchmarks =
    settings?.benchmarks.filter((item) => item.role === role && item.harness === host) ?? []
  const declared = benchmarks[0]
  const benchmark = mixed
    ? {
        ...AA_PI_COMPARISON,
        requiredCapabilities: benchmarks.length === 1 ? (declared?.requiredCapabilities ?? []) : [],
      }
    : declared
  const evidenceName = mixed ? "Artificial Analysis Pi Index" : "subscription"
  if (settings === undefined)
    return policy(`No ${evidenceName} evidence configured; routing policy is unscored.`)
  if (
    (!mixed && benchmarks.length !== 1) ||
    benchmark === undefined ||
    !benchmark.benchmark ||
    !benchmark.benchmarkVersion ||
    !benchmark.benchmarkHarness ||
    !benchmark.qualityUnit
  )
    return policy("No unique comparable role benchmark; routing policy is unscored.")
  const configuredProviders = new Set(enabled)
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
      const route =
        host === "pi" && compatibleProvider && candidate.provider !== "anthropic"
          ? enabledProviderRoute(
              role,
              candidate.provider,
              { model: candidate.model, thinking: candidate.effort },
              screen,
            )
          : undefined
      const compatibleScreen =
        !explicit ||
        route === undefined ||
        (route.model === candidate.model && route.thinking === candidate.effort)
      return {
        ...candidate,
        availability:
          route !== undefined && hasModel(route.provider, candidate.model) === false
            ? "no"
            : candidate.availability,
        requiredCapabilities: [...candidate.requiredCapabilities, "configured-route"],
        capabilities: {
          ...candidate.capabilities,
          "configured-route":
            compatibleProvider && compatibleEffort && compatibleOverride && compatibleScreen
              ? "yes"
              : "no",
        },
      }
    })
  const comparison = {
    ...(mixed ? { objective: "pi-index" as const } : {}),
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
      `No eligible comparable ${evidenceName} evidence; routing policy is unscored${reasons.length === 0 ? "; no declared candidates" : `; ${reasons.join(", ")}`}.`,
    )
  }
  const selected = decision.candidate
  const evidence = settings.evidence.rows.find(
    (row) =>
      (mixed ? row.costKind === "quality-only" : row.costKind !== "quality-only") &&
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
          measuredAt: evidence.measuredAt,
          ...(evidence.costKind === "quality-only"
            ? {}
            : { monthlyUsd: evidence.monthlyUsd, taskCostUsd: evidence.taskCostUsd }),
        }),
    reason: mixed
      ? `Exact ${evidenceName} v${benchmark.benchmarkVersion} quality; no comparable subscription cost.`
      : `Configured declarations; entitlement unknown; benchmark proxy ${benchmark.benchmarkHarness}.`,
  }
}
