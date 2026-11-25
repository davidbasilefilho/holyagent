import { spawn } from "@holyagent/core/state/process.ts"
import { Effect, Option } from "effect"

import { type Config } from "../config/schema.ts"
import { definedEnv, type Env, homeDirectory } from "../setup/environment.ts"
import { findCommand } from "../setup/shell.ts"
import { listModelCatalog } from "./catalog.ts"
import { providerEnv } from "./provider.ts"

/** Run the official read-only Pi query away from project extensions, never through a shell. */
export const cliPiModelCatalog = (cwd: string, env: Env) => (config: Config) =>
  Effect.gen(function* () {
    if ((config.pi.providers?.length ?? 0) < 2 || !config.pi.enable) return undefined
    const executable = findCommand(env, "pi", { includeBunBin: true, strict: { cwd } })
    if (Option.isNone(executable)) return undefined
    return yield* listModelCatalog((_command, args) =>
      spawn(executable.value, args, {
        cwd: homeDirectory(env),
        env: definedEnv({ ...env, ...providerEnv(config), PI_OFFLINE: "1" }),
      }).pipe(
        Effect.map(({ code, stdout, stderr }) => ({
          exitCode: code,
          stdout: new TextDecoder().decode(stdout),
          stderr,
        })),
        Effect.catchCause(() => Effect.succeed({ exitCode: 127, stdout: "", stderr: "" })),
      ),
    ).pipe(
      Effect.map((entries) => entries.map(({ provider, model }) => ({ provider, id: model }))),
      Effect.catchTag("NoModelsListed", () => Effect.succeed([])),
      Effect.orElseSucceed(() => undefined),
      Effect.timeoutOrElse({ duration: 2_000, orElse: () => Effect.succeed(undefined) }),
    )
  })
