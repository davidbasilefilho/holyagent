import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { Effect, Schema } from "effect"

import {
  CAPABILITIES,
  type CapabilityDefinition,
  capabilityPackages,
  enabledCapabilities,
  FEATURE_DEFAULTS,
  FEATURE_PACKAGES,
  managedCapabilityPackages,
  unavailableIn,
} from "../../src/config/capabilities.ts"
import { piPackages } from "../../src/config/packages.ts"
import { PI_PACKAGE_VERSIONS, piPackageSource } from "../../src/config/pi-packages.ts"
import { Config, ConfigFile } from "../../src/config/schema.ts"
import { toolSettings } from "../../src/pi/tools.ts"
import { DEFAULT_CONFIG } from "./defaults.ts"

const withFeatures = (features: Record<string, unknown>) => ({
  ...DEFAULT_CONFIG,
  pi: { ...DEFAULT_CONFIG.pi, features: { ...DEFAULT_CONFIG.pi.features, ...features } },
})

/**
 * A capability a later change would add as one entry: a package on a headless machine, another
 * otherwise.
 */
const SYNTHETIC: CapabilityDefinition = {
  name: "screen-shot",
  feature: "screenShot",
  description: "A made-up capability for the tests",
  skills: ["shot"],
  applicability: "both",
  defaultOn: false,
  needs: [],
  forms: {
    headless: { packages: ["pi-web-kit"], mcpServers: [] },
    normal: { packages: ["billion-context", "pi-web-kit"], mcpServers: [] },
  },
  tools: { rootExclude: [], visual: [] },
  settings: [],
  health: ["packages"],
}

describe("the capability registry", () => {
  test("every entry is one switch of pi.features with the registry's default, and no other switch exists", async () => {
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(Config)({}))
    const features = decoded.pi.features as Record<string, unknown>
    expect(Object.keys(features).toSorted()).toEqual(
      ["web", ...CAPABILITIES.map((capability) => capability.feature)].toSorted(),
    )
    for (const capability of CAPABILITIES)
      expect(features[capability.feature]).toBe(capability.defaultOn)
    expect(Object.entries(FEATURE_DEFAULTS)).toEqual(
      CAPABILITIES.map((capability) => [capability.feature, true]),
    )
  })

  test("names and features are unique, and a name is a kebab-case flag", () => {
    expect(new Set(CAPABILITIES.map((capability) => capability.name)).size).toBe(
      CAPABILITIES.length,
    )
    expect(new Set(CAPABILITIES.map((capability) => capability.feature)).size).toBe(
      CAPABILITIES.length,
    )
    for (const capability of CAPABILITIES) expect(capability.name).toMatch(/^[a-z]+(-[a-z]+)*$/)
  })

  test("every package an entry names is a pin of pi-packages.json, and the registry holds no version", async () => {
    for (const capability of CAPABILITIES)
      for (const form of ["headless", "normal"] as const)
        for (const name of capabilityPackages({ [capability.feature]: true }, form))
          expect(PI_PACKAGE_VERSIONS[name]).toMatch(/^\d+\.\d+\.\d+$/)
    const source = await Bun.file(
      join(import.meta.dir, "..", "..", "src", "config", "capabilities.ts"),
    ).text()
    expect(source).not.toMatch(/\d+\.\d+\.\d+/)
  })

  test("0.3.0 config files still decode and mean the same: every feature key of that release, strictly", async () => {
    const written = {
      pi: {
        features: {
          web: "off",
          processes: false,
          todo: true,
          ask: false,
          mcp: false,
          computerUse: false,
          contextCompression: true,
          subagents: false,
        },
      },
    } as const
    const file = await Effect.runPromise(
      Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })(written),
    )
    expect(file).toEqual(written)
    const config = await Effect.runPromise(Schema.decodeUnknownEffect(Config)(written))
    // Only the keys a later release added (the Codex provider's Luna Reserve and context_management) take their default.
    expect(config.pi.features).toEqual({
      ...written.pi.features,
      lunaReserve: true,
      contextManagement: true,
    })
    const unknown = Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })({
      pi: { features: { notACapability: true } },
    })
    await expect(Effect.runPromise(unknown)).rejects.toThrow()
  })

  test("the packages of the default config are what the 0.3.0 table loaded, in the same order", () => {
    expect(piPackages(DEFAULT_CONFIG)).toEqual([
      piPackageSource("pi-provider-kimi-code"),
      ...(
        ["subagents", "contextCompression", "todo", "ask", "processes", "computerUse"] as const
      ).map((feature) => piPackageSource(FEATURE_PACKAGES[feature])),
    ])
  })
})

describe("registry-driven selection", () => {
  test("enabledCapabilities keeps the registry order and drops what is off or not offered in the form", () => {
    const names = (features: Record<string, unknown>, form?: "headless" | "normal") =>
      enabledCapabilities(features, form === undefined ? {} : { form }).map(
        (capability) => capability.name,
      )
    const all = Object.fromEntries(CAPABILITIES.map((capability) => [capability.feature, true]))
    expect(names(all)).toEqual(CAPABILITIES.map((capability) => capability.name))
    expect(names({ ...all, todo: false })).not.toContain("todo")
    expect(names(all, "headless")).not.toContain("computer-use")
    expect(names(all, "normal")).toContain("computer-use")
    expect(names({})).toEqual([])
  })

  test("a form that differs in packages selects its own, and a form the entry does not offer selects none", () => {
    const features = { screenShot: true, todo: true }
    const definitions = [...CAPABILITIES, SYNTHETIC]
    expect(capabilityPackages(features, "normal", definitions)).toEqual([
      "@juicesharp/rpiv-todo",
      "billion-context",
      "pi-web-kit",
    ])
    expect(capabilityPackages(features, "headless", definitions)).toEqual([
      "@juicesharp/rpiv-todo",
      "pi-web-kit",
    ])
    expect(capabilityPackages({ screenShot: false }, "normal", definitions)).toEqual([])
    expect(unavailableIn(SYNTHETIC, "headless")).toBeUndefined()
    expect(capabilityPackages({ computerUse: true }, "headless")).toEqual([])
    expect(capabilityPackages({ computerUse: true }, "normal")).toEqual([
      "@amaster.ai/pi-computer-use",
    ])
  })

  test("piPackages applies the form: the headless form leaves out computer use, and an added entry is one more package", () => {
    const headless = piPackages(DEFAULT_CONFIG, undefined, "headless")
    expect(headless).toEqual(
      piPackages(DEFAULT_CONFIG).filter((source) => !source.includes("pi-computer-use")),
    )
    const added = piPackages(withFeatures({ screenShot: true }), undefined, "headless", [
      ...CAPABILITIES,
      SYNTHETIC,
    ])
    expect(added.at(-1)).toBe(piPackageSource("pi-web-kit"))
    expect(added).toHaveLength(headless.length + 1)
  })

  test("the managed packages cover every form, so setup can remove a package its form no longer loads", () => {
    expect(managedCapabilityPackages([...CAPABILITIES, SYNTHETIC])).toEqual([
      "@tintinweb/pi-subagents",
      "billion-context",
      "@juicesharp/rpiv-todo",
      "@juicesharp/rpiv-ask-user-question",
      "@aliou/pi-processes",
      "@amaster.ai/pi-computer-use",
      "pi-web-kit",
    ])
    expect(managedCapabilityPackages()).toContain("@amaster.ai/pi-computer-use")
  })
})

describe("registry-driven tool settings", () => {
  const files = (config: Parameters<typeof toolSettings>[0], form?: "headless" | "normal") =>
    toolSettings(config, undefined, form).map((patch) => patch.file)

  test("each enabled capability contributes its settings, in registry order", () => {
    const settingsOf = (capability: CapabilityDefinition) => capability.settings
    expect(toolSettings(DEFAULT_CONFIG).slice(-3)).toEqual(CAPABILITIES.flatMap(settingsOf))
  })

  test("a capability that is off or not offered in the form writes no settings", () => {
    const computerUse = CAPABILITIES.find((capability) => capability.feature === "computerUse")
    const patch = computerUse?.settings[0]
    if (patch === undefined) throw new Error("computer use carries no settings")
    expect(toolSettings(DEFAULT_CONFIG)).toContainEqual(patch)
    expect(toolSettings(DEFAULT_CONFIG, undefined, "headless")).not.toContainEqual(patch)
    expect(toolSettings(withFeatures({ computerUse: false }))).not.toContainEqual(patch)
    expect(files(withFeatures({ subagents: false }))).not.toContain("~/.pi/agent/subagents.json")
    expect(files(DEFAULT_CONFIG, "headless")).toContain("~/.pi/agent/subagents.json")
  })
})
