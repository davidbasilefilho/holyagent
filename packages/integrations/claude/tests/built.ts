import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build } from "../build.ts"
import { DIST_DIRECTORY, REPOSITORY } from "../src/files.ts"

/** The repository root. */
export const ROOT = REPOSITORY

/** The built plugin of the repository. */
export const PLUGIN = join(ROOT, DIST_DIRECTORY)

/** A repository root in a temporary folder holding a fresh build, made once for all tests. */
export const fresh: Promise<string> = mkdtemp(join(tmpdir(), "holyagent-build-")).then(
  async (root) => {
    await build(root)
    return root
  },
)

/** The built plugin inside a fresh build. */
export const freshPlugin: Promise<string> = fresh.then((root) => join(root, DIST_DIRECTORY))
