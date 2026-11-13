import { Effect, Schema, SchemaGetter } from "effect"

import { RoleTask } from "../domain/route.ts"
import { CODEX_ROUTES } from "../pi/codex/routes.ts"
import { EvidenceDataset } from "../routing/evidence.ts"
import { CAPABILITIES, type CapabilityFeature } from "./capabilities.ts"

/**
 * An optional key whose absence decodes to the default. The key stays optional on the encoded side,
 * so `Schema.toEncoded` of a schema built with it describes a config file that may leave the key
 * out, and the project and user files can be merged before the defaults fill the gaps.
 */
const defaulted = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))

/** The `vcs` section of `.holyagent/config.json`. */
export const VcsSettings = Schema.Struct({
  /** No longer used: commits always go through git. Accepted so an older config file still reads. */
  api: Schema.optionalKey(Schema.Boolean),
  /** Phrases of the message check that this project's domain uses legitimately. */
  allowWords: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * No longer used: only git config `holyagent.stateBranch` names the state branch, since a file of
   * the repository must not pick the branch the commands commit on. Accepted so a file that has it
   * still reads.
   */
  stateBranch: Schema.optionalKey(Schema.String),
})
/** The `vcs` section of `.holyagent/config.json`. */
export type VcsSettings = typeof VcsSettings.Type

/**
 * The model providers the `pi` section can select. `kimi-coding-global`, the default, is Pi's
 * built-in `kimi-coding` with `pi-provider-kimi-code` on top and `KIMI_CODE_REGION` set to
 * `global`. `openai-codex` is HolyAgent's Codex provider: Pi's built-in ChatGPT-subscription
 * provider of that name, with no package on top (see `pi/codex/`).
 */
export const PiProvider = Schema.Literals(["kimi-coding-global", "openai-codex"])
/** One model provider of the `pi` section. */
export type PiProvider = typeof PiProvider.Type

/** Reasoning levels that Pi's `--thinking` flag takes. */
export const Thinking = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
/** One reasoning level. */
export type Thinking = typeof Thinking.Type

/**
 * A model id as the provider names it, such as `kimi-for-coding` or `kimi-coding/kimi-for-coding`:
 * a letter or digit first (so the id is never read as a flag), then letters, digits and `.`, `_`,
 * `-`, `:`, `/`, `@` and `+` (some providers' ids carry the last two), up to 128 characters. The id
 * reaches `--model`, the model's context and the user's terminal in notices, so a control
 * character, space or quote is refused when the config is decoded. It is also checked against the
 * user's catalog at launch.
 */
const ModelId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/))

/** The id of a route-table row: the root, or one of the specialists. */
export type RouteKey = "root" | RoleTask

/** The model and reasoning level of one route-table row. */
export interface RouteChoice {
  /** A per-role provider override; absent uses the section's provider. */
  readonly provider?: PiProvider
  readonly model: string
  readonly thinking: Thinking
}

const KIMI_ROOT = "k3.1-pro"
const KIMI_SPECIALIST = "kimi-for-coding"

const kimi = (model: string, thinking: Thinking): RouteChoice => ({ model, thinking })

/**
 * The default route table, the Kimi table of `docs/pi/providers.md`: the root on `k3.1-pro` at
 * high; the specialists that write or judge code on `kimi-for-coding` at max, the mechanical,
 * checking, lookup and research ones at high, never low; the two visual specialists on `k3.1-pro`
 * at low.
 */
export const KIMI_ROUTES: Readonly<Record<RouteKey, RouteChoice>> = {
  // plans, decides and makes the final pass; max is selectable
  root: kimi(KIMI_ROOT, "high"),
  // reads and reports the layout
  "Explorer.map": kimi(KIMI_SPECIALIST, "high"),
  // answers a narrow question from files
  "Explorer.lookup": kimi(KIMI_SPECIALIST, "high"),
  // follows one flow through the code
  "Explorer.trace": kimi(KIMI_SPECIALIST, "high"),
  // fetches one fact from documentation
  "Librarian.lookup": kimi(KIMI_SPECIALIST, "high"),
  // gathers and compares sources
  "Librarian.research": kimi(KIMI_SPECIALIST, "high"),
  // bounded edits with a known recipe
  "Worker.mechanical": kimi(KIMI_SPECIALIST, "high"),
  // writes the change that gets merged
  "Worker.implementation": kimi(KIMI_SPECIALIST, "max"),
  // spans several systems and contracts
  "Worker.integration": kimi(KIMI_SPECIALIST, "max"),
  // runs commands along a documented procedure
  "Worker.operations": kimi(KIMI_SPECIALIST, "high"),
  // runs the gates and reports their output
  "Worker.validation": kimi(KIMI_SPECIALIST, "high"),
  // root-cause work needs the deepest reasoning
  "Worker.debugging": kimi(KIMI_SPECIALIST, "max"),
  // the root makes the final visual pass
  "Worker.visual": kimi(KIMI_ROOT, "low"),
  // the root makes the final visual pass
  "Reviewer.visual": kimi(KIMI_ROOT, "low"),
  // a missed defect costs more than the tokens
  "Reviewer.code": kimi(KIMI_SPECIALIST, "max"),
  // judges whether the tests prove the behavior
  "Reviewer.testing": kimi(KIMI_SPECIALIST, "max"),
  // checks records against evidence
  "Reviewer.audit": kimi(KIMI_SPECIALIST, "high"),
  // judges trust boundaries
  "Reviewer.security": kimi(KIMI_SPECIALIST, "max"),
  // judges instruction text against its requirements
  "Reviewer.artifact": kimi(KIMI_SPECIALIST, "max"),
}

/**
 * The default route table of each provider: what a config that sets no route resolves to, and the
 * rows a partial `pi.routes` keeps for the keys it leaves out.
 */
export const PROVIDER_ROUTES: Readonly<
  Record<PiProvider, Readonly<Record<RouteKey, RouteChoice>>>
> = {
  "kimi-coding-global": KIMI_ROUTES,
  "openai-codex": CODEX_ROUTES,
}

/**
 * One route-table row as a config file writes it: either key may be left out, and the selected
 * provider's table fills it (see `PiSection`), since the default depends on `pi.provider`.
 */
const route = () =>
  defaulted(
    Schema.Struct({
      provider: Schema.optionalKey(PiProvider),
      model: Schema.optionalKey(ModelId),
      thinking: Schema.optionalKey(Thinking),
    }),
    {},
  )

/**
 * One schema per route-table row, made from the keys of {@link KIMI_ROUTES}, so the list of rows
 * exists once. The cast only restores the per-key shape that `Object.fromEntries` widens.
 */
const ROUTE_FIELDS = Object.fromEntries(Object.keys(KIMI_ROUTES).map((key) => [key, route()])) as {
  readonly [Key in RouteKey]: ReturnType<typeof route>
}

/**
 * How a session reaches the web: `provider` permits installed native tools, `pi-web-kit` explicitly
 * loads the fallback package, and `off` has no web tools. No mode enables a provider's tools.
 */
export const WebMode = Schema.Literals(["provider", "pi-web-kit", "off"])
/** One web mode. */
export type WebMode = typeof WebMode.Type

/** How the `codemode` tool presents other tools: next to them (`on`) or instead of them (`only`). */
export const CodemodeMode = Schema.Literals(["on", "only"])
/** One codemode mode. */
export type CodemodeMode = typeof CodemodeMode.Type

/** Where setup writes the T3 Code settings: for every project, or as overrides of this one. */
export const T3Scope = Schema.Literals(["global", "project"])
/** One T3 settings scope. */
export type T3Scope = typeof T3Scope.Type

const Enabled = Schema.Boolean

/**
 * The policy text of the Codex provider's auto-review (`pi.autoReview`), as Codex's `[auto_review]`
 * table has it: `policy` replaces the default policy, `extraPolicy` is added after whichever policy
 * stands. Both are markdown the reviewer reads; a blank value counts as absent. Only the user-level
 * config sets them: auto-review is a security control, so a project file's value is ignored.
 */
const AutoReviewPolicy = Schema.Struct({
  policy: Schema.optionalKey(Schema.String),
  extraPolicy: Schema.optionalKey(Schema.String),
})

const capabilitySwitch = (on: boolean) => defaulted(Enabled, on)

/**
 * The switch of each optional capability in `pi.features`, each with the default its registry entry
 * names (see `CAPABILITIES`): a capability added there is a key here.
 */
const CAPABILITY_FIELDS = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability.feature, capabilitySwitch(capability.defaultOn)]),
) as { readonly [F in CapabilityFeature]: ReturnType<typeof capabilitySwitch> }

const PI_FIELDS = {
  enable: defaulted(Enabled, true),
  provider: defaulted(PiProvider, "kimi-coding-global"),
  profile: Schema.optionalKey(Schema.Literals(["normal", "fast"])),
  routes: defaulted(Schema.Struct(ROUTE_FIELDS), {}),
  features: defaulted(
    Schema.Struct({
      web: defaulted(WebMode, "provider"),
      ...CAPABILITY_FIELDS,
    }),
    {},
  ),
  codemode: defaulted(
    Schema.Struct({
      mode: defaulted(CodemodeMode, "only"),
      maxWorkers: defaulted(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })), 4),
    }),
    {},
  ),
  t3: defaulted(
    Schema.Struct({
      scope: defaulted(T3Scope, "global"),
      worktrees: defaulted(Enabled, true),
      deviceAccess: defaulted(Enabled, true),
    }),
    {},
  ),
  autoReview: defaulted(AutoReviewPolicy, {}),
}

/** The `pi` section as a file writes it: route rows may still lack a model or a thinking level. */
const PiAsWritten = Schema.Struct(PI_FIELDS)

/** The `pi` section with every route row complete, which is what the program reads. */
const PiResolved = Schema.toType(
  Schema.Struct({
    ...PI_FIELDS,
    routes: Schema.Struct(
      Object.fromEntries(
        Object.keys(KIMI_ROUTES).map((key) => [
          key,
          Schema.Struct({
            provider: Schema.optionalKey(PiProvider),
            model: Schema.String,
            thinking: Thinking,
          }),
        ]),
      ) as {
        readonly [Key in RouteKey]: Schema.Struct<{
          provider: Schema.optionalKey<typeof PiProvider>
          model: Schema.String
          thinking: typeof Thinking
        }>
      },
    ),
  }),
)

/**
 * Fills each route row's missing model and thinking level from the default table of the selected
 * provider, so a file that selects `openai-codex` and sets no route gets the Codex rows, and one
 * that overrides a single key keeps the provider's value for the other.
 */
const withProviderRoutes = (pi: typeof PiAsWritten.Type): typeof PiResolved.Encoded => {
  const defaults = PROVIDER_ROUTES[pi.provider]
  const routes = Object.fromEntries(
    (Object.keys(defaults) as Array<RouteKey>).map((key) => [
      key,
      (() => {
        const override = pi.routes[key]
        const provider = override.provider ?? pi.provider
        const baseline = PROVIDER_ROUTES[provider][key]
        const profileModel =
          pi.profile === "fast" && key === "root" && provider === "openai-codex"
            ? "gpt-6.1-terra"
            : baseline.model
        return {
          ...(override.provider === undefined ? {} : { provider: override.provider }),
          model: override.model ?? profileModel,
          thinking: override.thinking ?? baseline.thinking,
        }
      })(),
    ]),
  ) as typeof PiResolved.Encoded.routes
  return { ...pi, routes }
}

/** The `pi` section: read only by the Pi integration. */
const PiSection = defaulted(
  PiAsWritten.pipe(
    Schema.decodeTo(PiResolved, {
      decode: SchemaGetter.transform(withProviderRoutes),
      encode: SchemaGetter.transform((pi) => pi),
    }),
  ),
  {},
)

/** A declared candidate is a configured allowlist entry, not a live entitlement check. */
const DeclaredCandidate = Schema.Struct({
  role: RoleTask,
  harness: Schema.Literals(["pi", "claude"]),
  provider: Schema.Literals(["kimi-coding-global", "openai-codex", "anthropic"]),
  model: ModelId,
  effort: Thinking,
  plan: Schema.String,
  tier: Schema.Literals(["normal", "fast"]),
  availability: Schema.Literals(["yes", "no", "unknown"]),
  capabilities: Schema.Record(Schema.String, Schema.Literals(["yes", "no", "unknown"])),
  requiredCapabilities: Schema.Array(Schema.String),
  identityStable: Schema.Boolean,
})

/** The exact benchmark and required model capabilities for one role and harness. */
const RoutingBenchmark = Schema.Struct({
  role: RoleTask,
  harness: Schema.Literals(["pi", "claude"]),
  benchmark: Schema.String,
  benchmarkVersion: Schema.String,
  benchmarkHarness: Schema.String,
  qualityUnit: Schema.String,
  requiredCapabilities: Schema.Array(Schema.String),
})

/** Opt-in, versioned subscription evidence and declared candidate allowlist. */
export const RoutingSettings = Schema.Struct({
  version: Schema.Literal(1),
  evidence: EvidenceDataset,
  candidates: Schema.Array(DeclaredCandidate),
  benchmarks: Schema.Array(RoutingBenchmark),
  maxAgeDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
})
/** One configured subscription routing dataset. */
export type RoutingSettings = typeof RoutingSettings.Type

/** The `claude` section: read only by the Claude plugin. It holds no option yet. */
const ClaudeSection = defaulted(Schema.Record(Schema.String, Schema.Never), {})

/**
 * The HolyAgent config as the program uses it: every setting present, from the file or from its
 * default. Decode a merged config file with it. Settings common to both hosts sit outside the `pi`
 * and `claude` sections.
 */
export const Config = Schema.Struct({
  vcs: defaulted(VcsSettings, {}),
  pi: PiSection,
  claude: ClaudeSection,
  routing: Schema.optionalKey(RoutingSettings),
})
/** The HolyAgent config with every default filled in. */
export type Config = typeof Config.Type

/**
 * The shape of one `config.json`, the user's or the project's: the same keys as {@link Config}, each
 * optional. Decode a file with it before merging, so a setting the file leaves out never overrides
 * the other file's value with a default.
 */
export const ConfigFile = Schema.toEncoded(Config)
/** One `config.json` as decoded, before the merge and the defaults. */
export type ConfigFile = typeof ConfigFile.Type

/**
 * The config every setting of which is at its default: what a missing file means. It is an Effect
 * so that building it at import cannot throw; it succeeds for every build of the schema.
 */
export const defaultConfig = Schema.decodeUnknownEffect(Config)({})
