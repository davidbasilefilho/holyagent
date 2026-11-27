import { lstat, realpath, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { Effect } from "effect"

import { hasCode } from "../../../../core/src/state/files.ts"
import { type Env, homeDirectory } from "../environment.ts"
import { SetupFailure } from "../errors.ts"
import { added, hint, type Report } from "../report.ts"
import { type CodexAsset, CODEX_ASSET_VERSION, codexSkillFiles } from "./assets.ts"
import { defaultCodexHome } from "./setup.ts"

const failed = (message: string) => new SetupFailure({ message })

const portableFiles = (version: string): ReadonlyArray<CodexAsset> => [
  {
    path: "plugin.json",
    content: `${JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "holyagent",
        version,
        description: "Scope, ownership and evidence for Codex work.",
        extensions: { "com.openai": { interface: { displayName: "HolyAgent" } } },
      },
      null,
      2,
    )}\n`,
  },
  ...codexSkillFiles,
]

const DOS_EPOCH = 0x21
const UTF8 = 0x800
const MAX_ARCHIVE_CONTENT = 1024 * 1024

// A ZIP32 STORE archive needs only local file records, a central directory and the end record.
// The inputs are the fixed, bounded bundled files above, never a user-supplied tree.
const zip = (files: ReadonlyArray<CodexAsset>): Buffer => {
  const body: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const { path, content } of files) {
    const name = Buffer.from(path)
    const data = Buffer.from(content)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8, 6)
    local.writeUInt16LE(DOS_EPOCH, 12)
    local.writeUInt32LE(Bun.hash.crc32(data), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)

    const entry = Buffer.alloc(46 + name.length)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    // Version-needed through file name length have the same layout in both records.
    local.copy(entry, 6, 4, 28)
    entry.writeUInt32LE(offset, 42)
    name.copy(entry, 46)
    directory.push(entry)
    body.push(local, data)
    offset += local.length + data.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...body, central, end])
}

const inside = (root: string, path: string) => {
  const rest = relative(root, path)
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}

const isOrdinaryZip = (path: string) =>
  !/\p{Cc}/u.test(path) &&
  !/[/\\]$/.test(path) &&
  extname(path).toLowerCase() === ".zip" &&
  (process.platform !== "win32" ||
    (!/^[/\\]{2}/.test(path) &&
      !/^\w:(?![/\\])/.test(path) &&
      !/[:<>|?*"]/.test(path.replace(/^[a-z]:/i, "")) &&
      !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(basename(path))))

const existsAt = (path: string, failure: string) =>
  Effect.tryPromise({ try: () => lstat(path).then(() => true), catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      hasCode(cause, "ENOENT") ? Effect.succeed(false) : Effect.fail(failed(failure)),
    ),
  )

const canonicalHome = Effect.fn("codexCloudCanonicalHome")(function* (home: string) {
  const failure = "A Codex profile path could not be resolved safely."
  let ancestor = home
  const missing: string[] = []
  while (true) {
    const canonical = yield* Effect.tryPromise({
      try: () => realpath(ancestor),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        hasCode(cause, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(failed(failure)),
      ),
    )
    if (canonical !== undefined) return join(canonical, ...missing)
    // A dangling link is not a missing path with a known physical location.
    if (yield* existsAt(ancestor, failure)) return yield* failed(failure)
    const parent = dirname(ancestor)
    if (parent === ancestor) return yield* failed(failure)
    missing.unshift(basename(ancestor))
    ancestor = parent
  }
})

const destination = Effect.fn("codexCloudArchiveDestination")(function* (
  env: Env,
  cwd: string,
  output: string,
) {
  if (!isOrdinaryZip(output)) return yield* failed("Choose a local .zip file after --output.")
  const requested = resolve(cwd, output)
  if (!isOrdinaryZip(requested))
    return yield* failed("Choose a local directory for the plugin ZIP.")
  const directory = yield* Effect.tryPromise({
    try: () => realpath(dirname(requested)),
    catch: () => failed("The output directory must already exist."),
  })
  const metadata = yield* Effect.tryPromise({
    try: () => stat(directory),
    catch: () => failed("The output directory could not be inspected."),
  })
  if (!metadata.isDirectory()) return yield* failed("The output parent must be a directory.")
  if (process.platform === "win32" && directory.startsWith("\\\\"))
    return yield* failed("Choose a local directory for the plugin ZIP.")
  const target = join(directory, basename(requested))
  const homes = [
    join(homeDirectory(env), ".codex"),
    defaultCodexHome(env),
    ...(env["CODEX_HOME"] ? [resolve(cwd, env["CODEX_HOME"])] : []),
  ]
  for (const home of homes) {
    if (inside(home, requested))
      return yield* failed("Choose an output path outside Codex profile directories.")
    const canonical = yield* canonicalHome(home)
    if (inside(canonical, target))
      return yield* failed("Choose an output path outside Codex profile directories.")
  }
  const exists = yield* existsAt(target, "The output path could not be inspected.")
  if (exists) return yield* failed("The output path already exists. Choose a new .zip file.")
  return target
})

/** Builds a private workspace import archive locally and reports the steps still owned by the host. */
export const exportCodexCloud = Effect.fn("exportCodexCloud")(function* (
  env: Env,
  cwd: string,
  output: string,
  dryRun: boolean,
  version = CODEX_ASSET_VERSION,
): Effect.fn.Return<Report, SetupFailure> {
  const path = yield* destination(env, cwd, output)
  const files = portableFiles(version)
  const size = files.reduce((total, { content }) => total + Buffer.byteLength(content), 0)
  if (size > MAX_ARCHIVE_CONTENT)
    return yield* failed("The bundled plugin exceeds the export limit.")
  if (!dryRun)
    yield* Effect.tryPromise({
      try: () => writeFile(path, zip(files), { flag: "wx", mode: 0o600 }),
      catch: (cause) =>
        hasCode(cause, "EEXIST")
          ? failed("The output path already exists. Choose a new .zip file.")
          : failed(
              `Could not write the plugin ZIP at ${path}. If a partial file was created, choose a new output path.`,
            ),
    })
  return {
    ok: true,
    lines: [
      added(
        dryRun
          ? `Would export the HolyAgent plugin ZIP to ${path}`
          : `Exported the HolyAgent plugin ZIP to ${path}`,
      ),
      hint(
        "Workspace availability was not checked. An eligible workspace administrator can upload the ZIP in Admin console → Plugins → Add → Upload plugin, subject to the workspace's permissions.",
      ),
      hint(
        "If HolyAgent is available to your account and the Cloud task offers plugin selection, select it in Sources → Use plugins when starting a new task.",
      ),
      hint(
        "Cloud activation is unverified. Check that the new task can see the HolyAgent skills. This export does not change a Cloud environment or a running task.",
      ),
    ],
  }
})
