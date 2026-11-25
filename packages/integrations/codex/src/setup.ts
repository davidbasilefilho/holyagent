import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { Effect, Option, Schema } from "effect"

import { type Env, homeDirectory } from "../../../core/src/setup/environment.ts"
import { Shell } from "../../../core/src/setup/shell.ts"
import { CODEX_ASSET_VERSION, CODEX_MARKETPLACE, CODEX_PLUGIN } from "./assets.ts"
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
const receiptFile = join("holyagent", "setup-v1.json")
const digest = (content: string) => Bun.CryptoHasher.hash("sha256", content, "hex")
const fail = (detail: string) => new StartupStageError({ detail })

/** The dedicated Codex home used when setup is not given an explicit profile. */
export const defaultCodexHome = (env: Env): string =>
  resolve(env["HOLYAGENT_HOME"] || join(homeDirectory(env), ".holyagent"), "codex")

/** Inputs for explicit or reviewed public Codex setup. */
export interface CodexSetupOptions {
  readonly home: string
  readonly dryRun: boolean
  readonly catalog?: string
  readonly version?: string
}

const io = <A>(path: string, perform: () => Promise<A>) =>
  Effect.tryPromise({ try: perform, catch: (cause) => fail(`${path}: ${String(cause)}`) })

const statOptional = (path: string) =>
  io(path, () =>
    lstat(path).then(
      (stat) => stat,
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? undefined : Promise.reject(error),
    ),
  )

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

/** Provision a dedicated Codex home using the native marketplace and plugin commands. */
export const setupCodex = Effect.fn("setupCodex")(function* (env: Env, options: CodexSetupOptions) {
  if (!isAbsolute(options.home)) return yield* fail("--codex-home must be an absolute path")
  const home = resolve(options.home)
  if (home === dirname(home))
    return yield* fail("Choose a dedicated Codex profile, not a filesystem root")
  const version = options.version ?? CODEX_ASSET_VERSION
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
    return yield* fail("Invalid HolyAgent plugin version")
  const shell = yield* Shell
  const codex = yield* shell.which("codex")
  if (Option.isNone(codex))
    return yield* fail("Codex is not on PATH. Install the native Codex CLI first.")
  const run = (args: ReadonlyArray<string>) =>
    shell
      .run("codex", args, {
        cwd: homeDirectory(env),
        env: { CODEX_HOME: home, NO_COLOR: "1" },
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
  const legacy = yield* codexStartupFiles(home, options.catalog)
  const config = desired.find(({ path }) => path === "config.toml")?.content
  if (config === undefined) return yield* fail("Missing bundled Codex startup configuration")
  const beforeConfig = yield* read(home, "config.toml")
  const settings = beforeConfig === undefined ? {} : yield* parseToml(beforeConfig)
  if (beforeConfig !== undefined) yield* checkPolicy(settings, yield* parseToml(config))
  const market = join(home, CODEX_STARTUP_MARKETPLACE)
  const registered = record(record(settings.marketplaces)[CODEX_MARKETPLACE])
  if (
    Object.keys(registered).length > 0 &&
    (registered.source !== market || registered.source_type !== "local")
  )
    return yield* fail(
      `Codex already has a different marketplace named ${CODEX_MARKETPLACE}; kept it unchanged`,
    )
  const plugin = record(record(settings.plugins)[CODEX_PLUGIN])
  if (plugin.enabled === false)
    return yield* fail(
      "The HolyAgent Codex plugin is disabled in this profile; left that choice unchanged",
    )
  const beforeReceipt = yield* read(home, receiptFile)
  const receipt =
    beforeReceipt === undefined
      ? { files: {} as Readonly<Record<string, string>> }
      : yield* Schema.decodeUnknownEffect(Receipt, { onExcessProperty: "error" })(
          beforeReceipt,
        ).pipe(
          Effect.mapError(() => fail("Invalid HolyAgent Codex setup receipt; no files changed")),
        )
  const assets = yield* Effect.forEach(
    desired.filter(({ path }) => path !== "config.toml"),
    (asset) =>
      Effect.gen(function* () {
        const before = yield* read(home, asset.path)
        if (
          before !== undefined &&
          before !== asset.content &&
          digest(before) !== receipt.files[asset.path] &&
          before !== legacy.find(({ path }) => path === asset.path)?.content
        )
          return yield* fail(`Kept modified or unowned Codex setup file: ${join(home, asset.path)}`)
        return { ...asset, before }
      }),
  )
  const nextReceipt = `${JSON.stringify(
    {
      version: 1,
      files: Object.fromEntries(assets.map(({ path, content }) => [path, digest(content)])),
    },
    null,
    2,
  )}\n`
  const cache = join(
    "plugins",
    "cache",
    CODEX_MARKETPLACE,
    "holyagent",
    version,
    ".codex-plugin",
    "plugin.json",
  )
  const installed = yield* read(home, cache)
  const install = plugin.enabled !== true || installed === undefined
  const addMarket = Object.keys(registered).length === 0
  const lines = [
    `~ Codex home: ${home}`,
    `~ Startup: ${options.catalog === undefined ? "direct-only" : "adaptive, native V1 root-only (depth one)"}`,
    ...(beforeConfig === undefined
      ? ["+ Codex config: create a dedicated startup profile"]
      : ["= Codex config: keeping existing settings"]),
    ...assets
      .filter(({ before, content }) => before !== content)
      .map(({ path }) => `+ Codex asset: ${path}`),
    ...(addMarket ? ["+ Codex plugin: register the local marketplace"] : []),
    ...(install
      ? [`+ Codex plugin: install ${CODEX_PLUGIN} ${version}`]
      : [`= Codex plugin: ${version} already present`]),
    "~ Start Codex with this CODEX_HOME set before launch; setup does not change a running session.",
  ]
  if (options.dryRun) return { ok: true, lines }
  // Do not execute a native command from a dry run. Apply checks the runtime before writing assets.
  const binary = yield* run(["--version"])
  if (!/^codex-cli 0\.172\.0(?:-[\w.]+)?$/m.test(binary))
    return yield* fail("This startup profile requires the verified Codex 0.172.0 runtime line")
  if ((yield* read(home, "config.toml")) !== beforeConfig)
    return yield* fail(`Profile changed during setup: ${join(home, "config.toml")}`)
  yield* io(home, () => mkdir(home, { recursive: true, mode: 0o700 }))
  if (beforeConfig === undefined) yield* store(home, "config.toml", undefined, config)
  for (const asset of assets) yield* store(home, asset.path, asset.before, asset.content)
  yield* store(home, receiptFile, beforeReceipt, nextReceipt)
  if (addMarket)
    yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MarketplaceResult))(
      yield* run(["plugin", "marketplace", "add", market, "--json"]),
    ).pipe(Effect.mapError(() => fail("Codex did not confirm the expected marketplace")))
  if (install) {
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PluginResult))(
      yield* run(["plugin", "add", CODEX_PLUGIN, "--json"]),
    ).pipe(Effect.mapError(() => fail("Codex did not confirm the expected plugin")))
    if (result.version !== version)
      return yield* fail(`Codex installed version ${result.version}, expected ${version}`)
  }
  return { ok: true, lines }
})
