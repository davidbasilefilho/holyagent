import { mkdtemp } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { Console, Data, Effect } from "effect"

import {
  CODEX_DEFAULT_EFFORT,
  CODEX_MODEL,
  codexMarketplaceFiles,
  codexRoleFiles,
} from "./assets.ts"

/** The marketplace path under a staged Codex home. */
export const CODEX_STARTUP_MARKETPLACE = "holyagent/marketplace"

/** Native settings for a new direct-only profile on the verified Codex runtime. */
export const codexStartupConfig = () =>
  [
    `model = ${JSON.stringify(CODEX_MODEL)}`,
    `model_reasoning_effort = ${JSON.stringify(CODEX_DEFAULT_EFFORT)}`,
    "",
    "[agents]",
    // Model metadata can select V2 despite the feature flag. Disable native agents at the
    // common entry point until the host can prove root-only delegation on its selected mode.
    "enabled = false",
    "max_depth = 1",
    "",
    "[features]",
    "multi_agent_v2 = false",
    "default_mode_request_user_input = true",
    "",
  ].join("\n")

/** Staging could not complete. The existing Codex profile is outside this operation. */
export class StartupStageError extends Data.TaggedError("StartupStageError")<{
  readonly detail: string
}> {}

/** Creates a new private profile directory without inspecting or editing any existing profile. */
export const stageCodexStartup = Effect.fn("stageCodexStartup")(function* (parent: string) {
  if (!isAbsolute(parent))
    return yield* new StartupStageError({ detail: "Use an absolute staging directory" })
  const target = yield* Effect.tryPromise({
    try: () => mkdtemp(join(parent, "holyagent-codex-")),
    catch: (cause) => new StartupStageError({ detail: String(cause) }),
  })
  const files = [
    { path: "config.toml", content: codexStartupConfig() },
    ...codexRoleFiles(),
    ...codexMarketplaceFiles().map(({ path, content }) => ({
      path: join(CODEX_STARTUP_MARKETPLACE, path),
      content,
    })),
  ]
  yield* Effect.forEach(files, ({ path, content }) =>
    Effect.tryPromise({
      try: () => Bun.write(join(target, path), content),
      catch: (cause) => new StartupStageError({ detail: `${path}: ${String(cause)}` }),
    }),
  )
  return target
})

if (import.meta.main) {
  const [parent, extra] = Bun.argv.slice(2)
  const stage =
    parent === undefined || extra !== undefined
      ? Effect.fail(new StartupStageError({ detail: "Expected one absolute staging directory" }))
      : stageCodexStartup(parent)
  await Effect.runPromise(
    stage.pipe(
      Effect.flatMap(Console.log),
      Effect.catch((error) =>
        Console.error(error.detail).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              process.exitCode = 1
            }),
          ),
        ),
      ),
    ),
  )
}
