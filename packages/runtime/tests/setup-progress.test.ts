import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { Effect, Option } from "effect"

import { PiProbeTransport } from "../../core/src/setup/pi-host.ts"
import { SetupProgress, type SetupProgressUpdate } from "../../core/src/setup/progress.ts"
import { piPackages } from "../src/config/packages.ts"
import { defaultConfig } from "../src/config/schema.ts"
import { Shell } from "../src/setup/shell.ts"
import { setup } from "../src/setup/steps.ts"
import { fixturePiProbe, scratch } from "./setup-fixture.ts"

test.each([false, true])(
  "reports the actual slow Pi install and honours abort=%s",
  async (abort) => {
    const made = await scratch("holyagent-progress-")
    const t3 = join(made.directory, "t3")
    const pi = join(made.directory, "pi")
    await mkdir(t3, { recursive: true })
    const [source, ...alreadyInstalled] = piPackages(
      await Effect.runPromise(defaultConfig),
      undefined,
      "headless",
    )
    if (source === undefined) throw new Error("expected at least one headless Pi package")
    await Bun.write(join(pi, "settings.json"), JSON.stringify({ packages: alreadyInstalled }))
    const firstCommand = Promise.withResolvers<ReadonlyArray<string>>()
    const finish = Promise.withResolvers<void>()
    const updates: Array<SetupProgressUpdate> = []
    const controller = new AbortController()
    try {
      const run = Effect.runPromise(
        setup(
          {
            HOME: made.directory,
            T3CODE_HOME: t3,
            PI_CODING_AGENT_DIR: pi,
            HOLYAGENT_HOST: "pi",
          },
          {
            form: { form: "headless", source: "flag", reason: "test" },
            target: "pi",
            cwd: made.directory,
            subagentCacheTtl: "1h",
            dryRun: false,
            skipCtx7: true,
          },
        ).pipe(
          Effect.provideService(SetupProgress, (update) => updates.push(update)),
          Effect.provideService(PiProbeTransport, {
            run: (request) => Effect.succeed(fixturePiProbe(request)),
          }),
          Effect.provideService(
            Shell,
            Shell.of({
              which: (command) =>
                Effect.succeed(
                  command === "pi"
                    ? Option.some(join(made.directory, "fixture-pi"))
                    : Option.none(),
                ),
              run: (command, args) =>
                Effect.tryPromise(async () => {
                  firstCommand.resolve([command, ...args])
                  await finish.promise
                  return { exitCode: 0, stdout: "", stderr: "" }
                }).pipe(Effect.orDie),
            }),
          ),
        ),
        { signal: controller.signal },
      )
      const current = [
        { index: 1, total: 5, label: "Capability settings" },
        { index: 2, total: 5, label: "Pi packages" },
        { index: 2, total: 5, label: "Pi packages", activity: `Installing ${source}` },
      ]
      expect(await firstCommand.promise).toEqual([
        join(made.directory, "fixture-pi"),
        "install",
        source,
      ])
      expect(updates).toEqual(current)
      const settings = Bun.file(join(t3, "userdata", "settings.json"))
      if (abort) {
        controller.abort()
        await expect(run).rejects.toThrow()
        expect(updates).toEqual(current)
        expect(await settings.exists()).toBe(false)
      } else {
        finish.resolve()
        expect((await run).ok).toBe(true)
        expect(updates).toEqual([
          ...current,
          { index: 3, total: 5, label: "Pi tool settings" },
          { index: 4, total: 5, label: "Browser-use checks" },
          { index: 5, total: 5, label: "T3 Code settings" },
        ])
        expect(await settings.exists()).toBe(true)
      }
    } finally {
      finish.resolve()
      await made.remove()
    }
  },
)
