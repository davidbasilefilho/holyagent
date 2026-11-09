import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { Effect, Schema } from "effect"

import {
  BROWSE_TOOLS,
  CAPABILITIES,
  type CapabilityDefinition,
  capabilityPackages,
  COMPUTER_USE_TOOLS,
  enabledCapabilities,
  FEATURE_DEFAULTS,
  FEATURE_PACKAGES,
  formContent,
  managedCapabilityPackages,
  T3_PREVIEW_TOOLS,
  T3_VISUAL_TOOLS,
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
  tools: { rootExclude: [], visual: [], screen: [] },
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
    // Only the keys a later release added (the Codex provider's Luna Reserve and context_management,
    // the just-bash shell, fff and browser use) take their default.
    expect(config.pi.features).toEqual({
      ...written.pi.features,
      lunaReserve: true,
      contextManagement: true,
      justBash: true,
      fff: true,
      browserUse: true,
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
        [
          "subagents",
          "contextCompression",
          "todo",
          "ask",
          "processes",
          "computerUse",
          "fff",
        ] as const
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
      "@ff-labs/pi-fff",
      "pi-web-kit",
    ])
    expect(managedCapabilityPackages()).toContain("@amaster.ai/pi-computer-use")
  })
})

describe("the fff capability", () => {
  const fff = CAPABILITIES.find((capability) => capability.name === "fff")
  const source = piPackageSource("@ff-labs/pi-fff")

  test("loads @ff-labs/pi-fff at its exact pin in both forms, behind the pi.features.fff switch, on by default", () => {
    expect(source).toBe("npm:@ff-labs/pi-fff@0.11.0")
    expect(fff?.feature).toBe("fff")
    expect(fff?.defaultOn).toBe(true)
    expect(piPackages(DEFAULT_CONFIG, undefined, "normal")).toContain(source)
    expect(piPackages(DEFAULT_CONFIG, undefined, "headless")).toContain(source)
    expect(piPackages(withFeatures({ fff: false }))).not.toContain(source)
  })

  test("is offered on every platform its native library covers: macOS, Linux and Windows on x64 and arm64", () => {
    for (const host of [
      "darwin-x64",
      "darwin-arm64",
      "linux-x64",
      "linux-arm64",
      "win32-x64",
      "win32-arm64",
    ])
      for (const form of ["headless", "normal"] as const) {
        expect(fff && unavailableIn(fff, form, host)).toBeUndefined()
        expect(piPackages(DEFAULT_CONFIG, undefined, form, CAPABILITIES, host)).toContain(source)
      }
  })

  test("is unavailable where the native library has no build, and then loads no package and writes no setting", () => {
    for (const host of ["freebsd-x64", "linux-ia32", "linux-riscv64", "win32-ia32", "sunos-x64"]) {
      expect(fff && unavailableIn(fff, "normal", host)).toContain(host)
      expect(capabilityPackages({ fff: true }, "normal", CAPABILITIES, host)).toEqual([])
      expect(piPackages(DEFAULT_CONFIG, undefined, "normal", CAPABILITIES, host)).not.toContain(
        source,
      )
      expect(
        enabledCapabilities({ fff: true }, { form: "normal", platform: host }).map(
          (capability) => capability.name,
        ),
      ).toEqual([])
      expect(
        toolSettings(DEFAULT_CONFIG, undefined, "normal", host).filter((patch) =>
          patch.file.endsWith("pi-fff.json"),
        ),
      ).toEqual([])
    }
    // Setup still manages the package everywhere, so it can remove one a host no longer offers.
    expect(managedCapabilityPackages()).toContain("@ff-labs/pi-fff")
  })

  test("another capability is not held back by the host", () => {
    expect(
      capabilityPackages({ todo: true, fff: true }, "normal", CAPABILITIES, "freebsd-x64"),
    ).toEqual(["@juicesharp/rpiv-todo"])
  })
})

describe("registry-driven tool settings", () => {
  const files = (config: Parameters<typeof toolSettings>[0], form?: "headless" | "normal") =>
    toolSettings(config, undefined, form).map((patch) => patch.file)

  test("each enabled capability contributes its settings, in registry order", () => {
    const settingsOf = (capability: CapabilityDefinition) => capability.settings
    const all = CAPABILITIES.flatMap(settingsOf)
    expect(toolSettings(DEFAULT_CONFIG).slice(-all.length)).toEqual(all)
  })

  test("a patch that names `whileOn` is written only while that capability is on", () => {
    const features = new Set<string>(CAPABILITIES.map((capability) => capability.feature))
    const patches = (CAPABILITIES as ReadonlyArray<CapabilityDefinition>).flatMap(
      (capability) => capability.settings,
    )
    const dependent = patches.filter((patch) => patch.whileOn !== undefined)
    expect(dependent.length).toBeGreaterThan(0)
    for (const patch of dependent) {
      expect(features.has(patch.whileOn ?? "")).toBe(true)
      expect(toolSettings(DEFAULT_CONFIG)).toContainEqual(patch)
    }
    const off = toolSettings(withFeatures({ contextCompression: false }))
    for (const patch of dependent.filter((entry) => entry.whileOn === "contextCompression"))
      expect(off).not.toContainEqual(patch)
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

describe("the browser-use capability entry", () => {
  const entry = CAPABILITIES.find((capability) => capability.name === "browser-use")

  test("is on by default for the specialists, and offers browse's MCP server in the normal form only", () => {
    expect(entry).toMatchObject({
      feature: "browserUse",
      defaultOn: true,
      applicability: "specialists",
      skills: [],
      settings: [],
    })
    expect(entry?.forms.normal).toEqual({
      packages: [],
      mcpServers: [
        { name: "browse", command: "npx", args: ["-y", "@opencode/browse@0.0.15", "mcp"] },
      ],
    })
    expect(entry === undefined ? undefined : formContent(entry, "headless")).toBeUndefined()
    expect(entry?.forms.headless).toHaveProperty("unavailable")
    expect(DEFAULT_CONFIG.pi.features.browserUse).toBe(true)
  })

  test("needs a graphical session and npx, and probes its needs and its pairing", () => {
    expect(
      entry?.needs.map((need) => (need.kind === "display" ? "display" : need.command)),
    ).toEqual(["display", "npx"])
    expect(entry?.health).toEqual(["needs", "pairing"])
  })

  test("grants browse's tools to a screen Assignment and keeps them from the root and the visual roles", () => {
    expect(entry?.tools).toEqual({
      rootExclude: ["mcp__browse__*"],
      visual: [],
      screen: ["mcp__browse__*"],
    })
  })

  test("loads no Pi package in either form: the server runs through npx at the pin", () => {
    for (const form of ["headless", "normal"] as const)
      expect(capabilityPackages({ browserUse: true }, form)).toEqual([])
    expect(managedCapabilityPackages()).not.toContain("@opencode/browse")
  })

  test("only computer use, browse and T3's preview tools are granted by the screen capability", () => {
    expect(
      CAPABILITIES.filter((capability) => capability.tools.screen.length > 0).map(
        (capability) => capability.name,
      ),
    ).toEqual(["mcp", "computer-use", "browser-use"])
    expect(CAPABILITIES.flatMap((capability) => capability.tools.screen).toSorted()).toEqual(
      [...T3_PREVIEW_TOOLS, ...COMPUTER_USE_TOOLS, ...BROWSE_TOOLS].toSorted(),
    )
    for (const tool of T3_PREVIEW_TOOLS) expect(T3_VISUAL_TOOLS).toContain(tool)
  })
})
