import { describe, expect, test } from "bun:test"

import {
  CAPABILITIES,
  type CapabilityDefinition,
  enabledCapabilities,
  formContent,
} from "../../src/config/capabilities.ts"
import type { Config } from "../../src/config/schema.ts"
import {
  BILLION_CONTEXT_GUARDRAILS_FILE,
  BILLION_CONTEXT_GUARDRAILS_OFF,
} from "../../src/pi/bash/guardrails.ts"
import { justBashEnvironment, justBashOn } from "../../src/pi/bash/settings.ts"
import { toolArgs, toolSettings } from "../../src/pi/tools.ts"
import { DEFAULT_CONFIG } from "../config/defaults.ts"

const withBash = (justBash: boolean, enable = true): Config => ({
  ...DEFAULT_CONFIG,
  pi: { ...DEFAULT_CONFIG.pi, enable, features: { ...DEFAULT_CONFIG.pi.features, justBash } },
})

describe("the just-bash capability entry", () => {
  const entry: CapabilityDefinition | undefined = CAPABILITIES.find(
    (capability) => capability.name === "just-bash",
  )

  test("is on by default, for every provider and role, with a headless and a normal form", () => {
    expect(entry).toMatchObject({
      feature: "justBash",
      defaultOn: true,
      applicability: "both",
      skills: [],
    })
    expect(entry?.provider).toBeUndefined()
    expect(DEFAULT_CONFIG.pi.features.justBash).toBe(true)
    if (entry === undefined) throw new Error("no just-bash capability")
    // The shell needs no display, so both forms are offered and install nothing: Bun runs it.
    for (const form of ["headless", "normal"] as const)
      expect(formContent(entry, form)).toEqual({ packages: [], mcpServers: [] })
    const needs = entry.needs.flatMap((need) => (need.kind === "command" ? [need] : []))
    expect(needs.map((need) => need.command)).toEqual(["bun"])
    expect(needs[0]?.fix).toContain("bun.sh")
  })

  test("is switched off by its own key and by nothing else", () => {
    const names = (config: Config) =>
      enabledCapabilities(config.pi.features, { provider: config.pi.provider }).map(
        (capability) => capability.name,
      )
    expect(names(withBash(true))).toContain("just-bash")
    expect(names(withBash(false))).not.toContain("just-bash")
    expect(names(withBash(false))).toContain("todo")
  })

  test("sets Billion Context's guardrails in its file, only while Billion Context is on", () => {
    const patches = (config: Config) =>
      toolSettings(config).filter(
        (patch) => "guardrails" in patch.content && patch.file.includes("billion-context"),
      )
    expect(patches(withBash(true)).map((patch) => patch.content)).toEqual([
      BILLION_CONTEXT_GUARDRAILS_FILE,
    ])
    expect(patches(withBash(false))).toEqual([])
    expect(patches(withBash(true, false))).toEqual([])
    const noCompression: Config = {
      ...DEFAULT_CONFIG,
      pi: {
        ...DEFAULT_CONFIG.pi,
        features: { ...DEFAULT_CONFIG.pi.features, contextCompression: false },
      },
    }
    expect(patches(noCompression)).toEqual([])
  })
})

describe("Billion Context's bash guardrails", () => {
  test("are three settings, each off in Billion Context's own terms", () => {
    expect(BILLION_CONTEXT_GUARDRAILS_OFF).toEqual({
      BILI_GUARDRAIL_BASH_TIMEOUT: "0",
      BILI_GUARDRAIL_MAX_OUTPUT_BYTES: "0",
      BILI_GUARDRAIL_REPETITION: "0",
    })
    expect(BILLION_CONTEXT_GUARDRAILS_FILE).toEqual({
      guardrails: { bashTimeout: 0, maxOutputBytes: 0, repetition: false },
    })
  })

  test("are turned off in the environment of the root and every specialist while the shell is on", () => {
    expect(justBashOn(withBash(true))).toBe(true)
    expect(justBashEnvironment(withBash(true))).toEqual(BILLION_CONTEXT_GUARDRAILS_OFF)
    for (const key of ["root", "Explorer.map", "Worker.implementation"] as const)
      expect(toolArgs(withBash(true), key).env).toMatchObject(BILLION_CONTEXT_GUARDRAILS_OFF)
  })

  test("are left as they are while the capability or the extension is off", () => {
    for (const config of [withBash(false), withBash(true, false)]) {
      expect(justBashOn(config)).toBe(false)
      expect(justBashEnvironment(config)).toEqual({})
    }
    for (const name of Object.keys(BILLION_CONTEXT_GUARDRAILS_OFF))
      expect(toolArgs(withBash(false), "root").env).not.toHaveProperty(name)
  })
})
