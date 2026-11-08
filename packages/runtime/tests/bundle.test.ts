import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { bundleModule } from "../src/bundle.ts"

const inFolder = async (run: (folder: string) => Promise<void>) => {
  const folder = await mkdtemp(join(tmpdir(), "holyagent-bundle-"))
  try {
    await run(folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

describe("bundleModule", () => {
  test("a bun bundle keeps the pragma first and puts the note right after it", async () => {
    await inFolder(async (folder) => {
      await Bun.write(join(folder, "dep.ts"), "export const dep = 1\n")
      await Bun.write(
        join(folder, "entry.ts"),
        '#!/usr/bin/env bun\nimport { dep } from "./dep.ts"\nconsole.log(dep)\n',
      )
      const text = await Effect.runPromise(
        bundleModule(join(folder, "entry.ts"), { target: "bun", note: "Generated from entry.ts." }),
      )
      const lines = text.split("\n")
      expect(lines.at(lines.indexOf("// @bun") + 1)).toBe("// Generated from entry.ts.")
      expect(lines.filter((line) => /^\/\/ .*\.ts$/.test(line))).toEqual([])
      expect(text).toContain("dep = 1")
    })
  })

  test("a node bundle starts with the note and leaves external modules as imports", async () => {
    await inFolder(async (folder) => {
      await Bun.write(
        join(folder, "entry.ts"),
        'import { host } from "host-module/sub"\nexport default () => host\n',
      )
      const text = await Effect.runPromise(
        bundleModule(join(folder, "entry.ts"), {
          target: "node",
          note: "Generated from entry.ts.",
          external: ["host-module", "host-module/*"],
        }),
      )
      expect(text).toStartWith("// Generated from entry.ts.\n")
      expect(text).toContain('from "host-module/sub"')
    })
  })

  test("an entrypoint that does not exist fails as BundleFailed that names it", async () => {
    const missing = join(tmpdir(), "holyagent-bundle-missing", "entry.ts")
    const error = await Effect.runPromise(
      Effect.flip(bundleModule(missing, { target: "bun", note: "n" })),
    )
    expect(error._tag).toBe("BundleFailed")
    expect(error.message).toContain(missing)
  })
})
