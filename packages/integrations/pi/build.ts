import { chmod, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { syncVersions } from "../../../scripts/bump-version.ts"

/**
 * Writes the Pi package below a repository root: first removes every generated path, so a source
 * that was deleted leaves no file behind, then writes the generated files. Nothing else is
 * touched.
 */
export const build = async (root: string): Promise<ReadonlyArray<string>> => {
  // Imported here, not at the top: `generate.ts` reads the version from this package's package.json
  // when it loads, so it must load after the sync in `main` has rewritten that file.
  const { generate, GENERATED_PATHS } = await import("./src/generate.ts")
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
  // The root package.json holds the one version; copy it to the other files before they are read.
  const failure = await Effect.runPromise(
    syncVersions(root).pipe(
      Effect.as(undefined),
      Effect.catch((error) => Effect.succeed(error)),
    ),
  )
  if (failure !== undefined) {
    console.error(`error: ${failure._tag}: ${failure.message}`)
    process.exitCode = 1
  } else {
    const written = await build(root)
    console.log(`built ${written.length} Pi package files into ${root}`)
  }
}
