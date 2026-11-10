import { describe, expect, test } from "bun:test"

import { Effect, Schema } from "effect"

import { CAPABILITIES, enabledCapabilities } from "../../src/config/capabilities.ts"
import { Config, ConfigFile } from "../../src/config/schema.ts"
import { DEFAULT_CONFIG } from "../config/defaults.ts"

describe("the auto-review capability entry", () => {
  const entry = CAPABILITIES.find((capability) => capability.name === "auto-review")

  test("is its own capability, on by default, for the Codex provider only, with no package, tool or setting", () => {
    expect(entry).toMatchObject({
      feature: "autoReview",
      defaultOn: true,
      provider: "openai-codex",
      applicability: "both",
      settings: [],
      skills: [],
    })
    expect(entry?.tools).toEqual({ rootExclude: [], visual: [], screen: [] })
    expect(entry?.forms.headless).toEqual({ packages: [], mcpServers: [] })
    expect(DEFAULT_CONFIG.pi.features.autoReview).toBe(true)
  })

  test("is listed for the Codex provider, left out under any other, and follows its switch", () => {
    const features = DEFAULT_CONFIG.pi.features
    const names = (provider: "kimi-coding-global" | "openai-codex", on = true) =>
      enabledCapabilities({ ...features, autoReview: on }, { provider }).map(
        (capability) => capability.name,
      )
    expect(names("openai-codex")).toContain("auto-review")
    expect(names("kimi-coding-global")).not.toContain("auto-review")
    expect(names("openai-codex", false)).not.toContain("auto-review")
  })
})

describe("the policy text in the config", () => {
  const decode = (value: unknown) =>
    Effect.runPromise(Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })(value))

  test("is empty by default, and takes a replacement and an extra policy", async () => {
    expect(DEFAULT_CONFIG.pi.autoReview).toEqual({})
    const config = await decode({
      pi: { autoReview: { policy: "Own policy.", extraPolicy: "More." } },
    })
    expect(config.pi.autoReview).toEqual({ policy: "Own policy.", extraPolicy: "More." })
  })

  test("refuses a key it does not know and a value that is not text", async () => {
    const file = (value: unknown) =>
      Effect.runPromise(
        Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })({
          pi: { autoReview: value },
        }),
      )
    await expect(file({ rules: [] })).rejects.toThrow()
    await expect(file({ policy: 3 })).rejects.toThrow()
  })
})
