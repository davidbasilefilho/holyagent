import { $ } from "bun"
import { Effect, Schema } from "effect"

import { PreviewBlocked, previewVersion } from "./npm-preview.ts"

const dist = "packages/integrations/pi/dist"
const directories = new Set(["agents", "extensions", "families", "prompts", "scripts", "guidance"])
const bytesLimit = 24 * 1024 * 1024
const fileLimit = 512
const pattern = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
const windowsDevice = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i
const repoUrl = "https://github.com/davidbasilefilho/holyagent"
const stable = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const fields = [
  "name",
  "version",
  "description",
  "license",
  "author",
  "repository",
  "type",
  "bin",
  "keywords",
  "files",
  "pi",
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
]
const map = Schema.Record(Schema.String, Schema.Unknown)
const Manifest = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.Literal("holyagent"),
    version: Schema.String,
    repository: Schema.Struct({
      type: Schema.Literal("git"),
      url: Schema.Literal(repoUrl),
      directory: Schema.Literal(dist),
    }),
    bin: Schema.Struct({
      holyagent: Schema.Literal("./scripts/holyagent-public-bin.js"),
      "holyagent-cli": Schema.Literal("./scripts/holyagent-cli-bin.js"),
    }),
  }),
  [map],
)

const refused = (detail: string) => new PreviewBlocked({ detail })
const commitSha = /^[a-f0-9]{40}$/
const controls = [
  ".github",
  ".gitattributes",
  ".gitmodules",
  ".npmrc",
  "bunfig.toml",
  ".bunfig.toml",
  "mise.toml",
  "hk.pkl",
  "tsconfig.json",
  ".oxfmtrc.json",
  ".oxlintrc.json",
  "bun.lock",
  "scripts",
  "package.json",
  ":(glob)**/package.json",
  ":(glob)packages/integrations/**/build.ts",
]

/** Reject a candidate's own CI, package, dependency, build or release-control changes. */
export const comparePreviewControls = (
  root: string,
  protectedSource: string,
  head: string,
): Effect.Effect<
  { readonly source: string; readonly sha: string; readonly unchanged: boolean },
  PreviewBlocked
> =>
  Effect.tryPromise({
    try: async () => {
      if (!commitSha.test(protectedSource) || !commitSha.test(head))
        throw refused("Invalid control SHA")
      const result =
        await $`git --no-replace-objects diff --quiet --no-ext-diff --no-textconv ${protectedSource} ${head} -- ${controls}`
          .cwd(root)
          .quiet()
          .nothrow()
      if (result.exitCode !== 0 && result.exitCode !== 1)
        throw refused("Could not compare the candidate control files")
      return { source: protectedSource, sha: head, unchanged: result.exitCode === 0 }
    },
    catch: (cause) =>
      cause instanceof PreviewBlocked
        ? cause
        : refused("Could not compare the candidate control files"),
  })

/** One regular, size-bounded file from the generated public package Git tree. */
export interface PreviewTreeEntry {
  readonly path: string
  readonly oid: string
  readonly size: number
  readonly executable: boolean
}

/** Parse Git's NUL-delimited tree data without following symlinks, filters or archive attributes. */
export const previewTree = (output: string): readonly PreviewTreeEntry[] => {
  const rows = output.split("\x00")
  if (rows.pop() !== "" || rows.length === 0 || rows.length > fileLimit)
    throw refused("Invalid or oversize preview tree")
  let total = 0
  const seen = new Set<string>()
  const entries: PreviewTreeEntry[] = []
  for (const row of rows) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +(0|[1-9]\d*)\t(.+)$/.exec(row)
    if (!match) throw refused("Only regular Git blobs are allowed in the preview package")
    const [, mode, oid = "", sizeText = "", original = ""] = match
    const path = original.slice(dist.length + 1)
    const segments = path.split("/")
    const top = segments[0] ?? ""
    const size = Number(sizeText)
    if (
      !original.startsWith(`${dist}/`) ||
      (path !== "package.json" && (segments.length < 2 || !directories.has(top))) ||
      path.length > 92 ||
      segments.some(
        (part) => !pattern.test(part) || part.endsWith(".") || windowsDevice.test(part),
      ) ||
      !Number.isSafeInteger(size) ||
      size > bytesLimit ||
      seen.has(path.toLowerCase())
    )
      throw refused("Unexpected path, duplicate name or oversize preview file")
    if (
      segments.some((part) =>
        /^(?:node_modules|package-lock\.json|npm-shrinkwrap\.json)$/i.test(part),
      )
    )
      throw refused("Dependency trees and lockfiles may not be shipped in a preview")
    seen.add(path.toLowerCase())
    total += size
    if (total > bytesLimit) throw refused("Preview files exceed the archive size limit")
    entries.push({ path, oid, size, executable: mode === "100755" })
  }
  for (const required of [
    "package.json",
    "scripts/holyagent-public-bin.js",
    "scripts/holyagent-cli-bin.js",
  ]) {
    const entry = entries.find(({ path }) => path === required)
    if (!entry || (required !== "package.json" && !entry.executable))
      throw refused("A required preview package entry is missing or not executable")
  }
  return entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const replaceManifest = (data: Buffer, base: string, version: string) => {
  const raw: unknown = JSON.parse(data.toString("utf8"))
  const manifest = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" })(raw)
  if (manifest.version !== base || Object.keys(manifest).some((key) => !fields.includes(key)))
    throw refused("Unexpected preview manifest versions or keys, including lifecycle configuration")
  return Buffer.from(JSON.stringify({ ...manifest, version }, null, 2) + "\n")
}

const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0"

const header = (path: string, size: number, executable: boolean) => {
  const h = Buffer.alloc(512)
  h.write(`package/${path}`, 0, "ascii")
  h.write(octal(executable ? 0o755 : 0o644, 8), 100, "ascii")
  h.write(octal(0, 8), 108, "ascii")
  h.write(octal(0, 8), 116, "ascii")
  h.write(octal(size, 12), 124, "ascii")
  h.write(octal(0, 12), 136, "ascii")
  h.fill(32, 148, 156)
  h.write("0", 156, "ascii")
  h.write("ustar\0", 257, "ascii")
  h.write("00", 263, "ascii")
  const sum = h.reduce((total, byte) => total + byte, 0)
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii")
  return h
}

const readBlobs = (data: Buffer, entries: readonly PreviewTreeEntry[]) => {
  let offset = 0
  const contents = entries.map((entry) => {
    const expected = Buffer.from(`${entry.oid} blob ${entry.size}`, "ascii")
    const limit = offset + expected.byteLength
    const end = limit + 1 + entry.size
    if (
      end >= data.length ||
      !data.subarray(offset, limit).equals(expected) ||
      data[limit] !== 10 ||
      data[end] !== 10
    )
      throw refused("The Git blob batch did not match the approved tree")
    const blob = data.subarray(limit + 1, end)
    offset = end + 1
    return blob
  })
  if (offset !== data.length) throw refused("Unexpected data followed the approved Git blobs")
  return contents
}

/**
 * Export the exact already reviewed SHA into an npm tarball without checking it out or executing
 * it.
 */
export const packPreview = (
  root: string,
  number: number,
  sha: string,
  expectedCommitUtc: string,
): Effect.Effect<
  { readonly archive: Uint8Array; readonly integrity: string; readonly version: string },
  PreviewBlocked
> =>
  Effect.tryPromise({
    try: async () => {
      if (!commitSha.test(sha) || !Number.isSafeInteger(number) || number < 1)
        throw refused("Invalid PR or commit SHA")
      const git = (args: string[]) => $`git --no-replace-objects ${args}`.cwd(root).quiet()
      const time = (await git(["show", "--no-notes", "-s", "--format=%cI", sha])).text().trim()
      const parsedTime = new Date(time).toISOString().replace(".000Z", "Z")
      if (parsedTime !== expectedCommitUtc) throw refused("The candidate committer UTC has changed")
      const rootManifest = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.StructWithRest(Schema.Struct({ version: Schema.String }), [map]),
        ),
        { onExcessProperty: "error" },
      )((await git(["cat-file", "blob", `${sha}:package.json`])).text())
      if (!stable.test(rootManifest.version)) throw refused("Unexpected preview base version")
      const version = previewVersion(rootManifest.version, number, parsedTime, sha)
      const entries = previewTree(
        (await git(["ls-tree", "-r", "-l", "-z", "--full-tree", sha, "--", dist])).text(),
      )
      // These exact hashes and lengths have already passed the preview tree allowlist and bounds.
      // One read-only Git process avoids starting hundreds of processes on Windows runners.
      const input = new Blob([entries.map(({ oid }) => `${oid}\n`).join("")])
      const batch = await $`git --no-replace-objects cat-file --batch < ${input}`.cwd(root).quiet()
      const contents = readBlobs(batch.stdout, entries)
      const pieces: Buffer[] = []
      for (const [index, file] of entries.entries()) {
        const source = contents[index]
        if (source === undefined) throw refused("Missing approved preview blob")
        const data =
          file.path === "package.json"
            ? replaceManifest(source, rootManifest.version, version)
            : source
        pieces.push(header(file.path, data.byteLength, file.executable), data)
        const trailing = (512 - (data.byteLength % 512)) % 512
        if (trailing) pieces.push(Buffer.alloc(trailing))
      }
      pieces.push(Buffer.alloc(1024))
      const archive = Bun.gzipSync(Buffer.concat(pieces))
      const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(archive).digest("base64")}`
      return { archive, integrity, version }
    },
    catch: (cause) =>
      cause instanceof PreviewBlocked
        ? cause
        : refused("Could not read the approved Git package tree"),
  })
