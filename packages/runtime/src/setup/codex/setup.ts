import { randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path"

import { Effect, Option, Schema } from "effect"

import { type Env, homeDirectory } from "../../../../core/src/setup/environment.ts"
import { reportSetupActivity, withSetupPhase } from "../../../../core/src/setup/progress.ts"
import type { ManagedSetupConflict } from "../../../../core/src/setup/report.ts"
import { Shell } from "../../../../core/src/setup/shell.ts"
import {
  type CodexAsset,
  CODEX_ASSET_VERSION,
  CODEX_MARKETPLACE,
  CODEX_PLUGIN,
  codexMarketplaceFiles,
} from "./assets.ts"
import { CODEX_STARTUP_MARKETPLACE, codexStartupFiles, StartupStageError } from "./startup.ts"

const Receipt = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    files: Schema.Record(Schema.String, Schema.String),
  }),
)
const MarketplaceResult = Schema.Struct({ marketplaceName: Schema.Literal(CODEX_MARKETPLACE) })
const PluginResult = Schema.Struct({
  pluginId: Schema.Literal(CODEX_PLUGIN),
  version: Schema.String,
})
const PluginList = Schema.Struct({
  installed: Schema.Array(
    Schema.Struct({
      pluginId: Schema.String,
      version: Schema.String,
      enabled: Schema.Boolean,
    }),
  ),
})
const receiptFile = join("holyagent", "setup-v1.json")
const digest = (content: string) => Bun.CryptoHasher.hash("sha256", content, "hex")
const fail = (detail: string) => new StartupStageError({ detail })
const installCodex =
  "If you want to install or update Codex, run `npm install -g @openai/codex@latest`, then rerun setup."
const codexVersion = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/m
// An audited behavioral result for the experimental native delegation mode, not an installation
// requirement. Plugin API capability alone cannot establish enforcement of the native depth limit.
const verifiedRootOnlyRelease = "0.172.0"
const nativeQueries = [
  { path: ["plugin", "marketplace", "add"], flags: ["json"] },
  { path: ["plugin", "add"], flags: ["json"] },
  { path: ["plugin", "list"], flags: ["json", "marketplace"] },
] as const

/** The dedicated Codex home used when setup is not given an explicit profile. */
export const defaultCodexHome = (env: Env): string =>
  resolve(env["HOLYAGENT_HOME"] || join(homeDirectory(env), ".holyagent"), "codex")

/** Inputs for explicit or reviewed public Codex setup. */
export interface CodexSetupOptions {
  readonly home: string
  readonly dryRun: boolean
  readonly catalog?: string
  readonly version?: string
  readonly expectedPlan?: string
  /** Internal TUI resolution for receipt-backed instruction edits. */
  readonly managedInstructions?: "review" | "replace"
}

const io = <A>(path: string, perform: () => Promise<A>) =>
  Effect.tryPromise({ try: perform, catch: (cause) => fail(`${path}: ${String(cause)}`) })

const statOptional = (path: string) =>
  Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(fail(`${path}: ${String(cause)}`)),
    ),
  )

const canonicalProfile = Effect.fn("canonicalCodexSetupProfile")(function* (candidate: string) {
  const target = resolve(candidate)
  const root = yield* statOptional(target)
  if (root !== undefined && !root.isDirectory())
    return yield* fail(`Not a real profile directory: ${target}`)
  let ancestor = target
  const suffix: string[] = []
  while ((yield* statOptional(ancestor)) === undefined) {
    suffix.unshift(basename(ancestor))
    ancestor = dirname(ancestor)
  }
  return join(yield* io(ancestor, () => realpath(ancestor)), ...suffix)
})

const inside = Effect.fn("codexSetupPath")(function* (home: string, relativePath: string) {
  let path = home
  const root = yield* statOptional(home)
  if (root !== undefined && !root.isDirectory())
    return yield* fail(`Not a real profile directory: ${home}`)
  const pieces = relativePath.split(/[\\/]/)
  if (pieces.some((piece) => piece === "" || piece === "." || piece === ".."))
    return yield* fail(`Invalid relative profile path: ${relativePath}`)
  for (const [i, piece] of pieces.entries()) {
    path = join(path, piece)
    const entry = yield* statOptional(path)
    if (
      entry !== undefined &&
      (entry.isSymbolicLink() || (i < pieces.length - 1 && !entry.isDirectory()))
    )
      return yield* fail(`Not a real profile path: ${path}`)
  }
  return path
})

const read = Effect.fn("codexSetupRead")(function* (home: string, entry: string) {
  const file = yield* inside(home, entry)
  const stat = yield* statOptional(file)
  if (stat === undefined) return undefined
  if (!stat.isFile()) return yield* fail(`Not a regular profile file: ${file}`)
  return yield* io(file, () => readFile(file, "utf8"))
})

const checkPluginTree = Effect.fn("checkCodexPluginTree")(function* (
  home: string,
  root: string,
  expected: ReadonlyArray<CodexAsset>,
  complete: boolean,
) {
  const allowed = new Set(expected.map(({ path }) => path))
  const directories = new Set([root])
  for (const { path } of expected)
    for (let parent = dirname(path); parent !== root; parent = dirname(parent))
      directories.add(parent)
  for (const directory of directories) {
    const absolute = yield* inside(home, directory)
    const stat = yield* statOptional(absolute)
    if (stat === undefined && !complete) continue
    if (stat === undefined || !stat.isDirectory())
      return yield* fail(`Missing or invalid Codex plugin directory: ${absolute}`)
    const names = yield* io(absolute, () => readdir(absolute))
    for (const name of names) {
      const file = join(directory, name)
      if (!allowed.has(file) && !directories.has(file))
        return yield* fail(`Kept unowned entry in Codex plugin: ${join(home, file)}`)
    }
  }
  if (complete) {
    for (const { path, content } of expected)
      if ((yield* read(home, path)) !== content)
        return yield* fail(`Kept modified Codex plugin cache: ${join(home, path)}`)
  }
})

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}

const parseToml = (content: string) =>
  Effect.try({
    try: () => record(Bun.TOML.parse(content)),
    catch: () => fail("Invalid Codex config.toml; left it unchanged"),
  })

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const localMarketplacePath = (path: string, platform: NodeJS.Platform): string | undefined => {
  if (/[\p{Cc}]/u.test(path)) return undefined
  // Never collapse parent segments before filesystem lookup. A junction or symlink can give
  // those segments different meaning from lexical normalization.
  if (
    path.split(platform === "win32" ? /[\\/]/ : "/").some((part) => part === "." || part === "..")
  )
    return undefined
  if (platform !== "win32") return posix.isAbsolute(path) ? posix.normalize(path) : undefined
  const extended = path.startsWith("\\\\?\\")
  if (extended && (path.includes("/") || path.slice(4).includes("\\\\"))) return undefined
  const drivePath = extended ? path.slice(4) : path.replaceAll("/", "\\")
  if (!/^[a-z]:\\/i.test(drivePath)) return undefined
  if (
    drivePath
      .slice(3)
      .split("\\")
      .some((part) => /[<>:"|?*]|[. ]$/u.test(part))
  )
    return undefined
  return win32.normalize(drivePath)
}

/** Compare local Win32 path spellings, including the extended prefix native Codex writes. */
export const sameCodexMarketplacePath = (
  first: string,
  second: string,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  const a = localMarketplacePath(first, platform)
  const b = localMarketplacePath(second, platform)
  if (a === undefined || b === undefined) return false
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

const resolvedLocalPath = (path: string) =>
  io(path, () => realpath(path)).pipe(
    Effect.map((actual) => localMarketplacePath(actual, process.platform)),
    Effect.orElseSucceed(() => undefined),
  )

const sameResolvedMarketplace = Effect.fn("sameResolvedCodexMarketplace")(function* (
  left: string,
  right: string,
) {
  if (left === right) return true
  if (process.platform !== "win32" || !sameCodexMarketplacePath(left, right)) return false
  const a = yield* statOptional(left)
  const b = yield* statOptional(right)
  // NTFS can have case-sensitive directories. Only accept a casing alias when both spellings
  // resolve to the very same existing directory, not just the same lowercased string.
  return (
    a !== undefined &&
    b !== undefined &&
    a.isDirectory() &&
    b.isDirectory() &&
    a.ino > 0 &&
    a.ino === b.ino &&
    a.dev === b.dev
  )
})

const receiptFor = (content: string) =>
  Schema.decodeUnknownEffect(Receipt, { onExcessProperty: "error" })(content).pipe(
    Effect.mapError(() => fail("Invalid HolyAgent Codex setup receipt; no files changed")),
  )

// Read the actual prior profile, not a similarly named manifest in an arbitrary folder.
const priorMarketplaceProof = Effect.fn("priorCodexMarketplaceProof")(function* (market: string) {
  const oldHome = dirname(dirname(market))
  const expected = join(oldHome, CODEX_STARTUP_MARKETPLACE)
  if (!sameCodexMarketplacePath(expected, market)) return
  const prior = yield* resolvedLocalPath(yield* inside(oldHome, CODEX_STARTUP_MARKETPLACE))
  if (prior === undefined || !(yield* sameResolvedMarketplace(market, prior))) return
  const snapshot = yield* read(oldHome, receiptFile)
  if (snapshot === undefined) return
  const receipt = yield* receiptFor(snapshot)
  const installed = codexMarketplaceFiles().map(({ path, content }) => ({
    path: join(CODEX_STARTUP_MARKETPLACE, path),
    content,
  }))
  const catalog = installed[0]
  if (catalog === undefined || (yield* read(oldHome, catalog.path)) !== catalog.content) return
  const pluginRoot = join(CODEX_STARTUP_MARKETPLACE, "plugins", "holyagent")
  yield* checkPluginTree(oldHome, pluginRoot, installed.slice(1), false)
  for (const { path } of installed) {
    const file = yield* read(oldHome, path)
    if (
      file === undefined ||
      !Object.hasOwn(receipt.files, path) ||
      digest(file) !== receipt.files[path]
    )
      return
  }
  return digest(snapshot)
})

const marketplaceConflict = (source: unknown) => {
  const local =
    typeof source === "string" ? localMarketplacePath(source, process.platform) : undefined
  return fail(
    `Codex already has a different marketplace named ${CODEX_MARKETPLACE}${local === undefined ? "" : ` at ${local}`}; kept it unchanged. Use a separate --codex-home, or restore the original HolyAgent marketplace and review again.`,
  )
}

const marketplaceLink = Effect.fn("planCodexMarketplaceLink")(function* (
  registered: Readonly<Record<string, unknown>>,
  target: string,
) {
  if (Object.keys(registered).length === 0) return { kind: "add" } as const
  const source = registered.source
  if (registered.source_type !== "local" || typeof source !== "string")
    return yield* marketplaceConflict(source)
  const clean = localMarketplacePath(source, process.platform)
  if (clean === undefined) return yield* marketplaceConflict(source)
  if (clean === localMarketplacePath(target, process.platform)) return { kind: "keep" } as const
  const actual = yield* resolvedLocalPath(clean)
  const destination = yield* resolvedLocalPath(target)
  if (
    actual !== undefined &&
    destination !== undefined &&
    (yield* sameResolvedMarketplace(actual, destination))
  )
    return { kind: "keep" } as const
  if (actual === undefined) return yield* marketplaceConflict(source)
  const proof = yield* priorMarketplaceProof(actual).pipe(Effect.orElseSucceed(() => undefined))
  if (proof === undefined) return yield* marketplaceConflict(source)
  return { kind: "relink", source, actual, proof } as const
})

// Codex writes this standalone table. Patch only its source and verify the parsed result before
// writing. Other TOML representations are left untouched instead of being reserialized.
const marketplaceHeader =
  /^[ \t]*\[[ \t]*(?:marketplaces|"marketplaces"|'marketplaces')[ \t]*\.[ \t]*(?:holyagent-local|"holyagent-local"|'holyagent-local')[ \t]*\][ \t]*(?:#[^\r\n]*)?\r?$/gm
const sourceLine =
  /^([ \t]*(?:source|"source"|'source')[ \t]*=[ \t]*)(?:"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')([ \t]*(?:#[^\r\n]*)?\r?)$/gm

const relinkMarketplaceConfig = Effect.fn("relinkCodexMarketplaceConfig")(function* (
  text: string,
  settings: Readonly<Record<string, unknown>>,
  target: string,
) {
  const headers = [...text.matchAll(marketplaceHeader)]
  const header = headers.length === 1 ? headers[0] : undefined
  const unsupported = fail(
    `Kept ${CODEX_MARKETPLACE} unchanged because the registered source cannot be safely updated in this config.toml format. Use a separate --codex-home.`,
  )
  if (header?.index === undefined) return yield* unsupported
  const start = header.index + header[0].length
  const remaining = text.slice(start)
  const nextHeader = remaining.search(/^[ \t]*\[/m)
  const section = nextHeader === -1 ? remaining : remaining.slice(0, nextHeader)
  if ([...section.matchAll(sourceLine)].length !== 1) return yield* unsupported
  const replaced = section.replace(
    sourceLine,
    (_, prefix: string, tail: string) => `${prefix}${JSON.stringify(target)}${tail}`,
  )
  const next = text.slice(0, start) + replaced + remaining.slice(section.length)
  const marketplaces = record(settings.marketplaces)
  const expected = {
    ...settings,
    marketplaces: {
      ...marketplaces,
      [CODEX_MARKETPLACE]: { ...record(marketplaces[CODEX_MARKETPLACE]), source: target },
    },
  }
  if (!same(yield* parseToml(next), expected)) return yield* unsupported
  return next
})

const developerLine = /^developer_instructions = "(?:[^"\\\r\n]|\\.)*"$/m

const ownedInstruction = (asset: CodexAsset, before: string): boolean => {
  if (asset.path === "AGENTS.md") return true
  if (
    asset.path ===
    join(
      CODEX_STARTUP_MARKETPLACE,
      "plugins",
      "holyagent",
      "skills",
      "holyagent-workflow",
      "SKILL.md",
    )
  )
    return true
  const line = asset.content.match(developerLine)?.[0]
  return (
    asset.path.startsWith("agents/holyagent-") &&
    asset.path.endsWith(".toml") &&
    line !== undefined &&
    before.replace(developerLine, () => line) === asset.content
  )
}

const checkPolicy = Effect.fn("checkCodexSetupPolicy")(function* (
  current: Readonly<Record<string, unknown>>,
  wanted: Readonly<Record<string, unknown>>,
) {
  const currentAgents = record(current.agents)
  const wantedAgents = record(wanted.agents)
  const currentFeatures = record(current.features)
  const wantedFeatures = record(wanted.features)
  const foundV2 = record(currentFeatures.multi_agent_v2)
  const wantedV2 = record(wantedFeatures.multi_agent_v2)
  const v2Matches =
    wantedFeatures.multi_agent_v2 === false
      ? currentFeatures.multi_agent_v2 === false
      : foundV2.enabled === wantedV2.enabled &&
        foundV2.disable_native_tools === wantedV2.disable_native_tools
  if (
    currentAgents.enabled !== wantedAgents.enabled ||
    currentAgents.max_depth !== wantedAgents.max_depth ||
    !v2Matches ||
    !same(current.model_catalog_json, wanted.model_catalog_json) ||
    (wantedAgents.enabled === true &&
      !same(
        record(currentFeatures.code_mode).direct_only_tool_namespaces,
        record(wantedFeatures.code_mode).direct_only_tool_namespaces,
      ))
  )
    return yield* fail(
      "Existing Codex delegation settings do not match this mode. Use a separate --codex-home, or keep its original --root-only-catalog. Nothing was written.",
    )
})

const store = Effect.fn("writeOwnedCodexSetupFile")(function* (
  home: string,
  relativePath: string,
  expected: string | undefined,
  content: string,
) {
  if (expected === content) return
  const path = yield* inside(home, relativePath)
  yield* io(path, () => mkdir(dirname(path), { recursive: true }))
  if ((yield* read(home, relativePath)) !== expected)
    return yield* fail(`Profile changed during setup: ${path}`)
  if (expected === undefined) {
    yield* io(path, () => writeFile(path, content, { flag: "wx", mode: 0o600 }))
    return
  }
  const next = `${path}.${randomUUID()}.tmp`
  yield* io(path, () => writeFile(next, content, { flag: "wx", mode: 0o600 }))
  yield* Effect.gen(function* () {
    if ((yield* read(home, relativePath)) !== expected)
      return yield* fail(`Profile changed during setup: ${path}`)
    yield* io(path, () => rename(next, path))
  }).pipe(Effect.ensuring(io(next, () => rm(next, { force: true })).pipe(Effect.ignore)))
})

const checkNativeCodex = Effect.fn("validateNativeCodexCapabilities")(function* (
  run: (args: ReadonlyArray<string>, profile?: string) => Effect.Effect<string, StartupStageError>,
) {
  // Even harmless CLI probes can initialize helper files. Keep probes out of the target profile.
  return yield* Effect.acquireUseRelease(
    io(tmpdir(), () => mkdtemp(join(tmpdir(), "holyagent-codex-probe-"))),
    (probe) =>
      Effect.gen(function* () {
        const release = codexVersion.exec(yield* run(["--version"], probe))?.[1]
        if (release === undefined)
          return yield* fail("`codex --version` did not identify the native CLI.")
        yield* Effect.forEach(nativeQueries, ({ path, flags }) =>
          Effect.gen(function* () {
            const help = yield* run([...path, "--help"], probe)
            const command = `codex ${path.join(" ")}`
            const usage = new RegExp(`^Usage: codex(?:\\.exe)? ${path.join(" ")}(?:\\s|$)`, "m")
            if (!usage.test(help)) return yield* fail(`${command} is not available.`)
            for (const flag of flags)
              if (!new RegExp(`(?:^|[ \\t,])--${flag}(?:[ \\t=,]|$)`, "m").test(help))
                return yield* fail(`${command} does not support --${flag}.`)
          }),
        )
        return release
      }),
    (probe) => io(probe, () => rm(probe, { recursive: true, force: true })).pipe(Effect.ignore),
  ).pipe(
    Effect.mapError((error) =>
      fail(`Incompatible native Codex CLI. ${error.detail} ${installCodex}`),
    ),
  )
})

/** Provision a dedicated Codex home using the native marketplace and plugin commands. */
export const setupCodex = Effect.fn("setupCodex")(function* (env: Env, options: CodexSetupOptions) {
  if (!isAbsolute(options.home)) return yield* fail("--codex-home must be an absolute path")
  const home = yield* canonicalProfile(options.home)
  if (home === dirname(home))
    return yield* fail("Choose a dedicated Codex profile, not a filesystem root")
  const version = options.version ?? CODEX_ASSET_VERSION
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
    return yield* fail("Invalid HolyAgent plugin version")
  const shell = yield* Shell
  const native = yield* shell.which("codex", { includeBunBin: true })
  if (!options.dryRun && Option.isNone(native))
    return yield* fail(`Codex is not on PATH. Preview does not require it. ${installCodex}`)
  const run = (args: ReadonlyArray<string>, profile = home) =>
    shell
      .run("codex", args, {
        cwd: homeDirectory(env),
        env: { CODEX_HOME: profile, NO_COLOR: "1" },
      })
      .pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                fail(
                  `codex ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 600)}`,
                ),
              ),
        ),
      )
  const desired = yield* codexStartupFiles(home, options.catalog, version)
  const legacy = codexMarketplaceFiles().map(({ path, content }) => ({
    path: join(CODEX_STARTUP_MARKETPLACE, path),
    content,
  }))
  const config = desired.find(({ path }) => path === "config.toml")?.content
  if (config === undefined) return yield* fail("Missing bundled Codex startup configuration")
  const beforeConfig = yield* read(home, "config.toml")
  const beforeOverride = yield* read(home, "AGENTS.override.md")
  if (beforeOverride?.trim())
    return yield* fail(
      "This profile has an AGENTS.override.md that would hide HolyAgent startup guidance. Kept it unchanged. Use another --codex-home.",
    )
  const settings = beforeConfig === undefined ? {} : yield* parseToml(beforeConfig)
  if (record(settings.features).plugins === false)
    return yield* fail(
      "This profile disables Codex plugins ([features] plugins = false). No files changed.",
    )
  if (beforeConfig !== undefined) yield* checkPolicy(settings, yield* parseToml(config))
  const market = join(home, CODEX_STARTUP_MARKETPLACE)
  const registration = record(settings.marketplaces)[CODEX_MARKETPLACE]
  const registered = record(registration)
  if (registration !== undefined && Object.keys(registered).length === 0)
    return yield* marketplaceConflict(undefined)
  const link = yield* marketplaceLink(registered, market)
  const relinkedConfig =
    link.kind === "relink" && beforeConfig !== undefined
      ? yield* relinkMarketplaceConfig(beforeConfig, settings, market)
      : undefined
  const plugin = record(record(settings.plugins)[CODEX_PLUGIN])
  if (plugin.enabled === false)
    return yield* fail(
      "The HolyAgent Codex plugin is disabled in this profile; left that choice unchanged",
    )
  const beforeReceipt = yield* read(home, receiptFile)
  const receipt =
    beforeReceipt === undefined
      ? { files: {} as Readonly<Record<string, string>> }
      : yield* receiptFor(beforeReceipt)
  const assets = yield* Effect.forEach(
    desired.filter(({ path }) => path !== "config.toml"),
    (asset) =>
      Effect.gen(function* () {
        const before = yield* read(home, asset.path)
        const previousDigest = receipt.files[asset.path]
        const edited =
          before !== undefined &&
          before !== asset.content &&
          digest(before) !== previousDigest &&
          before !== legacy.find(({ path }) => path === asset.path)?.content
        const conflict =
          edited &&
          previousDigest !== undefined &&
          /^[a-f0-9]{64}$/.test(previousDigest) &&
          ownedInstruction(asset, before)
        if (
          edited &&
          !(
            conflict &&
            (options.dryRun
              ? options.managedInstructions === "review"
              : options.managedInstructions === "replace" && options.expectedPlan !== undefined)
          )
        )
          return yield* fail(`Kept modified or unowned Codex setup file: ${join(home, asset.path)}`)
        return { ...asset, before, conflict }
      }),
  )
  const sourceRoot = join(CODEX_STARTUP_MARKETPLACE, "plugins", "holyagent")
  const pluginAssets = assets.filter(({ path }) => path.startsWith(sourceRoot))
  yield* checkPluginTree(home, sourceRoot, pluginAssets, false)
  const nextReceipt = `${JSON.stringify(
    {
      version: 1,
      files: Object.fromEntries(assets.map(({ path, content }) => [path, digest(content)])),
    },
    null,
    2,
  )}\n`
  const cache = join("plugins", "cache", CODEX_MARKETPLACE, "holyagent", version)
  const expectedCache = pluginAssets.map(({ path, content }) => ({
    path: join(cache, path.slice(sourceRoot.length + 1)),
    content,
  }))
  const cached = yield* statOptional(yield* inside(home, cache))
  if (cached !== undefined) yield* checkPluginTree(home, cache, expectedCache, true)
  const install = plugin.enabled !== true || cached === undefined
  const fingerprint = digest(
    JSON.stringify([
      home,
      version,
      beforeConfig,
      beforeOverride,
      beforeReceipt,
      link,
      install,
      assets.map(({ path, before, content }) => [path, before, content]),
    ]),
  )
  if (options.expectedPlan !== undefined && options.expectedPlan !== fingerprint)
    return yield* fail("The Codex profile changed after review. Open setup and review it again.")
  const lines = [
    `~ Codex home: ${home}`,
    `~ Startup: ${options.catalog === undefined ? "direct-only" : "adaptive, native V1 root-only (depth one)"}`,
    ...(options.dryRun && Option.isNone(native)
      ? [`~ Codex CLI: not on PATH. ${installCodex}`]
      : []),
    ...(beforeConfig === undefined
      ? ["+ Codex config: create a dedicated startup profile"]
      : ["= Codex config: keeping existing settings"]),
    ...assets
      .filter(({ before, content }) => before !== content)
      .map(({ path }) => `+ Codex asset: ${path}`),
    ...(link.kind === "add" ? ["+ Codex plugin: register the local marketplace"] : []),
    ...(link.kind === "relink"
      ? ["+ Codex plugin: relink the verified HolyAgent marketplace"]
      : []),
    ...(install
      ? [`+ Codex plugin: install ${CODEX_PLUGIN} ${version}`]
      : [`= Codex plugin: ${version} already present in the local cache`]),
    ...(record(settings.skills).include_instructions === false
      ? [
          "~ Codex skills: this profile disables automatic skill listings. HolyAgent workflow will not be listed in the prompt under this setting.",
        ]
      : []),
    "~ Start Codex with this CODEX_HOME set before launch; setup does not change a running session.",
  ]
  const managedConflicts: ReadonlyArray<ManagedSetupConflict> = assets
    .filter(({ conflict }) => conflict)
    .map(({ path }) => ({
      file: join(home, path),
      detail:
        "Edited since setup. Replace with the bundled instructions and save a copy of the current file.",
    }))
  if (options.dryRun)
    return {
      ok: true,
      lines,
      fingerprint,
      ...(managedConflicts.length > 0 ? { managedConflicts } : {}),
    }
  const backups: string[] = []
  let relinked = false
  const backupRoot = join("holyagent", "setup-backups", randomUUID())
  const verifyActiveMarketplace = Effect.fn("verifyActiveCodexMarketplace")(function* () {
    const liveConfig = yield* read(home, "config.toml")
    if (liveConfig === undefined) return yield* fail("Codex config.toml disappeared during setup.")
    const liveSettings = yield* parseToml(liveConfig)
    const active = record(record(liveSettings.marketplaces)[CODEX_MARKETPLACE])
    if ((yield* marketplaceLink(active, market)).kind !== "keep")
      return yield* fail(
        "The active Codex marketplace source changed during setup. Review it again.",
      )
    if (
      record(liveSettings.features).plugins === false ||
      record(record(liveSettings.plugins)[CODEX_PLUGIN]).enabled === false
    )
      return yield* fail("The HolyAgent plugin is now disabled. Setup kept that choice unchanged.")
    yield* checkPolicy(liveSettings, yield* parseToml(config))
    yield* checkPluginTree(home, sourceRoot, pluginAssets, true)
  })
  const steps = [
    {
      label: "Codex runtime",
      run: Effect.gen(function* () {
        const version = yield* checkNativeCodex(run)
        if (options.catalog !== undefined && version !== verifiedRootOnlyRelease)
          return yield* fail(
            `Codex ${version} supports plugin setup, but native root-only delegation has not been verified on this build. Remove --root-only-catalog and use a separate direct-only profile. No profile files were changed.`,
          )
        lines.push(`= Codex CLI ${version}: marketplace and plugin commands verified`)
      }),
    },
    {
      label: "Codex profile files",
      run: Effect.gen(function* () {
        if (
          (yield* canonicalProfile(options.home)) !== home ||
          (yield* read(home, "config.toml")) !== beforeConfig ||
          (yield* read(home, "AGENTS.override.md")) !== beforeOverride ||
          (yield* read(home, receiptFile)) !== beforeReceipt ||
          !same(yield* marketplaceLink(registered, market), link)
        )
          return yield* fail(`Profile changed during setup: ${join(home, "config.toml")}`)
        if (options.expectedPlan !== undefined)
          for (const asset of assets)
            if ((yield* read(home, asset.path)) !== asset.before)
              return yield* fail(
                `Profile changed during setup: ${join(home, asset.path)}. Review it again.`,
              )
        yield* io(home, () => mkdir(home, { recursive: true, mode: 0o700 }))
        if (beforeConfig === undefined) yield* store(home, "config.toml", undefined, config)
        for (const asset of assets) {
          const replace = store(home, asset.path, asset.before, asset.content)
          if (!asset.conflict || asset.before === undefined) {
            yield* replace
            continue
          }
          const backup = join(backupRoot, asset.path)
          yield* store(home, backup, undefined, asset.before)
          const backupFile = join(home, backup)
          backups.push(backupFile)
          yield* replace.pipe(
            Effect.uninterruptible,
            Effect.onError(() =>
              Effect.gen(function* () {
                if ((yield* read(home, asset.path)) !== asset.before) return
                yield* io(backupFile, () => rm(backupFile, { force: true }))
                backups.pop()
              }).pipe(Effect.ignore),
            ),
          )
          lines.push(`+ Codex instructions: backup saved in ${backupFile}`)
        }
        yield* checkPluginTree(home, sourceRoot, pluginAssets, true)
        yield* store(home, receiptFile, beforeReceipt, nextReceipt)
      }),
    },
    ...(link.kind === "add" || relinkedConfig !== undefined
      ? [
          {
            label: "Codex marketplace",
            run: Effect.gen(function* () {
              if (relinkedConfig !== undefined) {
                if (!same(yield* marketplaceLink(registered, market), link))
                  return yield* fail(
                    "The previous HolyAgent marketplace changed. Review setup again.",
                  )
                yield* Effect.gen(function* () {
                  yield* store(home, "config.toml", beforeConfig, relinkedConfig)
                  relinked = true
                }).pipe(Effect.uninterruptible)
                return
              }
              yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MarketplaceResult))(
                yield* run(["plugin", "marketplace", "add", market, "--json"]),
              ).pipe(Effect.mapError(() => fail("Codex did not confirm the expected marketplace")))
            }),
          },
        ]
      : []),
    {
      label: "Codex plugin",
      run: Effect.gen(function* () {
        if (install) {
          yield* reportSetupActivity(`Installing ${CODEX_PLUGIN} ${version}`)
          yield* verifyActiveMarketplace()
          const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PluginResult))(
            yield* run(["plugin", "add", CODEX_PLUGIN, "--json"]),
          ).pipe(Effect.mapError(() => fail("Codex did not confirm the expected plugin")))
          if (result.version !== version)
            return yield* fail(`Codex installed version ${result.version}, expected ${version}`)
          yield* checkPluginTree(home, cache, expectedCache, true)
        }
        yield* reportSetupActivity(`Checking enabled version ${version}`)
        yield* verifyActiveMarketplace()
        const list = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PluginList))(
          yield* run(["plugin", "list", "--marketplace", CODEX_MARKETPLACE, "--json"]),
        ).pipe(Effect.mapError(() => fail("Codex did not report enabled plugins for this profile")))
        if (
          !list.installed.some(
            (item) => item.pluginId === CODEX_PLUGIN && item.enabled && item.version === version,
          )
        )
          return yield* fail(`Codex did not report ${CODEX_PLUGIN} enabled at ${version}`)
      }),
    },
  ]
  yield* Effect.forEach(steps, ({ label, run }, index) =>
    withSetupPhase({ index: index + 1, total: steps.length, label }, run),
  ).pipe(
    Effect.catchTag("StartupStageError", (error) =>
      Effect.gen(function* () {
        const detail = [error.detail]
        if (relinked && beforeConfig !== undefined && relinkedConfig !== undefined) {
          const rollback = yield* Effect.result(
            store(home, "config.toml", relinkedConfig, beforeConfig),
          )
          detail.push(
            rollback._tag === "Success"
              ? "Restored the previous marketplace source."
              : "The profile changed after relinking. Kept those changes and the original marketplace files. Review config.toml before retrying.",
          )
        }
        if (backups.length > 0) detail.push(`Backups: ${backups.join(", ")}`)
        return yield* fail(detail.join("\n"))
      }),
    ),
  )
  return { ok: true, lines, fingerprint }
})
