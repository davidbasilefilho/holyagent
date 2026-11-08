/**
 * The pure part of the pin updater: which release a pin moves to and how each kind of pin is read
 * from and written back into its file. It touches no network and no file, so fixtures test it.
 */

/** A stable release, `major.minor.patch`, with no prerelease or build suffix. */
export interface Release {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * Parses a stable release. A prerelease (`1.2.3-rc.1`), a build suffix (`1.2.3+abc`), a leading `v`
 * and anything that is not exactly three numbers give `undefined`: the updater must never move a
 * pin to a version it cannot call stable.
 */
export const parseRelease = (text: string): Release | undefined => {
  const [, major, minor, patch] = STABLE.exec(text) ?? []
  return major === undefined || minor === undefined || patch === undefined
    ? undefined
    : { major: Number(major), minor: Number(minor), patch: Number(patch) }
}

/** Orders two releases: negative when `a` is older than `b`, zero when equal, positive when newer. */
export const compareReleases = (a: Release, b: Release): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch

/** The release as `major.minor.patch`. */
export const formatRelease = ({ major, minor, patch }: Release): string =>
  `${major}.${minor}.${patch}`

/**
 * The newest stable release among some version strings. The newest release decides the release line
 * (the major, or the minor for a `0.x` project, or the patch for `0.0.x`), so the newest release is
 * also the newest one within the newest line. Prereleases and strings that are not versions are
 * ignored; with no stable release the result is `undefined`.
 */
export const newestRelease = (versions: Iterable<string>): string | undefined => {
  let newest: Release | undefined
  for (const text of versions) {
    const release = parseRelease(text)
    if (release !== undefined && (newest === undefined || compareReleases(release, newest) > 0))
      newest = release
  }
  return newest === undefined ? undefined : formatRelease(newest)
}

/**
 * The caret range at the boundary of a release's line: `^X.0.0` for a major of 1 or more, `^0.X.0`
 * for a `0.x` release and `^0.0.X` for a `0.0.x` one. It accepts every later release of the line,
 * and none of the next line.
 */
export const caretRange = (release: string): string => {
  const parsed = parseRelease(release)
  if (parsed === undefined) throw new Error(`${release} is not a stable release`)
  if (parsed.major >= 1) return `^${parsed.major}.0.0`
  if (parsed.minor >= 1) return `^0.${parsed.minor}.0`
  return `^0.0.${parsed.patch}`
}

/**
 * The range a dependency moves to: the caret range of `release`, unless the current range is a
 * caret range that already starts above it, which is kept. A registry whose `latest` tag points at
 * an older line (a backport published last) must not move a dependency down.
 */
export const nextRange = (current: string, release: string): string => {
  const next = caretRange(release)
  const from = parseRelease(current.startsWith("^") ? current.slice(1) : "")
  const to = parseRelease(next.slice(1))
  return from !== undefined && to !== undefined && compareReleases(from, to) > 0 ? current : next
}

/** The stable release a git tag names, given the tag prefix (`v`, or `bun-v`), else `undefined`. */
export const releaseOfTag = (tag: string, prefix: string): string | undefined => {
  if (!tag.startsWith(prefix)) return undefined
  const text = tag.slice(prefix.length)
  return parseRelease(text) === undefined ? undefined : text
}

/** A tag of a repository and the commit it resolves to. */
export interface Tag {
  readonly name: string
  readonly sha: string
}

/**
 * Reads the output of `git ls-remote --tags`. A line is `<sha>\trefs/tags/<name>`, and an annotated
 * tag has a second line `refs/tags/<name>^{}` with the commit it points at; that commit replaces
 * the tag object, because a workflow pins a commit.
 */
export const parseTags = (output: string): ReadonlyArray<Tag> => {
  const tags = new Map<string, string>()
  const peeled = new Map<string, string>()
  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(\S+?)(\^\{\})?$/.exec(line.trim())
    if (match === null) continue
    const [, sha = "", name = "", suffix] = match
    ;(suffix === undefined ? tags : peeled).set(name, sha)
  }
  return [...tags].map(([name, sha]) => ({ name, sha: peeled.get(name) ?? sha }))
}

/**
 * The release a package should move to: the newest stable version that is not deprecated and is no
 * higher than the registry's `latest` dist-tag. The tag is the publisher's own statement of the
 * current release, so a version published above it (a canary, say) is not chosen as the range. It
 * caps only that range: `bun update` resolves the lockfile within the range by its own rules and
 * can reach a release above the tag. A `latest` that is not a stable release gives `undefined`, as
 * does no eligible version. `versions` maps each published version to its metadata, where a truthy
 * `deprecated` marks it.
 */
export const newestAllowedRelease = (
  versions: Readonly<Record<string, { readonly deprecated?: unknown }>>,
  latest: string,
): string | undefined => {
  const cap = parseRelease(latest)
  if (cap === undefined) return undefined
  return newestRelease(
    Object.entries(versions).flatMap(([version, metadata]) => {
      const release = parseRelease(version)
      return release !== undefined && !metadata.deprecated && compareReleases(release, cap) <= 0
        ? [version]
        : []
    }),
  )
}

/**
 * The newest stable tag among some tags, with its release: tags that are not `<prefix>X.Y.Z`
 * (floating tags such as `v7`, prereleases, other products' tags) are ignored.
 */
export const newestTag = (
  tags: ReadonlyArray<Tag>,
  prefix: string,
): { readonly release: string; readonly tag: Tag } | undefined => {
  const byRelease = new Map<string, Tag>()
  for (const tag of tags) {
    const release = releaseOfTag(tag.name, prefix)
    if (release !== undefined) byRelease.set(release, tag)
  }
  const release = newestRelease(byRelease.keys())
  const tag = release === undefined ? undefined : byRelease.get(release)
  return release === undefined || tag === undefined ? undefined : { release, tag }
}

/**
 * The SHA-256 a `<asset>.sha256` file publishes: the first run of exactly 64 hex digits, as
 * lowercase hex, else `undefined`. The files come in two layouts: `sha256sum`'s `<hash> <name>` and
 * the Windows `CertUtil` report, where a line `SHA256 hash of <name>:` comes before the hash.
 */
export const parseChecksumFile = (text: string): string | undefined =>
  /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i.exec(text)?.[0].toLowerCase()

/**
 * The SHA-256 in a GitHub release asset `digest` (`sha256:<hex>`) as lowercase hex, else
 * `undefined`.
 */
export const parseDigest = (digest: string): string | undefined =>
  /^sha256:([0-9a-f]{64})$/i.exec(digest)?.[1]?.toLowerCase()

/** One external action reference in a workflow: `uses: owner/repo[/path]@<sha> # vX.Y.Z`. */
export interface ActionUse {
  /** `owner/repo`, without any path inside the repository. */
  readonly repository: string
  readonly sha: string
  /** The version in the trailing comment, with its `v`. */
  readonly version: string
}

const ACTION_USE =
  /^(\s*(?:-\s+)?uses:\s*)([\w.-]+\/[\w.-]+)((?:\/[\w./-]+)?)@([0-9a-f]{40})([ \t]*# )(v\d+\.\d+\.\d+)$/gm

/** The pinned external actions of a workflow or action file; local `./` references are not pins. */
export const parseActionUses = (text: string): ReadonlyArray<ActionUse> =>
  [...text.matchAll(ACTION_USE)].map(([, , repository = "", , sha = "", , version = ""]) => ({
    repository,
    sha,
    version,
  }))

const ACTION_LINE = new RegExp(ACTION_USE.source)
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(\S+)/

/**
 * The external `uses:` lines of a workflow or action file that `parseActionUses` cannot read: no
 * full commit SHA, or a trailing comment other than `# vX.Y.Z`. The updater cannot move these, so
 * it reports them instead of letting a stale action pass unnoticed. Local (`./`) and `docker://`
 * references are not pins and are not listed. Each line is trimmed; lines end in LF or CRLF.
 */
export const unreadableActionUses = (text: string): ReadonlyArray<string> =>
  text.split(/\r?\n/).flatMap((line) => {
    const target = USES_LINE.exec(line)?.[1]
    return target === undefined ||
      target.startsWith("./") ||
      target.startsWith("docker://") ||
      ACTION_LINE.test(line)
      ? []
      : [line.trim()]
  })

/**
 * Rewrites every pinned action of a workflow to the commit and version in `latest`, which maps
 * `owner/repo` to the new pin; actions not in the map are left as they are.
 */
export const rewriteActionUses = (
  text: string,
  latest: ReadonlyMap<string, { readonly sha: string; readonly version: string }>,
): string =>
  text.replace(ACTION_USE, (line, head, repository, path, _sha, gap) => {
    const pin = latest.get(repository as string)
    return pin === undefined ? line : `${head}${repository}${path}@${pin.sha}${gap}${pin.version}`
  })

/** A tool entry of `mise.toml`'s `[tools]` table whose value is a plain string. */
export interface MiseTool {
  readonly name: string
  readonly version: string
}

const TOOLS_SECTION = /^\[tools\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m
const TOOL_ENTRY = /^([A-Za-z][\w:-]*)(\s*=\s*")([^"]*)(")/gm

/** The `[tools]` entries of a `mise.toml`, whatever their value (a channel such as `lts` too). */
export const parseMiseTools = (text: string): ReadonlyArray<MiseTool> =>
  [...(TOOLS_SECTION.exec(text)?.[1] ?? "").matchAll(TOOL_ENTRY)].map(
    ([, name = "", , version = ""]) => ({ name, version }),
  )

/** Sets the version of the named `[tools]` entries of a `mise.toml`; other entries stay as they are. */
export const rewriteMiseTools = (text: string, versions: ReadonlyMap<string, string>): string =>
  text.replace(TOOLS_SECTION, (section) =>
    section.replace(TOOL_ENTRY, (entry, name, middle, _version, end) => {
      const version = versions.get(name as string)
      return version === undefined ? entry : `${name}${middle}${version}${end}`
    }),
  )

/** The vendored tools whose pins live in the Claude integration's `vendor.ts`. */
export type VendoredTool = "ripgrep" | "fd"

/** The constant that holds each vendored tool's version. */
const VERSION_CONSTANT: Record<VendoredTool, string> = {
  ripgrep: "RIPGREP_VERSION",
  fd: "FD_VERSION",
}

/** The version of a vendored tool in the source of `vendor.ts`, or `undefined` when it is absent. */
export const parseVendoredVersion = (text: string, tool: VendoredTool): string | undefined =>
  new RegExp(String.raw`const ${VERSION_CONSTANT[tool]} = "([^"]+)"`).exec(text)?.[1]

/** The two SHA-256 hashes a pin holds for one archive. */
export interface Hashes {
  readonly archive: string
  readonly binary: string
}

/**
 * Moves a vendored tool in the source of `vendor.ts` to a new version: the version constant, the
 * version in the doc comment above it, and both hashes of each target (`hashes` is keyed by the
 * target id, such as `linux-x64`). Throws when the constant or a target's pin is missing, so a
 * layout the updater does not know fails loudly instead of leaving a half-moved pin.
 */
export const rewriteVendoredTool = (
  text: string,
  tool: VendoredTool,
  version: string,
  hashes: ReadonlyMap<string, Hashes>,
): string => {
  const constant = `const ${VERSION_CONSTANT[tool]} = "`
  const at = text.indexOf(constant)
  const old = parseVendoredVersion(text, tool)
  if (at < 0 || old === undefined) throw new Error(`vendor.ts has no ${VERSION_CONSTANT[tool]}`)
  const docStart = text.lastIndexOf("/**", at)
  let result = `${text.slice(0, docStart)}${text.slice(docStart, at).replaceAll(old, version)}${constant}${version}${text.slice(at + constant.length + old.length)}`
  for (const [target, { archive, binary }] of hashes) {
    const pin = new RegExp(
      String.raw`(\b${tool}\(\s*"${target}",\s*"[^"]+",\s*"[^"]+",\s*")[0-9a-f]{64}(",\s*")[0-9a-f]{64}(")`,
    )
    if (!pin.test(result)) throw new Error(`vendor.ts has no ${tool} pin for ${target}`)
    result = result.replace(pin, `$1${archive}$2${binary}$3`)
  }
  return result
}

/**
 * The release a Pi package pin moves to: `release`, unless the pin is already above it, which is
 * kept, because a registry whose `latest` tag points at an older line must not move an exact pin
 * down. A `release` that is not stable keeps `current`; a `current` that is not stable is
 * replaced.
 */
export const nextPiVersion = (current: string, release: string): string => {
  const from = parseRelease(current)
  const to = parseRelease(release)
  if (to === undefined) return current
  return from !== undefined && compareReleases(from, to) > 0 ? current : release
}

/**
 * The pin table of the Pi packages with their versions set from `versions`, by npm name, keeping
 * the key order; packages not in the map keep their version.
 */
export const withPiPackageVersions = (
  table: Readonly<Record<string, string>>,
  versions: ReadonlyMap<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(table).map(([name, version]) => [name, versions.get(name) ?? version]),
  )

/** The text of `pi-packages.json` for a pin table: two-space JSON and a final newline. */
export const renderPiPackages = (table: Readonly<Record<string, string>>): string =>
  `${JSON.stringify(table, null, 2)}\n`

/** The dependency fields of a `package.json` whose values are version ranges by package name. */
export const DEPENDENCY_FIELDS: ReadonlyArray<string> = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
]

/**
 * The packages Pi supplies to every extension and skill. Pi's package documentation (`packages.md`,
 * "Declare dependencies") has a package list them in `peerDependencies` with the range `*` and not
 * bundle them, so that range is the one exception to the caret-range rule, for these names in that
 * field only.
 */
export const PI_HOST_PACKAGES: ReadonlyArray<string> = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]

/** Whether a dependency is a Pi host package declared as Pi requires: a peer with the range `*`. */
export const isPiHostPeer = (field: string, name: string, range: unknown): boolean =>
  field === "peerDependencies" && range === "*" && PI_HOST_PACKAGES.includes(name)

/** A package dependency read from a manifest. */
export interface PackageDependency {
  readonly field: string
  readonly name: string
  readonly range: string
}

/**
 * The registry dependencies of a parsed `package.json`, field by field. Workspace references, other
 * protocols (`npm:`, `file:`, git), nested override tables and the Pi host peers (see
 * {@link isPiHostPeer}) are not registry ranges the updater can move, so they are left out.
 */
export const packageDependencies = (
  manifest: Readonly<Record<string, unknown>>,
): ReadonlyArray<PackageDependency> =>
  DEPENDENCY_FIELDS.flatMap((field) => {
    const table = manifest[field]
    if (table === null || typeof table !== "object" || Array.isArray(table)) return []
    return Object.entries(table).flatMap(([name, range]) =>
      typeof range === "string" && !range.includes(":") && !isPiHostPeer(field, name, range)
        ? [{ field, name, range }]
        : [],
    )
  })

/** Sets dependency ranges in a parsed `package.json` by field and name, keeping the key order. */
export const withPackageRanges = (
  manifest: Readonly<Record<string, unknown>>,
  ranges: ReadonlyArray<PackageDependency>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...manifest }
  for (const { field, name, range } of ranges)
    result[field] = { ...(result[field] as Record<string, unknown>), [name]: range }
  return result
}
