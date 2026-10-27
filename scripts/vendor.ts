import { rm } from "node:fs/promises"
import { join } from "node:path"

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

const directory = join(REPOSITORY, VENDOR_DIRECTORY)

const download = async (asset: Asset): Promise<Uint8Array> => {
  const response = await fetch(asset.url)
  if (!response.ok) throw new Error(`${asset.url} answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
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
  for await (const file of new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true }))
    if (!expected.has(file)) await rm(join(directory, file))
  const problems = await vendorProblems(directory)
  if (problems.length > 0) throw new Error(`${VENDOR_DIRECTORY}: ${problems.join("; ")}`)
  console.log(`vendored ${expected.size} files in ${VENDOR_DIRECTORY}`)
}
