import { Console, Effect } from "effect"

import { stageCodexStartup, StartupStageError } from "../../../runtime/src/setup/codex/startup.ts"

export * from "../../../runtime/src/setup/codex/startup.ts"

if (import.meta.main) {
  const [parent, choice, catalogFile, extra] = Bun.argv.slice(2)
  const expected =
    choice === undefined || (choice === "--root-only-catalog" && catalogFile !== undefined)
  const stage =
    parent === undefined || !expected || extra !== undefined
      ? Effect.fail(
          new StartupStageError({
            detail: "Expected an absolute staging directory [--root-only-catalog <absolute file>]",
          }),
        )
      : stageCodexStartup(parent, catalogFile)
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
