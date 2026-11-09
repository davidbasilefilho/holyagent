import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import {
  checkModelCatalog,
  ModelsNotInCatalog,
  parseModelCatalog,
  validateModelCatalog,
} from "../../src/pi/catalog.ts"
import { type CommandRunner, DETAIL_CHARS } from "../../src/pi/readiness.ts"
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

  test("ignores lines that are not rows: a footer, a note, a short line", () => {
    const text = `${FULL}\n3 models listed\nShowing 3 of 3 models (1 hidden by --search)\nnote: kimi-coding\n`
    expect(parseModelCatalog(text)).toEqual(parseModelCatalog(FULL))
    expect(parseModelCatalog(text)).toHaveLength(3)
  })

  test("reads any provider id the columns allow, not only lowercase ones", () => {
    const text = table([
      ["Azure-OpenAI", "gpt-5"],
      ["_internal", "m.1"],
      ["kimi-coding", "k3.1-pro"],
    ])
    expect(parseModelCatalog(text)).toEqual([
      { provider: "Azure-OpenAI", model: "gpt-5" },
      { provider: "_internal", model: "m.1" },
      { provider: "kimi-coding", model: "k3.1-pro" },
    ])
  })

  test("ignores a line with fewer columns than the header", () => {
    expect(parseModelCatalog(`${FULL}Some-Provider  some-model\n`)).toHaveLength(3)
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

  test("a listing without a model is NoModelsListed, not a list of missing ids", async () => {
    for (const stdout of ["", " \n", 'No models matching "kimi"\n', table([])]) {
      const error = await Effect.runPromise(
        Effect.flip(validateModelCatalog(runner(0, stdout), DEFAULT_CONFIG)),
      )
      expect(error._tag).toBe("NoModelsListed")
      expect(error.message).toContain("credentials")
    }
  })

  test("output that is not a model table is reported as an unrecognised format, not as credentials", async () => {
    for (const stdout of [
      "KIMI-CODING\tk3.1-pro\nanthropic\tclaude-sonnet-5\n",
      "Error: something Pi changed\n",
    ]) {
      const error = await Effect.runPromise(
        Effect.flip(validateModelCatalog(runner(0, stdout), DEFAULT_CONFIG)),
      )
      expect(error._tag).toBe("ListingNotRecognised")
      expect(error.message).toContain("format was not recognised")
      expect(error.message).toContain(stdout.trim().split("\n")[0]!)
      expect(error.message).not.toContain("credentials")
    }
  })

  test("an unrecognised listing shows at most the report length of the output", async () => {
    const error = await Effect.runPromise(
      Effect.flip(validateModelCatalog(runner(0, "z".repeat(1000)), DEFAULT_CONFIG)),
    )
    expect(error).toMatchObject({ _tag: "ListingNotRecognised", detail: "z".repeat(DETAIL_CHARS) })
  })

  test("a footer after the rows does not hide a missing id", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        validateModelCatalog(
          runner(0, `${table([["kimi-coding", "kimi-for-coding"]])}\n1 model listed\n`),
          DEFAULT_CONFIG,
        ),
      ),
    )
    expect(error._tag).toBe("ModelsNotInCatalog")
  })

  test("a failing pi reports the same detail as the readiness check, cut short", async () => {
    const error = await Effect.runPromise(
      Effect.flip(validateModelCatalog(runner(1, "x".repeat(1000)), DEFAULT_CONFIG)),
    )
    expect(error).toMatchObject({ _tag: "CatalogUnavailable", detail: "x".repeat(DETAIL_CHARS) })
  })

  test("a failing pi leads with stderr, so a banner on stdout cannot hide the error", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        validateModelCatalog(runner(1, "pi 1.x banner\n", "error: no such flag\n"), DEFAULT_CONFIG),
      ),
    )
    expect(error).toMatchObject({
      _tag: "CatalogUnavailable",
      detail: "error: no such flag\npi 1.x banner",
    })
  })

  test("a failing pi that prints nothing reports its exit code", async () => {
    const error = await Effect.runPromise(
      Effect.flip(validateModelCatalog(runner(3, " \n", " "), DEFAULT_CONFIG)),
    )
    expect(error).toMatchObject({ _tag: "CatalogUnavailable", detail: "pi exited with code 3" })
  })

  test("a failing pi is a CatalogUnavailable, not an empty catalog", async () => {
    const error = await Effect.runPromise(
      Effect.flip(validateModelCatalog(runner(127, "", "pi: not found"), DEFAULT_CONFIG)),
    )
    expect(error).toMatchObject({ _tag: "CatalogUnavailable", detail: "pi: not found" })
  })
})

describe("ModelsNotInCatalog.brief", () => {
  test("names the models without their rows and ends with the fix, within a notice's length", () => {
    const error = new ModelsNotInCatalog({
      provider: "kimi-coding",
      missing: [
        { model: "k3.1-pro", routes: ["root", "Worker.visual"] },
        { model: "kimi-for-coding", routes: ["Explorer.map", "Explorer.lookup"] },
      ],
    })
    expect(error.brief).toBe(
      "Provider kimi-coding does not list: k3.1-pro, kimi-for-coding. Change the model in pi.routes of config.json or log in to a plan that has it.",
    )
    expect(error.message).toContain("(used by root, Worker.visual)")
    expect(error.message.endsWith(error.brief.slice(error.brief.indexOf("Change")))).toBe(true)
  })
})
