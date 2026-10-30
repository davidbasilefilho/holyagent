import { rm } from "node:fs/promises"
import { join, sep } from "node:path"

import { REPOSITORY, VENDOR_DIRECTORY } from "../packages/integrations/claude/src/files.ts"
import {
  type Asset,
  ASSETS,
  binaryOf,
  expectedFiles,
  installAsset,
  licensesOf,
  vendorProblems,
} from "../packages/integrations/claude/src/vendor.ts"
import { toPosix } from "../packages/runtime/src/domain/paths.ts"

const directory = join(REPOSITORY, VENDOR_DIRECTORY)

const download = async (asset: Asset): Promise<Uint8Array> => {
  const response = await fetch(asset.url)
  if (!response.ok) throw new Error(`${asset.url} answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
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
  for (const asset of ASSETS) {
    const files = [binaryOf(asset), ...licensesOf(asset)]
    if (!before.some((problem) => files.some((file) => problem.startsWith(`${file} `)))) continue
    console.log(`fetching ${asset.url}`)
    await installAsset(directory, asset, await download(asset))
  }
  const expected = new Set(expectedFiles())
  await removeUnpinned(directory, expected)
  const problems = await vendorProblems(directory)
  if (problems.length > 0) throw new Error(`${VENDOR_DIRECTORY}: ${problems.join("; ")}`)
  console.log(`vendored ${expected.size} files in ${VENDOR_DIRECTORY}`)
}
