import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { Data, Effect } from "effect"

import { type Env, firstNonEmpty, homeDirectory } from "../environment.ts"
import { EMPTY_BUNFIG, Shell } from "../shell.ts"
import { TUI_BUNDLE } from "./files.ts"
import { TUI_MANIFEST_NAME } from "./lock.ts"
import { TUI_LOCK, TUI_PACKAGES } from "./packages.ts"
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

/** The folders below the cache home that hold HolyAgent's setup interface, outermost first. */
const guardedFolders = (env: Env, platform: string): ReadonlyArray<string> => {
  const holyagent = join(cacheHome(env, platform), "holyagent")
  return [holyagent, join(holyagent, "setup-tui")]
}

/**
 * The folder one set of packages is installed in: below the cache home, named by the exact versions
 * and a short hash of the lockfile they install from, so a newer HolyAgent, or a lock that moved a
 * transitive package, installs beside the older folder instead of changing it.
 */
export const tuiDirectory = (
  env: Env,
  packages: Readonly<Record<string, string>> = TUI_PACKAGES,
  platform: string = process.platform,
  lock: string = TUI_LOCK,
): string =>
  join(
    guardedFolders(env, platform)[1] ?? "",
    [
      ...Object.entries(packages)
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, version]) => `${name.replace(/^@/, "").replace("/", "-")}-${version}`),
      new Bun.CryptoHasher("sha256").update(lock).digest("hex").slice(0, 8),
    ].join("_"),
  )

/**
 * The file an install writes last, after everything else is in place and the folder is renamed to
 * its final name. A folder without it, from an interrupted install or any other cause, is absent.
 */
export const INSTALLED_MARKER = ".holyagent-installed"

/** The text of {@link INSTALLED_MARKER} for a set of packages. */
export const markerText = (packages: Readonly<Record<string, string>>): string =>
  `${JSON.stringify(packages)}\n`

/** The steps that touch the network, the disk and the module loader, replaceable in tests. */
export interface LoaderSteps {
  /**
   * Installs `packages` (exact versions) into the empty folder `directory`, from the lockfile text
   * `lock`.
   */
  readonly install: (
    directory: string,
    packages: Readonly<Record<string, string>>,
    lock: string,
  ) => Effect.Effect<void, TuiUnavailable, Shell>
  /** Imports a module by absolute path. */
  readonly importModule: (path: string) => Effect.Effect<unknown, TuiUnavailable>
}

/** What {@link loadSetupTui} reads and where it works; every field has the real value as default. */
export interface LoaderOptions extends Partial<LoaderSteps> {
  /** The exact versions to install; {@link TUI_PACKAGES}, embedded by the build, when absent. */
  readonly packages?: Readonly<Record<string, string>>
  /** The lockfile to install from; {@link TUI_LOCK}, embedded by the build, when absent. */
  readonly lock?: string
  /** The TUI bundle to run; {@link TUI_BUNDLE} beside the running CLI bundle when absent. */
  readonly bundle?: string
  /** The folder to install into; {@link tuiDirectory} when absent. */
  readonly directory?: string
  /**
   * The user id that must own the cache folders. The id of the process when absent, and none on a
   * platform without user ids (Windows), where ownership and permissions are not checked.
   */
  readonly uid?: number
  /** Called before a first install, which takes a moment; prints nothing when absent. */
  readonly notify?: (text: string) => Effect.Effect<void>
}

/**
 * Text with escape sequences, control characters and line breaks removed: what a tool such as Bun,
 * or a registry behind it, printed is shown to the user only as plain characters, so it cannot
 * recolour the terminal or move the cursor.
 */
export const plain = (text: string): string =>
  Array.from(Bun.stripANSI(text))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code > 0x1f && (code < 0x7f || code > 0x9f)
    })
    .join("")

const oneLine = (text: string) => plain(text.trim().split("\n")[0] ?? "").trim()

// Bun starts with progress lines ("Resolving dependencies"); the line that says why is the first
// `error` one, else the last line.
const failureLine = (text: string) => {
  const lines = text
    .split("\n")
    .map((line) => plain(line).trim())
    .filter((line) => line !== "")
  return lines.find((line) => /^error/i.test(line)) ?? lines.at(-1) ?? ""
}

const unavailable = (what: string, cause: unknown) =>
  new TuiUnavailable({
    reason: plain(`${what}: ${oneLine(cause instanceof Error ? cause.message : String(cause))}`),
  })

/**
 * The install into a fresh, empty folder: a package.json with the exact versions and the lockfile
 * subset the build embedded, then `bun install --frozen-lockfile` with no `.env` and the empty Bun
 * config the plugin ships, as the other setup installs run, so no file of the user's project steers
 * it. `--frozen-lockfile` makes Bun fail instead of resolving anything the lock does not name, so
 * the whole tree (Solid's `s-js` and the native `@opentui/core-<platform>` included) is the one the
 * bundle was built against, with the lock's integrity hashes. The registry settings of the user's
 * own `.npmrc` still apply.
 */
export const bunInstall = (
  directory: string,
  packages: Readonly<Record<string, string>>,
  lock: string = TUI_LOCK,
): Effect.Effect<void, TuiUnavailable, Shell> =>
  Effect.gen(function* () {
    const manifest = `${JSON.stringify({ name: TUI_MANIFEST_NAME, private: true, dependencies: packages }, undefined, 2)}\n`
    for (const [file, text] of [
      ["package.json", manifest],
      ["bun.lock", lock],
    ] as const)
      yield* Effect.tryPromise({
        try: () => Bun.write(join(directory, file), text, { createPath: true }),
        catch: (cause) => unavailable(`cannot write ${join(directory, file)}`, cause),
      })
    const shell = yield* Shell
    const result = yield* shell.run(
      "bun",
      [
        "--no-env-file",
        `--config=${EMPTY_BUNFIG}`,
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
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

const hasPackages = (directory: string, packages: Readonly<Record<string, string>>) =>
  Effect.forEach(Object.entries(packages), ([name, version]) =>
    installedVersion(directory, name).pipe(Effect.map((found) => found === version)),
  ).pipe(Effect.map((all) => all.every(Boolean)))

// A folder counts as installed only with the marker an install writes last, holding these
// packages, and every package in place at its version.
const installed = (directory: string, packages: Readonly<Record<string, string>>) =>
  Effect.tryPromise(() => Bun.file(join(directory, INSTALLED_MARKER)).text()).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((marker) =>
      marker === markerText(packages) ? hasPackages(directory, packages) : Effect.succeed(false),
    ),
  )

const isSetupTuiModule = (value: unknown): value is SetupTuiModule =>
  typeof value === "object" &&
  value !== null &&
  "runSetupTui" in value &&
  typeof value.runSetupTui === "function"

const fileSystem = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => unavailable(what, cause) })

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined

/**
 * Makes sure `folder` is a directory only the current user can change, creating it with mode 0700
 * (where the OS has modes) when it is missing: it must not be a symbolic link, must belong to `uid`
 * and must not be writable by group or others, or whoever can write there could plant the code that
 * setup then runs. Not checked where there is no `uid` (Windows).
 */
const privateFolder = (folder: string, uid: number | undefined, create: boolean) =>
  Effect.gen(function* () {
    if (create)
      yield* fileSystem(`cannot create ${folder}`, () =>
        mkdir(folder, { recursive: true, mode: 0o700 }),
      )
    const found = yield* Effect.tryPromise({
      try: () => lstat(folder),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        errorCode(cause) === "ENOENT" && !create
          ? Effect.succeed(undefined)
          : Effect.fail(unavailable(`cannot check ${folder}`, cause)),
      ),
    )
    if (found === undefined || uid === undefined) return
    const refuse = (why: string) =>
      new TuiUnavailable({
        reason: `the cache folder ${folder} ${why}; run chmod 700 on it, or remove it`,
      })
    if (found.isSymbolicLink() || !found.isDirectory())
      return yield* refuse("is not a plain directory")
    if (found.uid !== uid) return yield* refuse("belongs to another user")
    if ((found.mode & 0o022) !== 0) return yield* refuse("can be written by others")
  })

/** Writes `text` to `target` without following a link planted there: a new file, then a rename. */
const writeFresh = (target: string, text: string) =>
  Effect.acquireUseRelease(
    Effect.succeed(`${target}.${crypto.randomUUID()}.tmp`),
    (temporary) =>
      fileSystem(`cannot write ${target}`, () =>
        writeFile(temporary, text, { flag: "wx", mode: 0o600 }),
      ).pipe(Effect.andThen(fileSystem(`cannot write ${target}`, () => rename(temporary, target)))),
    (temporary) => Effect.promise(() => rm(temporary, { force: true })),
  )

const remove = (path: string) => Effect.promise(() => rm(path, { recursive: true, force: true }))

/**
 * Moves the finished install into place. When another run got there first the rename fails: its
 * folder wins if it is complete; a folder without the marker (an install that was killed before
 * this change, or a damaged one) is removed and the rename tried again.
 */
const promote = (
  temporary: string,
  directory: string,
  packages: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const moved = yield* Effect.exit(
        fileSystem(`cannot move ${temporary}`, () => rename(temporary, directory)),
      )
      if (moved._tag === "Success") return
      if (yield* installed(directory, packages)) return
      yield* remove(directory)
    }
    return yield* new TuiUnavailable({ reason: `cannot move the install into ${directory}` })
  })

/**
 * Installs into a fresh folder beside `directory` and renames it into place, so `directory` is
 * either absent or complete: an interrupted install, or a half-written file, never shows up there,
 * and two first runs at once each install on their own and the first rename wins. The marker is
 * written last, and the temporary folder is removed whatever happens.
 */
const installAtomically = (
  directory: string,
  packages: Readonly<Record<string, string>>,
  lock: string,
  install: LoaderSteps["install"],
) =>
  Effect.acquireUseRelease(
    fileSystem(`cannot create a folder beside ${directory}`, () =>
      mkdtemp(join(dirname(directory), `.${basename(directory)}-`)),
    ),
    (temporary) =>
      Effect.gen(function* () {
        yield* install(temporary, packages, lock)
        if (!(yield* hasPackages(temporary, packages)))
          return yield* new TuiUnavailable({
            reason: `the install finished but ${directory} does not hold the expected package versions`,
          })
        yield* writeFresh(join(temporary, INSTALLED_MARKER), markerText(packages))
        yield* promote(temporary, directory, packages)
      }),
    remove,
  )

/**
 * Makes the setup interface importable and imports it. OpenTUI's native renderer cannot be bundled
 * into the platform-neutral CLI bundle, and neither the plugin nor the Pi package ships
 * `node_modules`, so the interface is its own bundle ({@link TUI_BUNDLE}, built with the Solid
 * plugin) and the packages it runs on are installed on first use, from the lockfile subset the
 * build embedded ({@link TUI_LOCK}), into a per-user cache folder ({@link tuiDirectory}). The cache
 * folders are created private (mode 0700) and are refused when they are another user's or writable
 * by others. An install goes into a temporary folder that is renamed into place with a completion
 * marker, so a folder without the marker counts as absent. The bundle is copied next to the
 * installed `node_modules`, where its imports resolve, without following a link planted at its
 * path; Solid's preload (which makes Bun load Solid's browser build) is imported, and then the
 * bundle. Any step that fails, offline included, is a {@link TuiUnavailable} naming it.
 */
export const loadSetupTui = (
  env: Env,
  options: LoaderOptions = {},
): Effect.Effect<SetupTuiModule, TuiUnavailable, Shell> =>
  Effect.gen(function* () {
    const packages = options.packages ?? TUI_PACKAGES
    const lock = options.lock ?? TUI_LOCK
    const directory = options.directory ?? tuiDirectory(env, packages, process.platform, lock)
    const source = options.bundle ?? join(import.meta.dir, TUI_BUNDLE)
    const install = options.install ?? bunInstall
    const importModule = options.importModule ?? importFile
    const uid = options.uid ?? process.getuid?.()
    const text = yield* Effect.tryPromise({
      try: () => Bun.file(source).text(),
      catch: (cause) => unavailable(`the interface bundle ${source} is missing`, cause),
    })
    for (const folder of options.directory === undefined
      ? guardedFolders(env, process.platform)
      : [dirname(directory)])
      yield* privateFolder(folder, uid, true)
    yield* privateFolder(directory, uid, false)
    if (!(yield* installed(directory, packages))) {
      if (options.notify !== undefined)
        yield* options.notify(
          `~ t3 tui: installing the setup interface into ${directory} (first run only)\n`,
        )
      yield* installAtomically(directory, packages, lock, install)
    }
    const target = join(directory, TUI_BUNDLE)
    yield* writeFresh(target, text)
    yield* importModule(
      join(directory, "node_modules", "@opentui", "solid", "scripts", "preload.js"),
    )
    const loaded = yield* importModule(target)
    if (!isSetupTuiModule(loaded))
      return yield* new TuiUnavailable({ reason: `${target} does not export runSetupTui` })
    return loaded
  })
