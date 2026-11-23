import { describe, expect, test } from "bun:test"

import piPins from "../../../core/src/config/pi-packages.json" with { type: "json" }
import pypiPins from "../../../core/src/config/pypi-packages.json" with { type: "json" }
import { BROWSE_PACKAGE, FEATURE_PACKAGES } from "../../src/config/capabilities.ts"
import { piPackages, WEB_KIT_PACKAGE } from "../../src/config/packages.ts"
import {
  PI_PACKAGE_VERSIONS,
  type PiPackageName,
  piPackageSource,
} from "../../src/config/pi-packages.ts"
import { PYPI_PACKAGE_VERSIONS } from "../../src/config/pypi-packages.ts"
import type { Config } from "../../src/config/schema.ts"
import { DEFAULT_CONFIG } from "./defaults.ts"

const withFeatures = (features: Partial<Config["pi"]["features"]>): Config => ({
  ...DEFAULT_CONFIG,
  pi: { ...DEFAULT_CONFIG.pi, features: { ...DEFAULT_CONFIG.pi.features, ...features } },
})

const ALL_NAMES: ReadonlyArray<PiPackageName> = [
  "pi-provider-kimi-code",
  ...Object.values(FEATURE_PACKAGES),
  WEB_KIT_PACKAGE,
]

/** The source of a package at its pinned release. */
const pinned = (name: keyof typeof PI_PACKAGE_VERSIONS) =>
  `npm:${name}@${PI_PACKAGE_VERSIONS[name]}`

// Exercise the complete package list on a supported platform regardless of the test host.
const packagesOnLinux = (config: Config) =>
  piPackages(config, undefined, "normal", undefined, "linux-x64")

describe("piPackages", () => {
  test("the default config loads the provider and every feature's package, each pinned", () => {
    expect(packagesOnLinux(DEFAULT_CONFIG)).toEqual([
      `npm:pi-provider-kimi-code@${piPins["pi-provider-kimi-code"]}`,
      `npm:@tintinweb/pi-subagents@${piPins["@tintinweb/pi-subagents"]}`,
      `npm:billion-context@${piPins["billion-context"]}`,
      `npm:@juicesharp/rpiv-todo@${piPins["@juicesharp/rpiv-todo"]}`,
      `npm:@juicesharp/rpiv-ask-user-question@${piPins["@juicesharp/rpiv-ask-user-question"]}`,
      `npm:@aliou/pi-processes@${piPins["@aliou/pi-processes"]}`,
      `npm:@amaster.ai/pi-computer-use@${piPins["@amaster.ai/pi-computer-use"]}`,
      `npm:@ff-labs/pi-fff@${piPins["@ff-labs/pi-fff"]}`,
    ])
  })

  test.each([
    ["processes", "@aliou/pi-processes"],
    ["todo", "@juicesharp/rpiv-todo"],
    ["ask", "@juicesharp/rpiv-ask-user-question"],
    ["computerUse", "@amaster.ai/pi-computer-use"],
    ["fff", "@ff-labs/pi-fff"],
    ["contextCompression", "billion-context"],
    ["subagents", "@tintinweb/pi-subagents"],
  ] as const)("disabling %s drops %s and nothing else", (feature, name) => {
    const all = packagesOnLinux(DEFAULT_CONFIG)
    const without = packagesOnLinux(withFeatures({ [feature]: false }))
    expect(without).toEqual(all.filter((entry) => entry !== pinned(name)))
    expect(without).toHaveLength(all.length - 1)
  })

  test("Windows omits processes while Linux loads it", () => {
    expect(piPackages(DEFAULT_CONFIG, undefined, "normal", undefined, "win32-x64")).not.toContain(
      pinned("@aliou/pi-processes"),
    )
    expect(packagesOnLinux(DEFAULT_CONFIG)).toContain(pinned("@aliou/pi-processes"))
  })

  test("mcp is carried by Pi's built-in extension, so its switch changes no package", () => {
    expect(piPackages(withFeatures({ mcp: false }))).toEqual(piPackages(DEFAULT_CONFIG))
  })

  test("with every feature off only the provider extension remains", () => {
    const off = withFeatures({
      web: "off",
      processes: false,
      todo: false,
      ask: false,
      computerUse: false,
      contextCompression: false,
      subagents: false,
      fff: false,
    })
    expect(piPackages(off)).toEqual([pinned("pi-provider-kimi-code")])
  })

  test("the web mode picks pi-web-kit only when asked for it, the provider offering web tools", () => {
    expect(piPackages(withFeatures({ web: "provider" }))).not.toContain(pinned("pi-web-kit"))
    expect(piPackages(withFeatures({ web: "off" }))).not.toContain(pinned("pi-web-kit"))
    expect(piPackages(withFeatures({ web: "pi-web-kit" }))).toContain("npm:pi-web-kit@0.5.0")
  })
})

describe("piPackages order and pi.enable", () => {
  test("the features follow the order of FEATURE_PACKAGES and the web kit comes last", () => {
    const config = withFeatures({ web: "pi-web-kit" })
    expect(packagesOnLinux(config)).toEqual(ALL_NAMES.map((name) => piPackageSource(name)))
  })

  test("pi.enable off loads nothing, whatever the features say", () => {
    const off: Config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enable: false } }
    expect(piPackages(off)).toEqual([])
    expect(
      piPackages({
        ...off,
        pi: { ...off.pi, features: { ...off.pi.features, web: "pi-web-kit" } },
      }),
    ).toEqual([])
  })

  test("pi.enable on loads the provider extension", () => {
    expect(piPackages(DEFAULT_CONFIG)[0]).toBe(pinned("pi-provider-kimi-code"))
  })
})

describe("the pin table", () => {
  const named = ALL_NAMES.toSorted()

  test("pins exactly the packages the integration can enable and the npm MCP server of browser use (opencode browse), each to an exact stable release", () => {
    // Pi installs neither: each MCP server runs its package through npx at the pin, so they are in
    // the table for the updater and in no list of Pi packages.
    expect(Object.keys(PI_PACKAGE_VERSIONS).toSorted()).toEqual(
      [...named, BROWSE_PACKAGE].toSorted(),
    )
    for (const version of Object.values(PI_PACKAGE_VERSIONS))
      expect(version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  })

  test("the PyPI table pins browser-use exactly and names nothing Pi installs", () => {
    expect(PYPI_PACKAGE_VERSIONS).toEqual({ "browser-use": pypiPins["browser-use"] })
    expect(PYPI_PACKAGE_VERSIONS["browser-use"]).toMatch(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    )
    for (const name of Object.keys(PYPI_PACKAGE_VERSIONS))
      expect(Object.keys(PI_PACKAGE_VERSIONS)).not.toContain(name)
  })

  test("every source piPackages returns reads its version from the table", () => {
    const everything = withFeatures({ web: "pi-web-kit" })
    expect(packagesOnLinux(everything).toSorted()).toEqual(
      named.map((name) => piPackageSource(name)).toSorted(),
    )
  })
})
