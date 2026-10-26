import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"

let project: string
let home: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "holyagent-input-"))
  home = await mkdtemp(join(tmpdir(), "holyagent-input-home-"))
})
afterEach(() =>
  Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]),
)

/** Runs one command line in-process against the temp project, with `stdin` as its raw text. */
const cli = (argv: ReadonlyArray<string>, stdin?: string | Effect.Effect<string, StdinMissing>) =>
  Effect.runPromise(
    run(argv, {
      cwd: project,
      env: { HOME: home },
      stdin:
        stdin === undefined
          ? Effect.fail(new StdinMissing({ reason: "no stdin in this test" }))
          : typeof stdin === "string"
            ? Effect.succeed(stdin)
            : stdin,
    }),
  )

const json = JSON.stringify

const INTENT = { objective: "Ship it", requirements: ["be fast"] }

const DRAFT = {
  roleTask: "Worker.implementation",
  objective: "Build the parser",
  criteria: [{ text: "parses", blocking: true, dimension: "behavior" }],
  ownershipPaths: ["src/parser.ts"],
}

/** The four commands that take `--input`, each with a payload it accepts and what it prints. */
const COMMANDS = [
  {
    name: "intent create",
    argv: ["intent", "create"],
    payload: INTENT,
    needsIntent: false,
    printed: (out: Record<string, unknown>) => out["objective"] === "Ship it",
  },
  {
    name: "intent update",
    argv: ["intent", "update"],
    payload: { objective: "Ship it faster" },
    needsIntent: true,
    printed: (out: Record<string, unknown>) => out["objective"] === "Ship it faster",
  },
  {
    name: "assignment create",
    argv: ["assignment", "create"],
    payload: DRAFT,
    needsIntent: true,
    printed: (out: Record<string, unknown>) => out["state"] === "Ready",
  },
  {
    name: "assignment dispatch",
    argv: ["assignment", "dispatch"],
    payload: DRAFT,
    needsIntent: true,
    printed: (out: Record<string, unknown>) => out["state"] === "Running",
  },
] as const

const decoded = (stdout: string): Record<string, unknown> =>
  decode(stdout.split("\nprompt:\n")[0] ?? "") as Record<string, unknown>

describe.each(COMMANDS)("$name --input", (command) => {
  const start = () => (command.needsIntent ? cli(["intent", "create"], json(INTENT)) : undefined)

  test("takes the payload inline, decoded strictly", async () => {
    await start()
    const result = await cli([...command.argv, "--input", json(command.payload)])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(command.printed(decoded(result.stdout))).toBe(true)
  })

  test("takes the inline payload in the --input=<json> form", async () => {
    await start()
    const result = await cli([...command.argv, `--input=${json(command.payload)}`])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
  })

  test("accepts a blank stdin beside the flag", async () => {
    await start()
    const result = await cli([...command.argv, "--input", json(command.payload)], "  \n")
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
  })

  test("refuses an excess property with a hint", async () => {
    await start()
    const result = await cli([...command.argv, "--input", json({ ...command.payload, extra: 1 })])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("error: InvalidDraft: --input:")
    expect(result.stderr).toContain("hint:")
  })

  test("refuses invalid JSON with a hint", async () => {
    await start()
    const result = await cli([...command.argv, "--input", "{not json"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("error: InvalidDraft: --input:")
    expect(result.stderr).toContain("hint:")
  })

  test("refuses a blank value with a hint", async () => {
    await start()
    const result = await cli([...command.argv, "--input", "  "])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("error: Usage: --input is empty")
    expect(result.stderr).toContain("hint:")
  })

  test("never waits on a stdin that does not complete", async () => {
    await start()
    // An agent's shell tool leaves stdin an open pipe; the old code read it and hung here.
    const result = await cli([...command.argv, "--input", json(command.payload)], Effect.never)
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(command.printed(decoded(result.stdout))).toBe(true)
  })

  test("still reads stdin when the flag is absent", async () => {
    await start()
    const result = await cli(command.argv, json(command.payload))
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(command.printed(decoded(result.stdout))).toBe(true)
  })
})

describe("help", () => {
  test("names --input beside stdin on the top line and on each of the four commands", async () => {
    expect((await cli(["--help"])).stdout).toContain("--input '<json>'")
    for (const command of COMMANDS) {
      const help = (await cli([...command.argv, "--help"])).stdout
      expect(help).toContain("input (--input '<json>' or stdin):")
    }
  })

  test("leaves the report commands on stdin", async () => {
    const close = await cli(["assignment", "close", "assignment-x", "--help"])
    expect(close.stdout).toContain("\nstdin: ")
    const refused = await cli(["assignment", "close", "assignment-x", "--input", "{}"])
    expect(refused.stderr).toContain("Unknown flag --input")
  })
})
