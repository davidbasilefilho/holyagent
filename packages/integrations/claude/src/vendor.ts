import { chmod } from "node:fs/promises"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"

import { type Target, TARGETS, type Tool } from "../../../runtime/src/cli/tools.ts"
import { listFiles } from "./files.ts"

/** The format of a release archive. */
export type ArchiveFormat = "tar.gz" | "zip"

/** One release archive of a bundled tool, pinned by its SHA-256 and the SHA-256 of its program. */
export interface Asset {
  readonly tool: Tool
  /** The folder name of the tool's licenses below `licenses/` in the target's folder. */
  readonly project: string
  readonly target: Target
  readonly url: string
  readonly format: ArchiveFormat
  /** The SHA-256 of the archive, checked before anything is read from it. */
  readonly archiveSha256: string
  /** The SHA-256 of the program inside, checked after extraction and by the tests. */
  readonly binarySha256: string
  /** The folder every file of the archive sits in. */
  readonly folder: string
  /** The license files of the archive, shipped beside the program. */
  readonly licenses: ReadonlyArray<string>
}

/**
 * Ripgrep 15.2.0, from https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0. The archive
 * hashes are the ones the release publishes in its `.sha256` files; the program hashes were taken
 * from the extracted files.
 */
const RIPGREP_VERSION = "15.2.0"

/**
 * Fd 10.5.0, from https://github.com/sharkdp/fd/releases/tag/v10.5.0. The release publishes no
 * checksum file, so the archive hashes were taken from the downloaded files and are trusted on
 * first use; a changed archive fails the build.
 */
const FD_VERSION = "10.5.0"

const target = (id: string): Target => {
  const found = TARGETS.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`Unknown target ${id}`)
  return found
}

const ripgrep = (
  id: string,
  triple: string,
  format: ArchiveFormat,
  archiveSha256: string,
  binarySha256: string,
): Asset => {
  const folder = `ripgrep-${RIPGREP_VERSION}-${triple}`
  return {
    tool: "rg",
    project: "ripgrep",
    target: target(id),
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${folder}.${format}`,
    format,
    archiveSha256,
    binarySha256,
    folder,
    licenses: ["LICENSE-MIT", "UNLICENSE", "COPYING"],
  }
}

const fd = (
  id: string,
  triple: string,
  format: ArchiveFormat,
  archiveSha256: string,
  binarySha256: string,
): Asset => {
  const folder = `fd-v${FD_VERSION}-${triple}`
  return {
    tool: "fd",
    project: "fd",
    target: target(id),
    url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${folder}.${format}`,
    format,
    archiveSha256,
    binarySha256,
    folder,
    licenses: ["LICENSE-MIT", "LICENSE-APACHE"],
  }
}

/** Every pinned archive: each tool for each target. */
export const ASSETS: ReadonlyArray<Asset> = [
  ripgrep(
    "darwin-arm64",
    "aarch64-apple-darwin",
    "tar.gz",
    "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
    "a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e",
  ),
  ripgrep(
    "linux-x64",
    "x86_64-unknown-linux-musl",
    "tar.gz",
    "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
    "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
  ),
  ripgrep(
    "windows-x64",
    "x86_64-pc-windows-msvc",
    "zip",
    "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
    "14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680",
  ),
  fd(
    "darwin-arm64",
    "aarch64-apple-darwin",
    "tar.gz",
    "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12",
    "cf3bde435da174f41cf9589a2efeaf03804df7c250fc15e8b8a1e9bfc66ebc9a",
  ),
  fd(
    "linux-x64",
    "x86_64-unknown-linux-musl",
    "tar.gz",
    "761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7",
    "e79642a479d2816c887047476bbe6ad229465f30de031033574dee2a095e0037",
  ),
  fd(
    "windows-x64",
    "x86_64-pc-windows-msvc",
    "zip",
    "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
    "d67d27a8e375ed7e9bca2b506a9dd5082bc24547aeba908b863f6f8b8ab0c3b9",
  ),
]

/** The SHA-256 of some bytes as lowercase hex. */
export const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

/** The program of an asset, relative to the vendor folder. */
export const binaryOf = (asset: Asset): string =>
  `${asset.target.id}/${asset.tool}${asset.target.suffix}`

/** The license files of an asset, relative to the vendor folder. */
export const licensesOf = (asset: Asset): ReadonlyArray<string> =>
  asset.licenses.map((file) => `${asset.target.id}/licenses/${asset.project}/${file}`)

/** Every file the vendor folder holds, relative to it: the programs and their licenses. */
export const expectedFiles = (): ReadonlyArray<string> =>
  ASSETS.flatMap((asset) => [binaryOf(asset), ...licensesOf(asset)]).toSorted()

/**
 * What is wrong with a vendor folder: a missing program, a program whose SHA-256 differs from the
 * pin, a missing license and a file nobody pinned. Empty when the folder is as the pins say.
 */
export const vendorProblems = async (directory: string): Promise<ReadonlyArray<string>> => {
  const problems: Array<string> = []
  for (const asset of ASSETS) {
    const program = Bun.file(join(directory, binaryOf(asset)))
    if (!(await program.exists())) problems.push(`${binaryOf(asset)} is missing`)
    else if (sha256(await program.bytes()) !== asset.binarySha256)
      problems.push(`${binaryOf(asset)} does not match its pinned SHA-256`)
    for (const license of licensesOf(asset))
      if (!(await Bun.file(join(directory, license)).exists()))
        problems.push(`${license} is missing`)
  }
  const expected = new Set(expectedFiles())
  const present = await listFiles(directory).catch(() => [])
  for (const file of present) if (!expected.has(file)) problems.push(`${file} is not pinned`)
  return problems
}

const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50

/**
 * The named files of a zip archive, by name. Reads the central directory, which supports the stored
 * and deflated entries that release archives use; a name the archive lacks is absent from the
 * result.
 */
export const readZip = (
  bytes: Uint8Array,
  names: ReadonlyArray<string>,
): ReadonlyMap<string, Uint8Array> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  while (end >= 0 && view.getUint32(end, true) !== END_OF_DIRECTORY) end -= 1
  if (end < 0) throw new Error("The archive is not a zip file: it has no end-of-directory record")
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const found = new Map<string, Uint8Array>()
  for (let entry = 0; entry < count; entry += 1) {
    if (view.getUint32(at, true) !== DIRECTORY_ENTRY)
      throw new Error("The zip central directory is damaged")
    const method = view.getUint16(at + 10, true)
    const size = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (!names.includes(name)) continue
    if (view.getUint32(local, true) !== LOCAL_HEADER)
      throw new Error(`The zip entry ${name} has no local header`)
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = bytes.subarray(start, start + size)
    if (method !== 0 && method !== 8)
      throw new Error(`The zip entry ${name} uses compression method ${method}`)
    found.set(name, method === 0 ? data : inflateRawSync(data))
  }
  return found
}

const readTar = async (
  bytes: Uint8Array,
  names: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Uint8Array>> => {
  const files = await new Bun.Archive(bytes).files()
  const found = new Map<string, Uint8Array>()
  for (const name of names) {
    const file = files.get(name)
    if (file !== undefined) found.set(name, await file.bytes())
  }
  return found
}

/**
 * Checks a downloaded archive against the pin and writes its program and licenses below the vendor
 * folder; the program is made executable. Throws when the hash differs or a file is missing from
 * the archive, and writes nothing then.
 */
export const installAsset = async (
  directory: string,
  asset: Asset,
  archive: Uint8Array,
): Promise<void> => {
  const actual = sha256(archive)
  if (actual !== asset.archiveSha256)
    throw new Error(
      `${asset.url} has SHA-256 ${actual}, but ${asset.archiveSha256} is pinned: the archive changed or the download is damaged`,
    )
  const program = `${asset.folder}/${asset.tool}${asset.target.suffix}`
  const wanted = [program, ...asset.licenses.map((file) => `${asset.folder}/${file}`)]
  const files = asset.format === "zip" ? readZip(archive, wanted) : await readTar(archive, wanted)
  for (const name of wanted) if (!files.has(name)) throw new Error(`${asset.url} has no ${name}`)
  const binary = files.get(program)
  if (binary === undefined || sha256(binary) !== asset.binarySha256)
    throw new Error(`${program} in ${asset.url} does not match its pinned SHA-256`)
  for (const name of wanted) {
    const relative =
      name === program
        ? binaryOf(asset)
        : `${asset.target.id}/licenses/${asset.project}/${name.slice(asset.folder.length + 1)}`
    await Bun.write(join(directory, relative), files.get(name) ?? new Uint8Array(), {
      createPath: true,
    })
  }
  await chmod(join(directory, binaryOf(asset)), 0o755)
}
