import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect, Layer, Option } from "effect"

import { chooseForm } from "../src/setup/form.ts"
import { Shell } from "../src/setup/shell.ts"
import { runInteractive, tuiFallbackReason } from "../src/setup/tui/session.ts"
import type { SetupTuiModule, TuiInput } from "../src/setup/tui/types.ts"
import { scratch } from "./setup-fixture.ts"

let home: string
let t3Home: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-setup-tui-session-")
  home = join(made.directory, "home")
  t3Home = join(made.directory, "t3")
  await mkdir(home, { recursive: true })
  await mkdir(t3Home, { recursive: true })
  remove = made.remove
})
afterEach(() => remove())

const TERMINAL = { stdin: true, stdout: true }

/** A shell where `pi` is on PATH, counting how often the run asks for it. */
const piOnPath = () => {
  const probes = { pi: 0 }
  const layer = Layer.succeed(
    Shell,
    Shell.of({
      which: (command) => {
        if (command === "pi") probes.pi += 1
        return Effect.succeed(command === "pi" ? Option.some("/fake/bin/pi") : Option.none())
      },
      run: () => Effect.die("setup must not run a command in this test"),
    }),
  )
  return { probes, layer }
}

describe("the interface session", () => {
  test("probes for Pi once and loads the config once, so the review reads the loaded config", async () => {
    const shell = piOnPath()
    let reviewedFile: string | undefined
    const result = await Effect.runPromise(
      runInteractive({
        env: { HOME: home, T3CODE_HOME: t3Home },
        cwd: home,
        scope: "user",
        undo: false,
        dryRun: false,
        terminal: TERMINAL,
        noTui: false,
        choiceFlag: false,
        form: chooseForm({ DISPLAY: ":0" }, undefined, "linux"),
        load: () =>
          Effect.succeed({
            runSetupTui: async (input: TuiInput) => {
              // A config that no longer loads: a second load would find the T3 step with nothing to do.
              await mkdir(join(home, ".holyagent"), { recursive: true })
              await writeFile(join(home, ".holyagent", "config.json"), "{")
              reviewedFile = (await input.review(input.initial)).file
              return { _tag: "Cancelled" }
            },
          } as unknown as SetupTuiModule),
        notify: () => Effect.void,
        apply: () => Effect.die("nothing is applied"),
      }).pipe(Effect.provide(shell.layer)),
    )
    expect(result.kind).toBe("done")
    expect(reviewedFile).toBe(join(t3Home, "userdata", "settings.json"))
    expect(shell.probes.pi).toBe(1)
  })
})

describe("why the interface is not used", () => {
  const base = { terminal: TERMINAL, noTui: false, choiceFlag: false }

  test.each(["true", "1", "yes", "TRUE"])("CI=%s keeps it out", (ci) => {
    expect(tuiFallbackReason({ ...base, env: { CI: ci } })).toBe("CI is set")
  })

  test.each(["", "0", "false", "no", "off", "FALSE", " "])("CI=%j does not keep it out", (ci) => {
    expect(tuiFallbackReason({ ...base, env: { CI: ci } })).toBeUndefined()
  })
})
