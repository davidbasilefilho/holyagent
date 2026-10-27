import { chmod, readdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

import { VENDOR_DIRECTORY } from "./src/files.ts"
import { generate, GENERATED_PATHS } from "./src/generate.ts"

/**
 * Removes a path of the repository and everything below it except the folders in `keep`, which are
 * relative to the repository root.
 */
const clear = async (root: string, path: string, keep: ReadonlyArray<string>): Promise<void> => {
  if (keep.includes(path)) return
  if (!keep.some((kept) => kept.startsWith(`${path}/`)))
    return rm(join(root, path), { recursive: true, force: true })
  const entries = await readdir(join(root, path)).catch(() => [])
  for (const entry of entries) await clear(root, `${path}/${entry}`, keep)
}

/**
 * Writes the plugin below a repository root: first removes every generated path, so a source that
 * was deleted leaves no file behind, then writes the generated files. Nothing else is touched, and
 * the bundled tools stay where they are: `scripts/vendor.ts` owns them.
 */
export const build = async (root: string): Promise<ReadonlyArray<string>> => {
  const files = await generate()
  for (const path of GENERATED_PATHS) await clear(root, path, [VENDOR_DIRECTORY])
  for (const file of files) {
    const target = join(root, file.path)
    await Bun.write(target, file.content, { createPath: true })
    if (file.executable) await chmod(target, 0o755)
  }
  return files.map((file) => file.path)
}

if (import.meta.main) {
  const root = join(dirname(import.meta.path), "../../..")
  const written = await build(root)
  console.log(`built ${written.length} files into ${root}`)
}
