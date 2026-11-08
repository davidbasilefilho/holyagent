import { Data, Effect, Option, Schema } from "effect"

import type { Config, RouteKey } from "../config/schema.ts"
import { providerProfile, routedModels } from "./provider.ts"
import { type CommandRunner, DETAIL_CHARS, outputDetail } from "./readiness.ts"

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

/**
 * Pi printed something that is not the model table, so its listing format was not recognised: Pi
 * may have changed it. This is not a credentials problem, so the output is shown to say what Pi
 * printed.
 */
export class ListingNotRecognised extends Data.TaggedError("ListingNotRecognised")<{
  readonly detail: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `pi --list-models printed no model table (a header line starting "provider model" and one row per model), so its listing format was not recognised: ${this.detail}`
  }
}

const MODELS_FIX = "Change the model in pi.routes of config.json or log in to a plan that has it."

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
    return `Provider ${this.provider} does not list: ${list}. ${MODELS_FIX}`
  }

  /**
   * The same blocker with the models only, not the rows that use them: short enough for a one-line
   * notice that must still end with the fix.
   */
  get brief() {
    const list = this.missing.map(({ model }) => model).join(", ")
    return `Provider ${this.provider} does not list: ${list}. ${MODELS_FIX}`
  }
}

/** An id column of the listing: any text without whitespace, which is what separates the columns. */
const Id = Schema.String.check(Schema.isPattern(/^\S+$/))

/** One row of the listing: the provider id and the model id, the first two columns. */
const CatalogRow = Schema.Struct({ provider: Id, model: Id })
const decodeRow = Schema.decodeUnknownOption(CatalogRow, { onExcessProperty: "error" })

/** The non-blank lines of a listing, split into columns. */
const columnsOf = (text: string): ReadonlyArray<ReadonlyArray<string>> =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns[0] !== "")

/** Whether a line's columns are the table header, which starts `provider model`. */
const isHeader = ([provider, model]: ReadonlyArray<string>): boolean =>
  provider === "provider" && model === "model"

/**
 * Reads the table that `pi --list-models` prints: a header line starting `provider model`, then one
 * row per model with as many columns as the header, whose first two are the provider and the model
 * id, each decoded with Schema. Lines that are not rows (a footer, a note) are ignored, and text
 * without the header (Pi's no-models message) is an empty catalog.
 */
export const parseModelCatalog = (text: string): ReadonlyArray<CatalogEntry> => {
  const rows = columnsOf(text)
  const header = rows.findIndex(isHeader)
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
 * Whether a listing that has no model row is one Pi means as empty: no output, the table header
 * alone, or Pi's own "No models ..." message. Any other output is a format this code does not
 * know.
 */
const isEmptyListing = (text: string): boolean => {
  const rows = columnsOf(text)
  return text.trim() === "" || rows.some(isHeader) || /^no models\b/i.test(rows[0]?.join(" ") ?? "")
}

/**
 * Lists the models the user can use with `pi --list-models`. Pi lists only the models of providers
 * with credentials, so check readiness first; a listing that is empty fails with
 * {@link NoModelsListed}, and output that is no model table at all fails with
 * {@link ListingNotRecognised}.
 */
export const listModelCatalog = (
  run: CommandRunner,
): Effect.Effect<
  ReadonlyArray<CatalogEntry>,
  CatalogUnavailable | NoModelsListed | ListingNotRecognised
> =>
  run("pi", ["--list-models"]).pipe(
    Effect.flatMap(
      (
        result,
      ): Effect.Effect<
        ReadonlyArray<CatalogEntry>,
        CatalogUnavailable | NoModelsListed | ListingNotRecognised
      > => {
        if (result.exitCode !== 0)
          return Effect.fail(
            new CatalogUnavailable({
              detail: outputDetail(result, `pi exited with code ${result.exitCode}`),
            }),
          )
        const catalog = parseModelCatalog(result.stdout)
        if (catalog.length > 0) return Effect.succeed(catalog)
        return Effect.fail(
          isEmptyListing(result.stdout)
            ? new NoModelsListed()
            : new ListingNotRecognised({
                detail: result.stdout.trim().slice(0, DETAIL_CHARS),
              }),
        )
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
): Effect.Effect<
  void,
  CatalogUnavailable | NoModelsListed | ListingNotRecognised | ModelsNotInCatalog
> => listModelCatalog(run).pipe(Effect.flatMap((catalog) => checkModelCatalog(config, catalog)))
