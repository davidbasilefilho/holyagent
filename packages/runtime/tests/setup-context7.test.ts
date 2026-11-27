import { expect, test } from "bun:test"
import { dirname, join } from "node:path"

import { Effect, Layer, Option } from "effect"

import { lookupCtx7 } from "../../core/src/setup/context7.ts"
import { doctor } from "../src/setup/doctor.ts"
import { Shell, type ShellResult, type WhichOptions } from "../src/setup/shell.ts"
import { installCtx7 } from "../src/setup/steps.ts"
import { scratch, writeCompleteSettings } from "./setup-fixture.ts"

const windows = process.platform === "win32"
const fixtureHome = windows ? "C:\\Fixture" : "/user"
const MISE = join(fixtureHome, "bin", windows ? "mise.exe" : "mise")
const ROOT = join(fixtureHome, "mise-data", "installs", "npm-ctx7", "0.13.1")
const BIN = join(ROOT, "node_modules", ".bin", windows ? "ctx7.cmd" : "ctx7")
const list = ["--no-config", "ls", "--installed", "--json", "npm:ctx7"]
const bins = ["--no-config", "bin-paths", "--json", "npm:ctx7@0.13.1"]

const mock = (options: {
  readonly mise?: string
  readonly root?: string
  readonly bin?: string
  readonly directory?: string
  readonly verify?: boolean
  readonly path?: string
  readonly inventory?: string
  readonly binInventory?: string
  readonly inventoryCode?: number
  readonly inventoryWarning?: string
  readonly rejectStrict?: boolean
}) => {
  const queries: Array<{ command: string; options?: WhichOptions }> = []
  const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd: string; env: unknown }> =
    []
  const mise = options.mise ?? MISE
  const bin = options.bin ?? BIN
  const shell = Layer.succeed(
    Shell,
    Shell.of({
      which: (command, lookupOptions) =>
        Effect.sync(() => {
          queries.push({
            command,
            ...(lookupOptions === undefined ? {} : { options: lookupOptions }),
          })
          if (command === "mise")
            return options.rejectStrict && lookupOptions?.strict ? Option.none() : Option.some(mise)
          if (command === "bun") return Option.some("/user/bin/bun")
          if (command === "ctx7" && options.path !== undefined) return Option.some(options.path)
          if (
            command === "ctx7" &&
            options.verify !== false &&
            lookupOptions?.directory === (options.directory ?? dirname(bin))
          )
            return Option.some(bin)
          return Option.none()
        }),
      run: (command, args, runOptions) =>
        Effect.sync((): ShellResult => {
          calls.push({ command, args, cwd: runOptions.cwd, env: runOptions.env })
          if (args.includes("ls"))
            return {
              exitCode: options.inventoryCode ?? 0,
              stdout:
                options.inventory ??
                JSON.stringify([
                  {
                    version: "0.13.1",
                    install_path: options.root ?? ROOT,
                    installed: true,
                    active: false,
                  },
                ]),
              stderr: options.inventoryWarning ?? "",
            }
          if (args.includes("bin-paths"))
            return {
              exitCode: 0,
              stdout:
                options.binInventory ??
                JSON.stringify([{ name: "ctx7", path: bin, symlink: false }]),
              stderr: "",
            }
          return { exitCode: 0, stdout: "", stderr: "" }
        }),
    }),
  )
  return { shell, queries, calls }
}

test("recognizes a registered npm:ctx7 under Windows mise without activating it or reading the project config", async () => {
  const root = "C:\\Users\\Case Name\\mise\\installs\\npm-ctx7\\0.13.1"
  const directory = `${root}\\bin`
  const executable = `${directory}\\ctx7.cmd`
  const mise = "C:\\Users\\Case Name\\bin\\mise.exe"
  const home = "C:\\Users\\Case Name"
  const project = "D:\\repo"
  const fixture = mock({ mise, root, bin: executable, directory })
  const env = { USERPROFILE: home, Path: project, MISE_CONFIG_FILE: `${project}\\mise.toml` }
  expect(
    await Effect.runPromise(lookupCtx7(env, project, "win32").pipe(Effect.provide(fixture.shell))),
  ).toEqual({ kind: "mise", path: executable })
  expect(fixture.queries).toContainEqual({
    command: "mise",
    options: { strict: { cwd: project, platform: "win32" } },
  })
  expect(fixture.queries).toContainEqual({ command: "ctx7", options: { directory } })
  expect(fixture.calls).toEqual(
    [list, bins].map((args) => ({
      command: mise,
      args,
      cwd: home,
      env: { MISE_OFFLINE: "1", MISE_AUTO_INSTALL: "0", MISE_NOT_FOUND_AUTO_INSTALL: "0" },
    })),
  )
  expect(env).toEqual({
    USERPROFILE: home,
    Path: project,
    MISE_CONFIG_FILE: `${project}\\mise.toml`,
  })
})

test("a real run, dry run and doctor --fix report the same already-installed mise command", async () => {
  const { directory, remove } = await scratch("holyagent-ctx7-mise-")
  try {
    await writeCompleteSettings(join(directory, ".claude"))
    const fixture = mock({})
    const env = { HOME: directory, USERPROFILE: directory }
    for (const dryRun of [false, true]) {
      const lines = await Effect.runPromise(
        installCtx7(env, dryRun).pipe(Effect.provide(fixture.shell)),
      )
      expect(lines.join("\n")).toContain(`ctx7: already installed with mise at ${BIN}`)
      expect(lines.join("\n")).toContain("not on PATH")
    }
    const report = await Effect.runPromise(
      doctor(env, { fix: true }).pipe(Effect.provide(fixture.shell)),
    )
    expect(report.lines).toContain(
      `ok   ctx7: ${BIN} (installed with mise, not on PATH; add its directory to PATH)`,
    )
    expect(fixture.calls.map(({ args }) => args)).toEqual([list, bins, list, bins, list, bins])
  } finally {
    await remove()
  }
})

test("PATH short-circuits mise and an empty installed inventory allows the existing Bun fallback", async () => {
  const existing = mock({ path: join(fixtureHome, "bin", windows ? "ctx7.cmd" : "ctx7") })
  expect(
    await Effect.runPromise(installCtx7({}, true).pipe(Effect.provide(existing.shell))),
  ).toEqual(["= ctx7: already installed"])
  expect(existing.calls).toEqual([])
  const missing = mock({ inventory: "[]" })
  expect(
    await Effect.runPromise(installCtx7({}, true).pipe(Effect.provide(missing.shell))),
  ).toEqual(["+ ctx7: would install with bun add -g ctx7"])
  expect(missing.calls.map(({ args }) => args)).toEqual([list])
})

test.each([
  { inventory: "untrusted mise output" },
  { inventoryCode: 1 },
  { inventory: "[]", inventoryWarning: "install inventory unavailable" },
  { rejectStrict: true },
  { binInventory: "{}" },
  { verify: false },
  { root: "relative/path" },
  { root: join(fixtureHome, "ctx7", "not-the-parent"), bin: join(fixtureHome, "ctx7") },
  { bin: join(fixtureHome, "outside", "the", "install", windows ? "ctx7.cmd" : "ctx7") },
  { bin: join(ROOT, "ctx7\nother-line") },
])(
  "unverified mise output never selects the claimed command or requests a duplicate install %#",
  async (options) => {
    const fixture = mock(options)
    const lines = await Effect.runPromise(
      installCtx7({}, false).pipe(Effect.provide(fixture.shell)),
    )
    expect(lines.join("\n")).toStartWith("! ctx7: could not verify mise")
    expect(fixture.calls.every(({ command }) => command === MISE)).toBe(true)
  },
)
