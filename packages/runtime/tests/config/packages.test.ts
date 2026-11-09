import { describe, expect, test } from "bun:test"

import { FEATURE_PACKAGES } from "../../src/config/capabilities.ts"
import { piPackages, WEB_KIT_PACKAGE } from "../../src/config/packages.ts"
import {
  PI_PACKAGE_VERSIONS,
  type PiPackageName,
  piPackageSource,
} from "../../src/config/pi-packages.ts"
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

describe("piPackages", () => {
  test("the default config loads the provider and every feature's package, each pinned", () => {
    expect(piPackages(DEFAULT_CONFIG)).toEqual([
      "npm:pi-provider-kimi-code@0.6.13",
      "npm:@tintinweb/pi-subagents@0.23.1",
      "npm:billion-context@0.1.212",
      "npm:@juicesharp/rpiv-todo@2.15.0",
      "npm:@juicesharp/rpiv-ask-user-question@2.15.0",
      "npm:@aliou/pi-processes@0.13.6",
      "npm:@amaster.ai/pi-computer-use@0.1.36",
      "npm:@ff-labs/pi-fff@0.11.0",
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
    const all = piPackages(DEFAULT_CONFIG)
    const without = piPackages(withFeatures({ [feature]: false }))
    expect(without).toEqual(all.filter((entry) => entry !== pinned(name)))
    expect(without).toHaveLength(all.length - 1)
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
    expect(piPackages(config)).toEqual(ALL_NAMES.map((name) => piPackageSource(name)))
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

  test("pins exactly the packages the integration can enable, each to an exact stable release", () => {
    expect(Object.keys(PI_PACKAGE_VERSIONS).toSorted()).toEqual(named)
    for (const version of Object.values(PI_PACKAGE_VERSIONS))
      expect(version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  })

  test("every source piPackages returns reads its version from the table", () => {
    const everything = withFeatures({ web: "pi-web-kit" })
    expect(piPackages(everything).toSorted()).toEqual(
      named.map((name) => piPackageSource(name)).toSorted(),
    )
  })
})
