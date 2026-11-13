import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build } from "../build.ts"
import { DIST_DIRECTORY, REPOSITORY } from "../src/files.ts"

/** Reads a scalar from generated YAML frontmatter, including quoted strings. */
export const field = (text: string, key: string): string | undefined => {
  const header = text.split("\n---\n")[0]
  if (!header) return undefined
  const parsed = Bun.YAML.parse(header)
  if (typeof parsed !== "object" || parsed === null || !(key in parsed)) return undefined
  const value = (parsed as Record<string, unknown>)[key]
  return typeof value === "string" || typeof value === "boolean" ? String(value) : undefined
}

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
