import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect, Layer, Option } from "effect"

import { PiRegistrationReview } from "../../core/src/setup/pi-install.ts"
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

  test.each([
    "cancel",
    "keep",
    "replace",
    "changed",
    "new Pi conflict",
    "new Codex conflict",
  ] as const)(
    "combined managed conflicts: %s respects the reviewed harnesses before writing",
    async (action) => {
      const writes: string[] = []
      const clean = action === "new Pi conflict" || action === "new Codex conflict"
      let changed = false
      const shell = piOnPath()
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
              runSetupTui: async (input) => {
                const choices = {
                  ...input.initial,
                  harnesses: { pi: true, claude: true, codex: true },
                  piProviders: { providers: ["kimi-coding-global" as const] },
                  ...(action === "keep" ? { keepManagedConflicts: true } : {}),
                }
                await expect(input.apply(choices, new AbortController().signal)).rejects.toThrow(
                  "Review",
                )
                const review = await input.review(choices)
                expect(review.conflicts?.map(({ harness }) => harness)).toEqual(
                  clean ? [] : ["Pi / T3 Code", "Codex"],
                )
                expect(writes).toEqual([])
                if (action === "cancel") return { _tag: "Cancelled" }
                if (action === "changed" || clean) {
                  changed = true
                  await expect(input.apply(choices, new AbortController().signal)).rejects.toThrow(
                    action === "new Pi conflict"
                      ? "Pi package plan changed"
                      : "changed since review",
                  )
                  return { _tag: "Cancelled" }
                }
                return {
                  _tag: "Applied",
                  applied: await input.apply(choices, new AbortController().signal),
                }
              },
            }),
          notify: () => Effect.void,
          apply: () => Effect.die("combined setup must use a harness"),
          combined: {
            codexHome: join(home, "codex"),
            run: (target, _choices, _chosen, preview, _skip, replacePi, check) =>
              Effect.gen(function* () {
                const plan = yield* PiRegistrationReview
                if (preview) {
                  if (target === "pi" && (!clean || (changed && action === "new Pi conflict")))
                    plan?.preview?.({
                      file: join(home, "pi.json"),
                      prior: "npm:holyagent@0.3.4",
                      source: "npm:holyagent@0.4.0",
                      fingerprint: "reviewed-pi-entry",
                    })
                  if (target === "codex") {
                    if (check === true && changed)
                      return { ok: false, lines: ["! Codex profile changed since review"] }
                    return {
                      ok: true,
                      lines: [],
                      managedConflicts: clean
                        ? []
                        : [
                            {
                              file: join(home, "codex", "AGENTS.md"),
                              detail: "edited managed instructions",
                            },
                          ],
                    }
                  }
                } else {
                  if (target === "pi") {
                    expect(replacePi).toBe(true)
                    expect(plan?.expected).toBe("reviewed-pi-entry")
                  }
                  writes.push(target)
                }
                return { ok: true, lines: [] }
              }),
          },
        }).pipe(Effect.provide(shell.layer)),
      )
      expect(writes).toEqual(
        action === "keep" ? ["claude"] : action === "replace" ? ["pi", "claude", "codex"] : [],
      )
      if (action === "keep" && result.kind !== "line") {
        expect(result.report.lines.join("\n")).toContain("Pi / T3 Code setup skipped")
        expect(result.report.lines.join("\n")).toContain("Codex setup skipped")
      }
    },
  )
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
