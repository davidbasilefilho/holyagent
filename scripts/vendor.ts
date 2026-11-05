import { rm } from "node:fs/promises"
import { join, sep } from "node:path"

import { REPOSITORY, VENDOR_DIRECTORY } from "../packages/integrations/claude/src/files.ts"
import {
  ASSETS,
  binaryOf,
  expectedFiles,
  installAsset,
  licensesOf,
  MAX_ARCHIVE_BYTES,
  vendorProblems,
} from "../packages/integrations/claude/src/vendor.ts"
import { toPosix } from "../packages/runtime/src/domain/paths.ts"

const directory = join(REPOSITORY, VENDOR_DIRECTORY)

/** How long a download may take, from the request to the last byte. */
export const DOWNLOAD_TIMEOUT_MS = 60_000

/**
 * The bytes at a URL; rejects when the server answers anything but success, takes longer than
 * `timeoutMs` or sends more than `limit` bytes (a declared length above it is refused before any
 * byte is read, and the body is cut off at the limit when it carries more than it declared).
 */
export const download = async (
  url: string,
  limit: number = MAX_ARCHIVE_BYTES,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS,
): Promise<Uint8Array> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const declared = Number(response.headers.get("content-length"))
  if (declared > limit) throw new Error(`${url} is ${declared} bytes, above the ${limit} allowed`)
  const chunks: Array<Uint8Array> = []
  let total = 0
  for await (const chunk of response.body ?? []) {
    total += chunk.length
    if (total > limit) throw new Error(`${url} sent more than the ${limit} bytes allowed`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * The files that no pin names. The pins use `/`, while a folder scan yields paths with the
 * platform's separator, so each path is converted before the comparison; the separator is a
 * parameter so a test can stand in for Windows.
 */
export const unpinnedFiles = (
  files: Iterable<string>,
  expected: ReadonlySet<string>,
  separator: string = sep,
): ReadonlyArray<string> =>
  Array.from(files).filter((file) => !expected.has(toPosix(file, separator)))

/** Removes every file below a folder that no pin names, and returns the paths it removed. */
export const removeUnpinned = async (
  folder: string,
  expected: ReadonlySet<string>,
): Promise<ReadonlyArray<string>> => {
  const stray = unpinnedFiles(
    await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: folder, onlyFiles: true })),
    expected,
  )
  for (const file of stray) await rm(join(folder, file))
  return stray
}

if (import.meta.main) {
  // Downloads, verifies and extracts what the vendor folder lacks or holds wrongly, then removes
  // what no pin names. With everything in place it does nothing, so a build needs no network.
  const before = await vendorProblems(directory)
  const missing = ASSETS.filter((asset) => {
    const files = [binaryOf(asset), ...licensesOf(asset)]
    return before.some((problem) => files.some((file) => problem.startsWith(`${file} `)))
  })
  const archives = await Promise.all(
    missing.map((asset) => {
      console.log(`fetching ${asset.url}`)
      return download(asset.url)
    }),
  )
  for (const [index, asset] of missing.entries())
    await installAsset(directory, asset, archives[index] as Uint8Array)
  const expected = new Set(expectedFiles())
  await removeUnpinned(directory, expected)
  const problems = await vendorProblems(directory)
  if (problems.length > 0) throw new Error(`${VENDOR_DIRECTORY}: ${problems.join("; ")}`)
  console.log(`vendored ${expected.size} files in ${VENDOR_DIRECTORY}`)
}
