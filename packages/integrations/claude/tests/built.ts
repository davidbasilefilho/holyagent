import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build } from "../build.ts"
import { PLUGIN_DIRECTORY, REPOSITORY } from "../src/files.ts"

/** The repository root. */
export const ROOT = REPOSITORY

/** The plugin folder of the repository. */
export const PLUGIN = join(ROOT, PLUGIN_DIRECTORY)

/** A repository root in a temporary folder holding a fresh build, made once for all tests. */
export const fresh: Promise<string> = mkdtemp(join(tmpdir(), "holyagent-build-")).then(
  async (root) => {
    await build(root)
    return root
  },
)

/** The plugin folder inside a fresh build. */
export const freshPlugin: Promise<string> = fresh.then((root) => join(root, PLUGIN_DIRECTORY))
