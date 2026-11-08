import { describe, expect, test } from "bun:test"

import { Effect, Schema } from "effect"

import { piPackages } from "../../src/config/packages.ts"
import { PI_PACKAGE_VERSIONS } from "../../src/config/pi-packages.ts"
import { Config, PiProvider } from "../../src/config/schema.ts"
import { RoleTask } from "../../src/domain/route.ts"
import {
  providerEnv,
  PROVIDERS,
  providerSource,
  routedModels,
  routeModel,
} from "../../src/pi/provider.ts"
import { DEFAULT_CONFIG } from "../config/defaults.ts"

const decode = (value: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })(value))

/** The decided routing of Intent 0.3.0 pi 5/10, as the `--model` values Pi takes. */
const DECIDED: Readonly<Record<string, string>> = {
  root: "kimi-coding/k3.1-pro:high",
  "Worker.implementation": "kimi-coding/kimi-for-coding:max",
  "Worker.debugging": "kimi-coding/kimi-for-coding:max",
  "Worker.integration": "kimi-coding/kimi-for-coding:max",
  "Reviewer.code": "kimi-coding/kimi-for-coding:max",
  "Reviewer.security": "kimi-coding/kimi-for-coding:max",
  "Reviewer.testing": "kimi-coding/kimi-for-coding:max",
  "Reviewer.artifact": "kimi-coding/kimi-for-coding:max",
  "Worker.mechanical": "kimi-coding/kimi-for-coding:high",
  "Worker.validation": "kimi-coding/kimi-for-coding:high",
  "Worker.operations": "kimi-coding/kimi-for-coding:high",
  "Explorer.map": "kimi-coding/kimi-for-coding:high",
  "Explorer.lookup": "kimi-coding/kimi-for-coding:high",
  "Explorer.trace": "kimi-coding/kimi-for-coding:high",
  "Librarian.lookup": "kimi-coding/kimi-for-coding:high",
  "Librarian.research": "kimi-coding/kimi-for-coding:high",
  "Reviewer.audit": "kimi-coding/kimi-for-coding:high",
  "Worker.visual": "kimi-coding/k3.1-pro:low",
  "Reviewer.visual": "kimi-coding/k3.1-pro:low",
}

describe("routeModel", () => {
  test("maps the root and each of the 18 specialists as the decided routing says", () => {
    const keys = ["root", ...RoleTask.literals] as const
    expect(keys).toHaveLength(19)
    expect(
      Object.fromEntries(keys.map((key) => [key, routeModel(DEFAULT_CONFIG, key).spec])),
    ).toEqual(DECIDED)
  })

  test("splits the spec into provider, model and thinking level", () => {
    expect(routeModel(DEFAULT_CONFIG, "Worker.visual")).toEqual({
      key: "Worker.visual",
      provider: "kimi-coding",
      model: "k3.1-pro",
      thinking: "low",
      spec: "kimi-coding/k3.1-pro:low",
    })
  })

  test("follows a per-role override and leaves the other rows alone", async () => {
    const config = await decode({
      pi: { routes: { "Worker.debugging": { model: "k3.1-pro", thinking: "high" } } },
    })
    expect(routeModel(config, "Worker.debugging").spec).toBe("kimi-coding/k3.1-pro:high")
    expect(routeModel(config, "Worker.implementation").spec).toBe("kimi-coding/kimi-for-coding:max")
  })

  test("an override with an unknown thinking level or an empty model does not decode", async () => {
    for (const routes of [
      { root: { thinking: "ultra" } },
      { root: { model: "" } },
      { "Worker.unknown": { model: "x" } },
    ]) {
      await expect(decode({ pi: { routes } })).rejects.toThrow()
    }
  })

  test("routedModels lists every row once, the root first", () => {
    const rows = routedModels(DEFAULT_CONFIG)
    expect(rows[0]?.key).toBe("root")
    expect(rows.map(({ key }) => String(key)).sort()).toEqual(["root", ...RoleTask.literals].sort())
    expect(rows.map(({ spec }) => spec).sort()).toEqual(Object.values(DECIDED).sort())
  })
})

describe("the provider profile", () => {
  test("Kimi for Coding (global) is the only provider the config accepts", () => {
    expect(PiProvider.literals).toEqual(["kimi-coding-global"])
    expect(Object.keys(PROVIDERS)).toEqual(["kimi-coding-global"])
  })

  test("the launcher environment sets the global region", () => {
    expect(providerEnv(DEFAULT_CONFIG)).toEqual({ KIMI_CODE_REGION: "global" })
  })

  test("the extension is pinned to an exact release, the one the pin table holds", () => {
    expect(providerSource(DEFAULT_CONFIG)).toBe(
      `npm:pi-provider-kimi-code@${PI_PACKAGE_VERSIONS["pi-provider-kimi-code"]}`,
    )
    expect(providerSource(DEFAULT_CONFIG)).toBe("npm:pi-provider-kimi-code@0.6.13")
  })

  test("selecting the provider loads its pinned extension; pi.enable off loads nothing", () => {
    expect(piPackages(DEFAULT_CONFIG)[0]).toBe(providerSource(DEFAULT_CONFIG))
    const off: Config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enable: false } }
    expect(piPackages(off)).not.toContain(providerSource(DEFAULT_CONFIG))
  })
})
