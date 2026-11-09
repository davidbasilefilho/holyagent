import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { Data, Effect } from "effect"

import { type Env, firstNonEmpty, homeDirectory } from "../environment.ts"
import { EMPTY_BUNFIG, Shell } from "../shell.ts"
import { TUI_BUNDLE } from "./files.ts"
import { TUI_PACKAGES } from "./packages.ts"
import type { SetupTuiModule } from "./types.ts"

/** The setup interface cannot be installed or imported, so the line-based setup runs instead. */
export class TuiUnavailable extends Data.TaggedError("TuiUnavailable")<{
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return this.reason
  }
}

/**
 * HolyAgent's per-user cache folder: `LOCALAPPDATA` on Windows (else `AppData/Local` of the home
 * directory), `XDG_CACHE_HOME` elsewhere when it is an absolute path, else `.cache` of the home
 * directory.
 */
export const cacheHome = (env: Env, platform: string = process.platform): string => {
  const home = homeDirectory(env)
  if (platform === "win32")
    return firstNonEmpty(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local")
  const xdg = firstNonEmpty(env["XDG_CACHE_HOME"])
  return xdg !== undefined && (xdg.startsWith("/") || xdg.startsWith("\\"))
    ? xdg
    : join(home, ".cache")
}

/**
 * The folder one set of package versions is installed in: below the cache home, named by the
 * versions, so a newer HolyAgent installs beside the older one instead of changing it.
 */
export const tuiDirectory = (
  env: Env,
  packages: Readonly<Record<string, string>> = TUI_PACKAGES,
  platform: string = process.platform,
): string =>
  join(
    cacheHome(env, platform),
    "holyagent",
    "setup-tui",
    Object.entries(packages)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, version]) => `${name.replace(/^@/, "").replace("/", "-")}-${version}`)
      .join("_"),
  )

/** The steps that touch the network, the disk and the module loader, replaceable in tests. */
export interface LoaderSteps {
  /** Installs `packages` (exact versions) into `directory`. */
  readonly install: (
    directory: string,
    packages: Readonly<Record<string, string>>,
  ) => Effect.Effect<void, TuiUnavailable, Shell>
  /** Imports a module by absolute path. */
  readonly importModule: (path: string) => Effect.Effect<unknown, TuiUnavailable>
}

/** What {@link loadSetupTui} reads and where it works; every field has the real value as default. */
export interface LoaderOptions extends Partial<LoaderSteps> {
  /** The exact versions to install; {@link TUI_PACKAGES}, embedded by the build, when absent. */
  readonly packages?: Readonly<Record<string, string>>
  /** The TUI bundle to run; {@link TUI_BUNDLE} beside the running CLI bundle when absent. */
  readonly bundle?: string
  /** The folder to install into; {@link tuiDirectory} when absent. */
  readonly directory?: string
  /** Called before a first install, which takes a moment; prints nothing when absent. */
  readonly notify?: (text: string) => Effect.Effect<void>
}

const oneLine = (text: string) => text.trim().split("\n")[0] ?? ""

// Bun starts with progress lines ("Resolving dependencies"); the line that says why is the first
// `error` one, else the last line.
const failureLine = (text: string) => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  return lines.find((line) => /^error/i.test(line)) ?? lines.at(-1) ?? ""
}

const unavailable = (what: string, cause: unknown) =>
  new TuiUnavailable({
    reason: `${what}: ${oneLine(cause instanceof Error ? cause.message : String(cause))}`,
  })

/**
 * The install: a package.json with the exact versions, then `bun install` in the folder with no
 * `.env` and the empty Bun config the plugin ships, as the other setup installs run, so no file of
 * the user's project steers it. The registry settings of the user's own `.npmrc` still apply.
 */
export const bunInstall: LoaderSteps["install"] = (directory, packages) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        Bun.write(
          join(directory, "package.json"),
          `${JSON.stringify({ name: "holyagent-setup-tui", private: true, dependencies: packages }, undefined, 2)}\n`,
          { createPath: true },
        ),
      catch: (cause) => unavailable(`cannot write ${join(directory, "package.json")}`, cause),
    })
    const shell = yield* Shell
    const result = yield* shell.run(
      "bun",
      ["--no-env-file", `--config=${EMPTY_BUNFIG}`, "install", "--ignore-scripts"],
      { cwd: directory },
    )
    if (result.exitCode !== 0)
      return yield* new TuiUnavailable({
        reason: `bun install failed (exit ${result.exitCode}): ${failureLine(result.stderr || result.stdout)}`,
      })
  })

/** The real import: a dynamic `import()` of the file URL, which Bun resolves from that folder. */
export const importFile: LoaderSteps["importModule"] = (path) =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(path).href) as Promise<unknown>,
    catch: (cause) => unavailable(`cannot import ${path}`, cause),
  })

const installedVersion = (directory: string, name: string) =>
  Effect.tryPromise(
    () =>
      Bun.file(join(directory, "node_modules", name, "package.json")).json() as Promise<unknown>,
  ).pipe(
    Effect.map((manifest) =>
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? manifest.version
        : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  )

const installed = (directory: string, packages: Readonly<Record<string, string>>) =>
  Effect.forEach(Object.entries(packages), ([name, version]) =>
    installedVersion(directory, name).pipe(Effect.map((found) => found === version)),
  ).pipe(Effect.map((all) => all.every(Boolean)))

const isSetupTuiModule = (value: unknown): value is SetupTuiModule =>
  typeof value === "object" &&
  value !== null &&
  "runSetupTui" in value &&
  typeof value.runSetupTui === "function"

/**
 * Makes the setup interface importable and imports it. OpenTUI's native renderer cannot be bundled
 * into the platform-neutral CLI bundle, and neither the plugin nor the Pi package ships
 * `node_modules`, so the interface is its own bundle ({@link TUI_BUNDLE}, built with the Solid
 * plugin) and the packages it runs on are installed on first use, at the exact versions the build
 * took from `bun.lock`, into a per-user cache folder ({@link tuiDirectory}). A folder whose
 * packages are all at those versions is not installed again. The bundle is copied next to the
 * installed `node_modules`, where its imports resolve, Solid's preload (which makes Bun load
 * Solid's browser build) is imported, and then the bundle. Any step that fails, offline included,
 * is a {@link TuiUnavailable} naming it.
 */
export const loadSetupTui = (
  env: Env,
  options: LoaderOptions = {},
): Effect.Effect<SetupTuiModule, TuiUnavailable, Shell> =>
  Effect.gen(function* () {
    const packages = options.packages ?? TUI_PACKAGES
    const directory = options.directory ?? tuiDirectory(env, packages)
    const source = options.bundle ?? join(import.meta.dir, TUI_BUNDLE)
    const install = options.install ?? bunInstall
    const importModule = options.importModule ?? importFile
    const text = yield* Effect.tryPromise({
      try: () => Bun.file(source).text(),
      catch: (cause) => unavailable(`the interface bundle ${source} is missing`, cause),
    })
    if (!(yield* installed(directory, packages))) {
      if (options.notify !== undefined)
        yield* options.notify(
          `~ t3 tui: installing the setup interface into ${directory} (first run only)\n`,
        )
      yield* install(directory, packages)
      if (!(yield* installed(directory, packages)))
        return yield* new TuiUnavailable({
          reason: `the install finished but ${directory} does not hold the expected package versions`,
        })
    }
    const target = join(directory, TUI_BUNDLE)
    yield* Effect.tryPromise({
      try: () => Bun.write(target, text, { createPath: true }),
      catch: (cause) => unavailable(`cannot write ${target}`, cause),
    })
    yield* importModule(
      join(directory, "node_modules", "@opentui", "solid", "scripts", "preload.js"),
    )
    const loaded = yield* importModule(target)
    if (!isSetupTuiModule(loaded))
      return yield* new TuiUnavailable({ reason: `${target} does not export runSetupTui` })
    return loaded
  })
