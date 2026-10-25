import { chmod, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

import { generate, GENERATED_PATHS } from "./src/generate.ts"

/**
 * Writes the plugin below a repository root: first removes every generated path, so a source that
 * was deleted leaves no file behind, then writes the generated files. Nothing else is touched.
 */
export const build = async (root: string): Promise<ReadonlyArray<string>> => {
  const files = await generate()
  for (const path of GENERATED_PATHS) await rm(join(root, path), { recursive: true, force: true })
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
