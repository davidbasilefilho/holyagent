import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import {
  checkModelCatalog,
  ModelsNotInCatalog,
  parseModelCatalog,
  validateModelCatalog,
} from "../../src/pi/catalog.ts"
import type { CommandRunner } from "../../src/pi/readiness.ts"
import { DEFAULT_CONFIG } from "../config/defaults.ts"

/** The table `pi --list-models` prints (columns padded, two spaces apart), synthesized. */
const table = (rows: ReadonlyArray<readonly [string, string]>): string => {
  const lines = [
    ["provider", "model", "context", "max-out", "thinking", "images"],
    ...rows.map(([provider, model]) => [provider, model, "1M", "64K", "yes", "yes"]),
  ]
  const widths = lines[0]!.map((_, column) => Math.max(...lines.map((row) => row[column]!.length)))
  return (
    lines.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ")).join("\n") + "\n"
  )
}

const FULL = table([
  ["anthropic", "claude-sonnet-5"],
  ["kimi-coding", "k3.1-pro"],
  ["kimi-coding", "kimi-for-coding"],
])

const runner =
  (exitCode: number, stdout: string, stderr = ""): CommandRunner =>
  () =>
    Effect.succeed({ exitCode, stdout, stderr })

describe("parseModelCatalog", () => {
  test("reads the provider and model columns of every row", () => {
    expect(parseModelCatalog(FULL)).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "kimi-coding", model: "k3.1-pro" },
      { provider: "kimi-coding", model: "kimi-for-coding" },
    ])
  })

  test("reads Windows line endings", () => {
    expect(parseModelCatalog(FULL.replaceAll("\n", "\r\n"))).toHaveLength(3)
  })

  test("text without the table header is an empty catalog", () => {
    expect(parseModelCatalog("")).toEqual([])
    expect(parseModelCatalog('No models matching "kimi"\n')).toEqual([])
  })
})

describe("checkModelCatalog", () => {
  test("passes when the catalog lists every mapped model", async () => {
    await Effect.runPromise(checkModelCatalog(DEFAULT_CONFIG, parseModelCatalog(FULL)))
  })

  test("blocks on an id the catalog lacks, naming the rows that use it", async () => {
    const catalog = parseModelCatalog(table([["kimi-coding", "kimi-for-coding"]]))
    const error = await Effect.runPromise(Effect.flip(checkModelCatalog(DEFAULT_CONFIG, catalog)))
    expect(error).toBeInstanceOf(ModelsNotInCatalog)
    expect(error.provider).toBe("kimi-coding")
    expect(error.missing).toEqual([
      { model: "k3.1-pro", routes: ["root", "Worker.visual", "Reviewer.visual"] },
    ])
    expect(error.message).toContain("k3.1-pro")
  })

  test("an id listed under another provider does not count", async () => {
    const catalog = parseModelCatalog(
      table([
        ["other", "k3.1-pro"],
        ["kimi-coding", "kimi-for-coding"],
      ]),
    )
    const error = await Effect.runPromise(Effect.flip(checkModelCatalog(DEFAULT_CONFIG, catalog)))
    expect(error.missing.map(({ model }) => model)).toEqual(["k3.1-pro"])
  })

  test("an empty catalog misses both mapped ids, each once", async () => {
    const error = await Effect.runPromise(Effect.flip(checkModelCatalog(DEFAULT_CONFIG, [])))
    expect(error.missing.map(({ model }) => model).sort()).toEqual(["k3.1-pro", "kimi-for-coding"])
  })
})

describe("validateModelCatalog", () => {
  test("lists with pi --list-models and checks the table", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const run: CommandRunner = (command, args) => {
      calls.push([command, ...args])
      return Effect.succeed({ exitCode: 0, stdout: FULL, stderr: "" })
    }
    await Effect.runPromise(validateModelCatalog(run, DEFAULT_CONFIG))
    expect(calls).toEqual([["pi", "--list-models"]])
  })

  test("reports the unknown ids from the listing", async () => {
    const error = await Effect.runPromise(
      Effect.flip(validateModelCatalog(runner(0, table([["kimi-coding", "k3"]])), DEFAULT_CONFIG)),
    )
    expect(error._tag).toBe("ModelsNotInCatalog")
  })

  test("a failing pi is a CatalogUnavailable, not an empty catalog", async () => {
    const error = await Effect.runPromise(
      Effect.flip(validateModelCatalog(runner(127, "", "pi: not found"), DEFAULT_CONFIG)),
    )
    expect(error).toMatchObject({ _tag: "CatalogUnavailable", detail: "pi: not found" })
  })
})
