import { mkdtemp } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { Data, Effect, Schema } from "effect"

import {
  CODEX_ASSET_VERSION,
  CODEX_DEFAULT_EFFORT,
  CODEX_MODEL,
  CODEX_STARTUP_GUIDANCE,
  codexMarketplaceFiles,
  codexRoleFiles,
} from "./assets.ts"

/** The marketplace path under a staged Codex home. */
export const CODEX_STARTUP_MARKETPLACE = "holyagent/marketplace"

const catalogName = "root-only-models.json"

// The models-manager catalog shipped by rust-v0.172.0. The optional mode deliberately does not
// consume a live catalog whose V2 defaults can change after this profile has been reviewed.
const verifiedCatalog = "d50b6749506d97e5f334dbabcb666eb1689f423cf3e88cfabdcf3c536b873068"
const Catalog = Schema.fromJsonString(
  Schema.Struct({ models: Schema.NonEmptyArray(Schema.Record(Schema.String, Schema.Unknown)) }),
)

/** Native settings for an isolated direct-only or vetted root-only V1 profile. */
export const codexStartupConfig = (rootOnlyCatalogPath?: string) =>
  [
    `model = ${JSON.stringify(CODEX_MODEL)}`,
    `model_reasoning_effort = ${JSON.stringify(CODEX_DEFAULT_EFFORT)}`,
    ...(rootOnlyCatalogPath === undefined
      ? []
      : [`model_catalog_json = ${JSON.stringify(rootOnlyCatalogPath)}`]),
    "",
    "[agents]",
    // Model metadata can select V2 despite the feature flag. Disable native agents at the
    // common entry point until the host can prove root-only delegation on its selected mode.
    `enabled = ${rootOnlyCatalogPath !== undefined}`,
    "max_depth = 1",
    "",
    "[features]",
    ...(rootOnlyCatalogPath === undefined ? ["multi_agent_v2 = false"] : []),
    "default_mode_request_user_input = true",
    "context_management = true",
    ...(rootOnlyCatalogPath === undefined
      ? []
      : [
          "",
          "[features.multi_agent_v2]",
          "enabled = false",
          "disable_native_tools = true",
          "",
          "[features.code_mode]",
          'direct_only_tool_namespaces = ["multi_agent_v1"]',
        ]),
    "",
  ].join("\n")

/** Staging could not complete. The existing Codex profile is outside this operation. */
export class StartupStageError extends Data.TaggedError("StartupStageError")<{
  readonly detail: string
}> {}

const readRootOnlyCatalog = Effect.fn("readRootOnlyCatalog")(function* (file: string) {
  if (!isAbsolute(file))
    return yield* new StartupStageError({ detail: "Use an absolute path to the Codex catalog" })
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(file).text(),
    catch: (cause) => new StartupStageError({ detail: String(cause) }),
  })
  if (Bun.CryptoHasher.hash("sha256", text, "hex") !== verifiedCatalog)
    return yield* new StartupStageError({ detail: "Expected the unmodified Codex 0.172.0 catalog" })
  const original = yield* Schema.decodeUnknownEffect(Catalog)(text, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => new StartupStageError({ detail: String(cause) })))
  return `${JSON.stringify({
    models: original.models.map((model) =>
      model["multi_agent_version"] === "v2" ? { ...model, multi_agent_version: "v1" } : model,
    ),
  })}\n`
})

/** Plan all native startup files without writing to the selected Codex home. */
export const codexStartupFiles = Effect.fn("codexStartupFiles")(function* (
  target: string,
  catalogFile?: string,
  version = CODEX_ASSET_VERSION,
) {
  const catalog = catalogFile === undefined ? undefined : yield* readRootOnlyCatalog(catalogFile)
  return [
    {
      path: "config.toml",
      content: codexStartupConfig(catalog === undefined ? undefined : join(target, catalogName)),
    },
    ...(catalog === undefined ? [] : [{ path: catalogName, content: catalog }]),
    { path: "AGENTS.md", content: CODEX_STARTUP_GUIDANCE },
    ...codexRoleFiles(),
    ...codexMarketplaceFiles(version).map(({ path, content }) => ({
      path: join(CODEX_STARTUP_MARKETPLACE, path),
      content,
    })),
  ]
})

/** Creates a new private profile directory without inspecting or editing any existing profile. */
export const stageCodexStartup = Effect.fn("stageCodexStartup")(function* (
  parent: string,
  catalogFile?: string,
) {
  if (!isAbsolute(parent))
    return yield* new StartupStageError({ detail: "Use an absolute staging directory" })
  if (catalogFile !== undefined) yield* readRootOnlyCatalog(catalogFile)
  const target = yield* Effect.tryPromise({
    try: () => mkdtemp(join(parent, "holyagent-codex-")),
    catch: (cause) => new StartupStageError({ detail: String(cause) }),
  })
  const files = yield* codexStartupFiles(target, catalogFile)
  yield* Effect.forEach(files, ({ path, content }) =>
    Effect.tryPromise({
      try: () => Bun.write(join(target, path), content),
      catch: (cause) => new StartupStageError({ detail: `${path}: ${String(cause)}` }),
    }),
  )
  return target
})
