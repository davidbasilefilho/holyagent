import { expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { readdir, realpath, rm, symlink } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { SetupProgress, type SetupProgressUpdate } from "../../core/src/setup/progress.ts"
import { CODEX_ASSET_VERSION, CODEX_MARKETPLACE, CODEX_PLUGIN } from "../src/setup/codex/assets.ts"
import {
  type CodexSetupOptions,
  sameCodexMarketplacePath,
  setupCodex,
} from "../src/setup/codex/setup.ts"
import {
  CODEX_STARTUP_MARKETPLACE,
  codexStartupConfig,
  codexStartupFiles,
  StartupStageError,
} from "../src/setup/codex/startup.ts"
import { Shell, type ShellResult } from "../src/setup/shell.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"

const marketAt = (home: string) => join(home, CODEX_STARTUP_MARKETPLACE)
const configAt = (home: string) => join(home, "config.toml")
const receiptAt = (home: string) => join(home, "holyagent", "setup-v1.json")
const pluginCache = (home: string) =>
  join(home, "plugins", "cache", CODEX_MARKETPLACE, "holyagent", CODEX_ASSET_VERSION)
const sourceTree = join(CODEX_STARTUP_MARKETPLACE, "plugins", "holyagent")
const manifestAt = (market: string) => join(market, ".agents", "plugins", "marketplace.json")
const pluginSection = "[plugins." + JSON.stringify(CODEX_PLUGIN) + "]\nenabled = true\n"
const marketSection = (source: string, type = "local", literal = false) =>
  "[marketplaces." +
  JSON.stringify(CODEX_MARKETPLACE) +
  "]\nsource = " +
  (literal ? "'" + source + "'" : JSON.stringify(source)) +
  "\nsource_type = " +
  JSON.stringify(type) +
  "\n"
const extraSettings =
  '# Existing native choices\n[notice]\nhide_full_access_warning = true\n\n[marketplaces."unrelated"]\nsource = "https://example.invalid/other"\nsource_type = "git"\n'
const pluginList = ["plugin", "list", "--marketplace", CODEX_MARKETPLACE, "--json"]
const helpProbes = [
  ["plugin", "marketplace", "add", "--help"],
  ["plugin", "add", "--help"],
  ["plugin", "list", "--help"],
]
const preflight = [["--version"], ...helpProbes]
const preflightLines = preflight.map((args) => ["codex", ...args].join(" "))
const helpOutput: Readonly<Record<string, string>> = {
  "codex plugin marketplace add --help":
    "Usage: codex plugin marketplace add [OPTIONS] <SOURCE>\n\nOptions:\n      --json  Print machine-readable output\n",
  "codex plugin add --help":
    "Usage: codex plugin add [OPTIONS] <PLUGIN>\n\nOptions:\n      --json  Print machine-readable output\n",
  "codex plugin list --help":
    "Usage: codex plugin list [OPTIONS]\n\nOptions:\n      --marketplace <NAME>  Marketplace name\n      --json  Print machine-readable output\n",
}
const sourceFrom = (config: string) => {
  const value = Bun.TOML.parse(config) as {
    marketplaces?: Record<string, { source?: unknown }>
  }
  const source = value.marketplaces?.[CODEX_MARKETPLACE]?.source
  if (typeof source !== "string") throw new Error("Expected the native marketplace source")
  return source
}

const profile = async (
  root: string,
  name: string,
  options: {
    readonly onNativeVersion?: () => void
    readonly failedInstall?: () => void
    readonly version?: string
    readonly missingCodex?: boolean
    readonly overrides?: Readonly<Record<string, Partial<ShellResult>>>
    readonly onProgress?: (update: SetupProgressUpdate) => void
  } = {},
) => {
  const home = join(root, name)
  const market = marketAt(home)
  const config = configAt(home)
  const onProgress = options.onProgress
  const assets = await Effect.runPromise(codexStartupFiles(home))
  const shell = fakeShell({
    commands: options.missingCodex === true ? [] : ["codex"],
    respond: (line) => {
      const override = options.overrides?.[line]
      if (override !== undefined) return override
      if (line === "codex --version") {
        options.onNativeVersion?.()
        return { stdout: "codex-cli " + (options.version ?? "0.172.0") + "\n" }
      }
      const help = helpOutput[line]
      if (help !== undefined) return { stdout: help }
      const append = (text: string) =>
        writeFileSync(config, readFileSync(config, "utf8") + "\n" + text)
      if (line === "codex plugin marketplace add " + market + " --json") {
        append(marketSection(market))
        return { stdout: JSON.stringify({ marketplaceName: CODEX_MARKETPLACE }) }
      }
      if (line === "codex plugin add " + CODEX_PLUGIN + " --json") {
        expect(sourceFrom(readFileSync(config, "utf8"))).toBe(market)
        if (options.failedInstall !== undefined) {
          options.failedInstall()
          return { exitCode: 1, stderr: "Fixture refused plugin install" }
        }
        for (const { path, content } of assets) {
          if (!path.startsWith(sourceTree + "/") && !path.startsWith(sourceTree + "\\")) continue
          const target = join(pluginCache(home), path.slice(sourceTree.length + 1))
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, content)
        }
        append(pluginSection)
        return { stdout: JSON.stringify({ pluginId: CODEX_PLUGIN, version: CODEX_ASSET_VERSION }) }
      }
      if (line === ["codex", ...pluginList].join(" "))
        return {
          stdout: JSON.stringify({
            installed: [{ pluginId: CODEX_PLUGIN, enabled: true, version: CODEX_ASSET_VERSION }],
          }),
        }
      throw new Error("Unexpected native Codex operation: " + line)
    },
  })
  const apply = (options: Partial<Omit<CodexSetupOptions, "home">> = {}) =>
    Effect.runPromise(
      setupCodex({ HOME: root }, { home, dryRun: false, ...options }).pipe(
        Effect.provide(shell.layer),
        Effect.provideService(SetupProgress, onProgress),
      ),
    )
  return { home, market, config, shell, apply }
}

const files = async (directory: string) => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return Object.fromEntries(
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async ({ parentPath, name }) => {
          const path = join(parentPath, name)
          return [path.slice(directory.length + 1), await Bun.file(path).text()] as const
        }),
    ),
  )
}

const settledCalls = [...preflight, pluginList]

test("native Windows literal TOML path aliases resolve to the same local marketplace, not UNC or unrelated paths", () => {
  const normal = "C:\\Fixture User\\Codex Profile\\holyagent\\marketplace"
  const native = "\\\\?\\C:\\Fixture User\\Codex Profile\\holyagent\\marketplace"
  const parsed = sourceFrom(marketSection(native, "local", true))
  expect(parsed).toBe(native)
  expect(sameCodexMarketplacePath(parsed, normal, "win32")).toBe(true)
  expect(
    sameCodexMarketplacePath(parsed, normal.toLowerCase().replaceAll("\\", "/"), "win32"),
  ).toBe(true)
  expect(
    sameCodexMarketplacePath(parsed, normal.replace("Codex Profile", "Another Profile"), "win32"),
  ).toBe(false)
  expect(sameCodexMarketplacePath("\\\\?\\UNC\\server\\share\\marketplace", normal, "win32")).toBe(
    false,
  )
  expect(sameCodexMarketplacePath("C:holyagent\\marketplace", normal, "win32")).toBe(false)
  const parentAlias = native.replace(
    "holyagent\\marketplace",
    "holyagent\\another\\..\\marketplace",
  )
  expect(sameCodexMarketplacePath(parentAlias, normal, "win32")).toBe(false)
  const mixedExtended = native.replace("\\holyagent\\", "/holyagent\\")
  expect(sameCodexMarketplacePath(mixedExtended, normal, "win32")).toBe(false)
  for (const name of ["Codex Profile.", "Codex Profile "]) {
    const ambiguous = normal.replace("Codex Profile", name)
    expect(sameCodexMarketplacePath(ambiguous, ambiguous, "win32")).toBe(false)
  }
})

test.each(["/fixture/./holyagent/marketplace", "/fixture/elsewhere/../holyagent/marketplace"])(
  "POSIX source %s is not accepted as a lexical alias",
  (source) => {
    expect(sameCodexMarketplacePath(source, "/fixture/holyagent/marketplace", "linux")).toBe(false)
  },
)

test("fresh Codex setup previews without mutations, then registers and checks one native plugin", async () => {
  const fixture = await scratch("holyagent-codex-fresh-marketplace-")
  try {
    const root = await realpath(fixture.directory)
    const p = await profile(root, "new profile")
    const { fingerprint } = await p.apply({ dryRun: true })
    expect(p.shell.calls).toEqual([])
    await expect(readdir(p.home)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await p.apply({ expectedPlan: fingerprint })).toMatchObject({ ok: true })
    expect(p.shell.calls.map(({ args }) => args)).toEqual([
      ...preflight,
      ["plugin", "marketplace", "add", p.market, "--json"],
      ["plugin", "add", CODEX_PLUGIN, "--json"],
      pluginList,
    ])
    const probeHomes = p.shell.calls.slice(1, preflight.length).map(({ env }) => env?.CODEX_HOME)
    expect(new Set(probeHomes).size).toBe(1)
    const probeHome = probeHomes[0]
    expect(probeHome).toBeString()
    expect(probeHome).not.toBe(p.home)
    if (probeHome === undefined) throw new Error("Expected an isolated capability-probe profile")
    await expect(readdir(probeHome)).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      p.shell.calls.slice(preflight.length).every(({ env }) => env?.CODEX_HOME === p.home),
    ).toBe(true)
    expect(await Bun.file(receiptAt(p.home)).exists()).toBe(true)
    expect(await Bun.file(manifestAt(p.market)).exists()).toBe(true)
    const first = await files(p.home)
    p.shell.calls.length = 0
    expect(await p.apply()).toMatchObject({ ok: true })
    expect(p.shell.calls.map(({ args }) => args)).toEqual(settledCalls)
    expect(await files(p.home)).toEqual(first)
  } finally {
    await fixture.remove()
  }
})

test.each(["0.180.1", "1.3.0"])(
  "Codex %s can install when all required native commands and flags are available",
  async (version) => {
    const fixture = await scratch("holyagent-codex-compatible-version-")
    try {
      const p = await profile(await realpath(fixture.directory), "fresh profile", { version })
      expect(await p.apply()).toMatchObject({ ok: true })
      expect(p.shell.calls.map(({ args }) => args)).toEqual([
        ...preflight,
        ["plugin", "marketplace", "add", p.market, "--json"],
        ["plugin", "add", CODEX_PLUGIN, "--json"],
        pluginList,
      ])
    } finally {
      await fixture.remove()
    }
  },
)

const capabilityFailures = [
  ["an invalid CLI version banner", { "codex --version": { stdout: "codex-cli 0.180\n" } }],
  [
    "an unknown marketplace command",
    { "codex plugin marketplace add --help": { exitCode: 2, stderr: "unrecognized subcommand" } },
  ],
  [
    "generic fallback help for a missing command",
    { "codex plugin marketplace add --help": { stdout: "Usage: codex [OPTIONS]\n      --json\n" } },
  ],
  [
    "missing JSON support on plugin add",
    { "codex plugin add --help": { stdout: "Usage: codex plugin add [OPTIONS] <PLUGIN>\n" } },
  ],
  [
    "missing marketplace selection on plugin list",
    {
      "codex plugin list --help": { stdout: "Usage: codex plugin list [OPTIONS]\n      --json\n" },
    },
  ],
] as const

test.each(capabilityFailures)(
  "%s stops setup before files, without attempting a CLI upgrade",
  async (_scenario, overrides) => {
    const fixture = await scratch("holyagent-codex-missing-capability-")
    try {
      const p = await profile(await realpath(fixture.directory), "existing profile", {
        version: "1.3.0",
        overrides,
      })
      const saved = codexStartupConfig() + "\n" + extraSettings
      await Bun.write(p.config, saved)
      const { fingerprint } = await p.apply({ dryRun: true })
      expect(p.shell.calls).toEqual([])
      const error = await p.apply({ expectedPlan: fingerprint }).then(
        () => {
          throw new Error("Expected the incompatible Codex CLI to be refused")
        },
        (failure: unknown) => failure,
      )
      if (!(error instanceof StartupStageError))
        throw new Error("Expected a Codex setup diagnostic")
      expect(error.detail).toContain(
        "npm view @openai/codex@latest version --registry=https://registry.npmjs.org/",
      )
      expect(error.detail).toContain(
        "Update through your existing installation channel only if the release is stable and newer",
      )
      expect(error.detail).not.toContain("npm install -g")
      if (_scenario !== "an invalid CLI version banner")
        expect(error.detail).toContain("Detected Codex 1.3.0.")
      expect(p.shell.calls.length).toBeGreaterThan(0)
      for (const call of p.shell.calls) expect(preflightLines).toContain(call.line)
      for (const call of p.shell.calls.filter(({ args }) => args.includes("--help"))) {
        const probeHome = call.env?.CODEX_HOME
        expect(probeHome).not.toBe(p.home)
        if (probeHome === undefined)
          throw new Error("Expected an isolated capability-probe profile")
        await expect(readdir(probeHome)).rejects.toMatchObject({ code: "ENOENT" })
      }
      expect(await files(p.home)).toEqual({ "config.toml": saved })
    } finally {
      await fixture.remove()
    }
  },
)

test("missing Codex suggests a manual install, and preview still works", async () => {
  const fixture = await scratch("holyagent-codex-missing-cli-")
  try {
    const p = await profile(await realpath(fixture.directory), "not created", {
      missingCodex: true,
    })
    expect(await p.apply({ dryRun: true })).toMatchObject({ ok: true })
    await expect(p.apply()).rejects.toMatchObject({
      detail: expect.stringContaining("npm install -g @openai/codex@latest"),
    })
    expect(p.shell.calls).toEqual([])
    await expect(readdir(p.home)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await fixture.remove()
  }
})

test("a filesystem alias of the same marketplace is kept without registration", async () => {
  const fixture = await scratch("holyagent-codex-market-alias-")
  try {
    const root = await realpath(fixture.directory)
    const p = await profile(root, "profile")
    await p.apply()
    const alias = join(root, "same marketplace by alias")
    await symlink(p.market, alias, process.platform === "win32" ? "junction" : "dir")
    expect(await realpath(alias)).toBe(await realpath(p.market))
    const before = (await Bun.file(p.config).text()).replace(
      marketSection(p.market),
      marketSection(alias),
    )
    await Bun.write(p.config, before)
    p.shell.calls.length = 0
    const { fingerprint } = await p.apply({ dryRun: true })
    expect(await p.apply({ expectedPlan: fingerprint })).toMatchObject({ ok: true })
    expect(await Bun.file(p.config).text()).toBe(before)
    expect(p.shell.calls.map(({ args }) => args)).toEqual(settledCalls)
  } finally {
    await fixture.remove()
  }
})

test.skipIf(process.platform !== "win32")(
  "native Windows registration with case, separators and a literal extended local path stays unchanged",
  async () => {
    const fixture = await scratch("holyagent-codex-win-market-alias-")
    try {
      const root = await realpath(fixture.directory)
      const p = await profile(root, "Mixed Case Profile")
      await p.apply()
      const original = await Bun.file(p.config).text()
      for (const alternate of [
        p.market.toUpperCase(),
        p.market.replaceAll("\\", "/"),
        "\\\\?\\" + p.market.toLowerCase(),
      ]) {
        const before = original.replace(
          marketSection(p.market),
          marketSection(alternate, "local", true),
        )
        expect(before).not.toBe(original)
        await Bun.write(p.config, before)
        p.shell.calls.length = 0
        const { fingerprint } = await p.apply({ dryRun: true })
        expect(await p.apply({ expectedPlan: fingerprint })).toMatchObject({ ok: true })
        expect(await Bun.file(p.config).text()).toBe(before)
        expect(p.shell.calls.map(({ args }) => args)).toEqual(settledCalls)
      }
    } finally {
      await fixture.remove()
    }
  },
)

test("a verified prior HolyAgent marketplace is relinked without changing its profile or unrelated settings", async () => {
  const fixture = await scratch("holyagent-codex-move-marketplace-")
  try {
    const root = await realpath(fixture.directory)
    const old = await profile(root, "previous profile")
    await old.apply()
    await Bun.write(join(old.home, "kept.txt"), "previous profile only\n")
    const prior = await files(old.home)
    const p = await profile(root, "current profile")
    const oldLink = marketSection(old.market).replace(
      "\nsource_type",
      " # preserve source-line comment\nsource_type",
    )
    const before = codexStartupConfig() + "\n" + extraSettings + "\n" + oldLink
    await Bun.write(p.config, before)
    const { fingerprint, lines } = await p.apply({ dryRun: true })
    expect(lines.some((line) => line.includes("relink the verified HolyAgent marketplace"))).toBe(
      true,
    )
    expect(await Bun.file(p.config).text()).toBe(before)
    expect(await Bun.file(receiptAt(p.home)).exists()).toBe(false)
    expect(p.shell.calls).toEqual([])
    expect(await p.apply({ expectedPlan: fingerprint })).toMatchObject({ ok: true })
    const after = await Bun.file(p.config).text()
    expect(after).toBe(
      before.replace(JSON.stringify(old.market), JSON.stringify(p.market)) + "\n" + pluginSection,
    )
    expect(await files(old.home)).toEqual(prior)
    expect(await Bun.file(manifestAt(p.market)).exists()).toBe(true)
    expect(p.shell.calls.map(({ args }) => args)).toEqual([
      ...preflight,
      ["plugin", "add", CODEX_PLUGIN, "--json"],
      pluginList,
    ])
    const settled = await files(p.home)
    p.shell.calls.length = 0
    expect(await p.apply()).toMatchObject({ ok: true })
    expect(p.shell.calls.map(({ args }) => args)).toEqual(settledCalls)
    expect(await files(p.home)).toEqual(settled)
  } finally {
    await fixture.remove()
  }
})

test.each(["local", "git"])(
  "a third-party %s same-name marketplace stays unchanged, with actionable guidance",
  async (kind) => {
    const fixture = await scratch("holyagent-codex-conflicting-market-")
    try {
      const root = await realpath(fixture.directory)
      const p = await profile(root, "profile")
      const external = join(root, "a local marketplace")
      const manifest = JSON.stringify({ name: CODEX_MARKETPLACE, plugins: [] })
      await Bun.write(manifestAt(external), manifest)
      const source = kind === "local" ? external : "https://example.invalid/another-marketplace"
      await Bun.write(
        p.config,
        codexStartupConfig() + "\n" + extraSettings + "\n" + marketSection(source, kind),
      )
      const original = await files(p.home)
      for (const dryRun of [true, false]) {
        await expect(p.apply({ dryRun })).rejects.toMatchObject({
          detail: expect.stringMatching(/kept it unchanged.*--codex-home/is),
        })
        expect(await files(p.home)).toEqual(original)
        expect(await Bun.file(manifestAt(external)).text()).toBe(manifest)
      }
      expect(p.shell.calls).toEqual([])
      expect(await Bun.file(receiptAt(p.home)).exists()).toBe(false)
    } finally {
      await fixture.remove()
    }
  },
)

test("an edit between marketplace review and Apply stops before native setup or file writes", async () => {
  const fixture = await scratch("holyagent-codex-market-review-stale-")
  try {
    const root = await realpath(fixture.directory)
    const p = await profile(root, "profile")
    await Bun.write(p.config, codexStartupConfig())
    const { fingerprint } = await p.apply({ dryRun: true })
    await Bun.write(p.config, codexStartupConfig() + "\n" + extraSettings)
    const before = await files(p.home)
    await expect(p.apply({ expectedPlan: fingerprint })).rejects.toMatchObject({
      detail: expect.stringContaining("changed after review"),
    })
    expect(p.shell.calls).toEqual([])
    expect(await files(p.home)).toEqual(before)
  } finally {
    await fixture.remove()
  }
})

test("a change during the native version probe stops before profile files or marketplace registration are written", async () => {
  const fixture = await scratch("holyagent-codex-market-apply-race-")
  try {
    const root = await realpath(fixture.directory)
    const home = join(root, "profile")
    const edited = codexStartupConfig() + "\n" + extraSettings
    const p = await profile(root, "profile", {
      onNativeVersion: () => writeFileSync(configAt(home), edited),
    })
    await Bun.write(p.config, codexStartupConfig())
    const { fingerprint } = await p.apply({ dryRun: true })
    await expect(p.apply({ expectedPlan: fingerprint })).rejects.toMatchObject({
      detail: expect.stringContaining("Profile changed during setup"),
    })
    expect(await files(p.home)).toEqual({ "config.toml": edited })
    expect(p.shell.lines()).toEqual(preflightLines)
  } finally {
    await fixture.remove()
  }
})

test.each(["missing receipt", "modified asset", "changed during apply"])(
  "a previous marketplace with %s cannot transfer ownership",
  async (condition) => {
    const fixture = await scratch("holyagent-codex-market-invalid-proof-")
    try {
      const root = await realpath(fixture.directory)
      const old = await profile(root, "previous profile")
      await old.apply()
      const oldAsset = join(old.market, "plugins", "holyagent", ".codex-plugin", "plugin.json")
      const p = await profile(root, "current profile", {
        onNativeVersion: () => {
          if (condition === "changed during apply") writeFileSync(oldAsset, "newer prior edit\n")
        },
      })
      await Bun.write(p.config, codexStartupConfig() + "\n" + marketSection(old.market))
      if (condition === "missing receipt") await rm(receiptAt(old.home))
      if (condition === "modified asset") await Bun.write(oldAsset, "prior edit\n")
      const before = await files(p.home)
      if (condition === "changed during apply") {
        const { fingerprint } = await p.apply({ dryRun: true })
        await expect(p.apply({ expectedPlan: fingerprint })).rejects.toMatchObject({
          detail: expect.stringContaining("kept it unchanged"),
        })
        expect(p.shell.lines()).toEqual(preflightLines)
        expect(await Bun.file(oldAsset).text()).toBe("newer prior edit\n")
      } else {
        await expect(p.apply({ dryRun: false })).rejects.toMatchObject({
          detail: expect.stringContaining("kept it unchanged"),
        })
        expect(p.shell.calls).toEqual([])
      }
      expect(await files(p.home)).toEqual(before)
    } finally {
      await fixture.remove()
    }
  },
)

test.each([false, true])(
  "a failed plugin install preserves prior source or defers to a concurrent config edit (edit: %j)",
  async (externalEdit) => {
    const fixture = await scratch("holyagent-codex-market-rollback-")
    try {
      const root = await realpath(fixture.directory)
      const old = await profile(root, "previous profile")
      await old.apply()
      const prior = await files(old.home)
      const config = configAt(join(root, "current profile"))
      const edit = "# independently updated while Codex was running\n"
      const p = await profile(root, "current profile", {
        failedInstall: () => {
          if (externalEdit) writeFileSync(config, readFileSync(config, "utf8") + edit)
        },
      })
      const before = codexStartupConfig() + "\n" + extraSettings + "\n" + marketSection(old.market)
      await Bun.write(p.config, before)
      const { fingerprint } = await p.apply({ dryRun: true })
      await expect(p.apply({ expectedPlan: fingerprint })).rejects.toMatchObject({
        detail: expect.stringContaining(
          externalEdit ? "Kept those changes" : "Restored the previous marketplace source",
        ),
      })
      const expected = externalEdit
        ? before.replace(JSON.stringify(old.market), JSON.stringify(p.market)) + edit
        : before
      expect(await Bun.file(p.config).text()).toBe(expected)
      expect(await files(old.home)).toEqual(prior)
    } finally {
      await fixture.remove()
    }
  },
)

const native = Bun.env.HOLYAGENT_TEST_CODEX

test.skipIf(native === undefined)(
  "native Codex registers, reopens and relinks an isolated local marketplace without network or login",
  async () => {
    if (native === undefined) throw new Error("Set HOLYAGENT_TEST_CODEX to the native Codex binary")
    const fixture = await scratch("holyagent-codex-market-native-")
    try {
      const directory = await realpath(fixture.directory)
      const env = {
        HOME: directory,
        USERPROFILE: directory,
        PATH: dirname(native),
        TERM: "dumb",
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
      }
      const setup = (home: string, dryRun = false) =>
        Effect.runPromise(setupCodex(env, { home, dryRun }).pipe(Effect.provide(Shell.live(env))))
      const oldHome = join(directory, "previous profile")
      expect(await setup(oldHome)).toMatchObject({ ok: true })
      const created = await Bun.file(configAt(oldHome)).text()
      const registered = sourceFrom(created)
      expect(sameCodexMarketplacePath(registered, marketAt(oldHome))).toBe(true)
      if (process.platform === "win32") {
        const local = registered.replace(/^\\\\\?\\(?=[a-z]:\\)/i, "")
        expect(await realpath(local)).toBe(await realpath(marketAt(oldHome)))
      }
      expect(await setup(oldHome)).toMatchObject({ ok: true })
      expect(await Bun.file(configAt(oldHome)).text()).toBe(created)

      const nextHome = join(directory, "current profile")
      const before = codexStartupConfig() + "\n" + marketSection(registered, "local", true)
      await Bun.write(configAt(nextHome), before)
      expect((await setup(nextHome, true)).lines.join("\n")).toContain("relink the verified")
      expect(await Bun.file(configAt(nextHome)).text()).toBe(before)
      expect(await setup(nextHome)).toMatchObject({ ok: true })
      const migrated = await Bun.file(configAt(nextHome)).text()
      expect(sameCodexMarketplacePath(sourceFrom(migrated), marketAt(nextHome))).toBe(true)
      expect(await Bun.file(configAt(oldHome)).text()).toBe(created)
      expect(await setup(nextHome)).toMatchObject({ ok: true })
      expect(await Bun.file(configAt(nextHome)).text()).toBe(migrated)
    } finally {
      await fixture.remove()
    }
  },
  30_000,
)

test.each([
  "source before install",
  "managed tree before install",
  "source before list",
  "managed tree before list",
])(
  "live marketplace recheck rejects a change to the %s without a native plugin call",
  async (change) => {
    const fixture = await scratch("holyagent-codex-market-late-change-")
    try {
      const root = await realpath(fixture.directory)
      const home = join(root, "profile")
      const market = marketAt(home)
      const source = join(root, "different marketplace")
      const descriptor = join(market, "plugins", "holyagent", ".codex-plugin", "plugin.json")
      const fresh = change.endsWith("install")
      const changesTree = change.startsWith("managed tree")
      const activityPrefix = fresh ? "Installing " : "Checking enabled version "
      const alteredAsset = "an external edit to the managed plugin\n"
      let armed = fresh
      let changed = false
      const p = await profile(root, "profile", {
        onProgress: ({ label, activity }) => {
          if (!armed || label !== "Codex plugin" || activity?.startsWith(activityPrefix) !== true)
            return
          armed = false
          changed = true
          if (changesTree) {
            writeFileSync(descriptor, alteredAsset)
          } else {
            const config = readFileSync(configAt(home), "utf8")
            writeFileSync(
              configAt(home),
              config.replace(marketSection(market), marketSection(source)),
            )
          }
        },
      })
      let snapshot: Awaited<ReturnType<typeof files>> | undefined
      if (!fresh) {
        await p.apply()
        p.shell.calls.length = 0
        armed = true
        snapshot = await files(pluginCache(home))
      }
      await expect(p.apply()).rejects.toMatchObject({
        detail: expect.stringMatching(/changed|modified|marketplace/i),
      })
      expect(changed).toBe(true)
      expect(p.shell.calls.map(({ args }) => args)).toEqual(
        fresh ? [...preflight, ["plugin", "marketplace", "add", market, "--json"]] : preflight,
      )
      if (snapshot === undefined)
        await expect(readdir(pluginCache(home))).rejects.toMatchObject({ code: "ENOENT" })
      else expect(await files(pluginCache(home))).toEqual(snapshot)
      if (changesTree) expect(await Bun.file(descriptor).text()).toBe(alteredAsset)
      else expect(sourceFrom(await Bun.file(configAt(home)).text())).toBe(source)
    } finally {
      await fixture.remove()
    }
  },
)

const rootOnlyCatalog = Bun.env.HOLYAGENT_TEST_CODEX_ROOT_ONLY_CATALOG

test.skipIf(rootOnlyCatalog === undefined)(
  "explicit root-only mode accepts the reviewed runtime, but rejects a merely capability-compatible version",
  async () => {
    if (rootOnlyCatalog === undefined) throw new Error("Expected the Codex 0.172.0 catalog fixture")
    const fixture = await scratch("holyagent-codex-root-only-capability-")
    try {
      const root = await realpath(fixture.directory)
      const approved = await profile(root, "verified runtime", { version: "0.172.0" })
      expect(await approved.apply({ catalog: rootOnlyCatalog })).toMatchObject({ ok: true })
      expect(Bun.TOML.parse(await Bun.file(approved.config).text())).toMatchObject({
        agents: { enabled: true, max_depth: 1 },
      })
      const later = await profile(root, "unverified runtime", { version: "0.180.1" })
      const { fingerprint } = await later.apply({ catalog: rootOnlyCatalog, dryRun: true })
      expect(later.shell.calls).toEqual([])
      await expect(
        later.apply({ catalog: rootOnlyCatalog, expectedPlan: fingerprint }),
      ).rejects.toMatchObject({
        detail: expect.stringMatching(/root.only|verified runtime/i),
      })
      await expect(readdir(later.home)).rejects.toMatchObject({ code: "ENOENT" })
      for (const call of later.shell.calls) expect(preflightLines).toContain(call.line)
    } finally {
      await fixture.remove()
    }
  },
)
