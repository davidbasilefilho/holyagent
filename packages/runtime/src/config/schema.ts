import { Effect, Schema } from "effect"

import type { RoleTask } from "../domain/route.ts"

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
 * The model providers the `pi` section can select. Kimi for Coding (global) is the only one in
 * 0.3.0: Pi's built-in `kimi-coding` with `pi-provider-kimi-code` on top and `KIMI_CODE_REGION` set
 * to `global`.
 */
export const PiProvider = Schema.Literals(["kimi-coding-global"])
/** One model provider of the `pi` section. */
export type PiProvider = typeof PiProvider.Type

/** Reasoning levels that Pi's `--thinking` flag takes. */
export const Thinking = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
/** One reasoning level. */
export type Thinking = typeof Thinking.Type

/** A model id as the provider names it; it is checked against the user's catalog at launch. */
const ModelId = Schema.NonEmptyString

/** The id of a route-table row: the root, or one of the specialists. */
export type RouteKey = "root" | RoleTask

/** The model and reasoning level of one route-table row. */
export interface RouteChoice {
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

const route = (key: RouteKey) =>
  defaulted(
    Schema.Struct({
      model: defaulted(ModelId, KIMI_ROUTES[key].model),
      thinking: defaulted(Thinking, KIMI_ROUTES[key].thinking),
    }),
    {},
  )

/**
 * One schema per route-table row, made from the keys of {@link KIMI_ROUTES}, so the list of rows
 * exists once. The cast only restores the per-key shape that `Object.fromEntries` widens.
 */
const ROUTE_FIELDS = Object.fromEntries(
  Object.keys(KIMI_ROUTES).map((key) => [key, route(key as RouteKey)]),
) as { readonly [Key in RouteKey]: ReturnType<typeof route> }

/**
 * How a session reaches the web: `provider` uses the provider extension's own tools (Kimi's
 * `moonshot_search` and `moonshot_fetch`) and loads no package, `pi-web-kit` loads that package
 * instead (the fallback for a login that cannot use the provider's tools), `off` has no web tools.
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

/** The `pi` section: read only by the Pi integration. */
const PiSection = defaulted(
  Schema.Struct({
    enable: defaulted(Enabled, true),
    provider: defaulted(PiProvider, "kimi-coding-global"),
    routes: defaulted(Schema.Struct(ROUTE_FIELDS), {}),
    features: defaulted(
      Schema.Struct({
        web: defaulted(WebMode, "provider"),
        processes: defaulted(Enabled, true),
        todo: defaulted(Enabled, true),
        ask: defaulted(Enabled, true),
        mcp: defaulted(Enabled, true),
        computerUse: defaulted(Enabled, true),
        contextCompression: defaulted(Enabled, true),
        subagents: defaulted(Enabled, true),
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
  }),
  {},
)

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
