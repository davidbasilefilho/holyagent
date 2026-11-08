import { Data, Effect, Option, Schema } from "effect"

import type { Config, RouteKey } from "../config/schema.ts"
import { providerProfile, routedModels } from "./provider.ts"
import { type CommandRunner, outputDetail } from "./readiness.ts"

/** One model of the user's catalog, as `pi --list-models` lists it. */
export interface CatalogEntry {
  readonly provider: string
  readonly model: string
}

/** Pi could not list the models: it failed, or did not start. */
export class CatalogUnavailable extends Data.TaggedError("CatalogUnavailable")<{
  readonly detail: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `pi --list-models failed: ${this.detail}`
  }
}

/**
 * Pi listed no models although it succeeded: it lists only the models of providers that have
 * credentials, so the likely cause is a provider that is not logged in. Run the readiness check
 * first, which names the fix.
 */
export class NoModelsListed extends Data.TaggedError("NoModelsListed") {
  /** The description shown to the user. */
  override get message() {
    return "pi --list-models listed no models, most likely because no provider has credentials; check the provider's readiness and log in first."
  }
}

/** Route-table models the user's catalog does not list, with the rows that use each. */
export class ModelsNotInCatalog extends Data.TaggedError("ModelsNotInCatalog")<{
  readonly provider: string
  readonly missing: ReadonlyArray<{
    readonly model: string
    readonly routes: ReadonlyArray<RouteKey>
  }>
}> {
  /** The description shown to the user. */
  override get message() {
    const list = this.missing
      .map(({ model, routes }) => `${model} (used by ${routes.join(", ")})`)
      .join("; ")
    return `Provider ${this.provider} does not list: ${list}. Change the model in pi.routes of config.json or log in to a plan that has it.`
  }
}

/** One row of the listing: the provider id and the model id, the first two columns. */
const CatalogRow = Schema.Struct({
  provider: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/)),
  model: Schema.String.check(Schema.isPattern(/^\S+$/)),
})
const decodeRow = Schema.decodeUnknownOption(CatalogRow, { onExcessProperty: "error" })

/**
 * Reads the table that `pi --list-models` prints: a header line starting `provider model`, then one
 * row per model with as many columns as the header, whose first two are the provider and the model
 * id, each decoded with Schema. Lines that are not rows (a footer, a note) are ignored, and text
 * without the header (Pi's no-models message) is an empty catalog.
 */
export const parseModelCatalog = (text: string): ReadonlyArray<CatalogEntry> => {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns[0] !== "")
  const header = rows.findIndex(([provider, model]) => provider === "provider" && model === "model")
  const width = rows[header]?.length ?? 0
  return header < 0
    ? []
    : rows
        .slice(header + 1)
        .filter((columns) => columns.length === width)
        .flatMap(([provider, model]) => {
          const row = decodeRow({ provider, model })
          return Option.isSome(row) ? [row.value] : []
        })
}

/**
 * Lists the models the user can use with `pi --list-models`. Pi lists only the models of providers
 * with credentials, so check readiness first; a listing with no model fails with
 * {@link NoModelsListed}.
 */
export const listModelCatalog = (
  run: CommandRunner,
): Effect.Effect<ReadonlyArray<CatalogEntry>, CatalogUnavailable | NoModelsListed> =>
  run("pi", ["--list-models"]).pipe(
    Effect.flatMap(
      (result): Effect.Effect<ReadonlyArray<CatalogEntry>, CatalogUnavailable | NoModelsListed> => {
        if (result.exitCode !== 0)
          return Effect.fail(
            new CatalogUnavailable({
              detail: outputDetail(result, `pi exited with code ${result.exitCode}`),
            }),
          )
        const catalog = parseModelCatalog(result.stdout)
        return catalog.length === 0 ? Effect.fail(new NoModelsListed()) : Effect.succeed(catalog)
      },
    ),
  )

/**
 * Checks every model of the route table against a catalog, as the provider names it. Each id the
 * catalog does not list is reported once, with the rows that use it, as a blocker.
 */
export const checkModelCatalog = (
  config: Config,
  catalog: ReadonlyArray<CatalogEntry>,
): Effect.Effect<void, ModelsNotInCatalog> => {
  const listed = new Set(catalog.map(({ provider, model }) => `${provider}/${model}`))
  const missing = new Map<string, Array<RouteKey>>()
  for (const route of routedModels(config)) {
    if (!listed.has(`${route.provider}/${route.model}`)) {
      missing.set(route.model, [...(missing.get(route.model) ?? []), route.key])
    }
  }
  return missing.size === 0
    ? Effect.void
    : Effect.fail(
        new ModelsNotInCatalog({
          provider: providerProfile(config).id,
          missing: [...missing].map(([model, routes]) => ({ model, routes })),
        }),
      )
}

/** Lists the user's catalog and checks the route table against it. */
export const validateModelCatalog = (
  run: CommandRunner,
  config: Config,
): Effect.Effect<void, CatalogUnavailable | NoModelsListed | ModelsNotInCatalog> =>
  listModelCatalog(run).pipe(Effect.flatMap((catalog) => checkModelCatalog(config, catalog)))
