import { describe, expect, test } from "bun:test"

import { FEATURE_PACKAGES, piPackages, WEB_KIT_PACKAGE } from "../../src/config/packages.ts"
import type { Config } from "../../src/config/schema.ts"
import { DEFAULT_CONFIG } from "./defaults.ts"

const withFeatures = (features: Partial<Config["pi"]["features"]>): Config => ({
  ...DEFAULT_CONFIG,
  pi: { ...DEFAULT_CONFIG.pi, features: { ...DEFAULT_CONFIG.pi.features, ...features } },
})

describe("piPackages", () => {
  test("the default config loads the provider and every feature's package", () => {
    expect(piPackages(DEFAULT_CONFIG)).toEqual([
      "pi-provider-kimi-code",
      "@tintinweb/pi-subagents",
      "billion-context",
      "@juicesharp/rpiv-todo",
      "@juicesharp/rpiv-ask-user-question",
      "@aliou/pi-processes",
      "@amaster.ai/pi-computer-use",
    ])
  })

  test.each([
    ["processes", "@aliou/pi-processes"],
    ["todo", "@juicesharp/rpiv-todo"],
    ["ask", "@juicesharp/rpiv-ask-user-question"],
    ["computerUse", "@amaster.ai/pi-computer-use"],
    ["contextCompression", "billion-context"],
    ["subagents", "@tintinweb/pi-subagents"],
  ] as const)("disabling %s drops %s and nothing else", (feature, name) => {
    const all = piPackages(DEFAULT_CONFIG)
    const without = piPackages(withFeatures({ [feature]: false }))
    expect(without).toEqual(all.filter((entry) => entry !== name))
    expect(without).toHaveLength(all.length - 1)
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
    })
    expect(piPackages(off)).toEqual(["pi-provider-kimi-code"])
  })

  test("the web mode picks pi-web-kit only when asked for it", () => {
    expect(piPackages(withFeatures({ web: "provider" }))).not.toContain("pi-web-kit")
    expect(piPackages(withFeatures({ web: "off" }))).not.toContain("pi-web-kit")
    expect(piPackages(withFeatures({ web: "pi-web-kit" }))).toContain("pi-web-kit")
  })
})

describe("piPackages order and pi.enable", () => {
  test("the features follow the order of FEATURE_PACKAGES and the web kit comes last", () => {
    const config = withFeatures({ web: "pi-web-kit" })
    expect(piPackages(config)).toEqual([
      "pi-provider-kimi-code",
      ...Object.values(FEATURE_PACKAGES),
      WEB_KIT_PACKAGE,
    ])
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
    expect(piPackages(DEFAULT_CONFIG)[0]).toBe("pi-provider-kimi-code")
  })
})
