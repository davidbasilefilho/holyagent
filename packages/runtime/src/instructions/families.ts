import { join } from "node:path"

/**
 * The model families whose instruction sets are supported, each a folder of this directory that
 * mirrors `requirements/` file for file. The scaffold and the tests read this one list.
 *
 * `kimi-k3.1` has a `guide.md` and joins the list in the change that adds its translations: a
 * family folder may hold `guide.md` alone before it is listed, and the mirror and coverage tests
 * apply to listed families only.
 */
export const FAMILIES = ["claude-5.5"] as const

/** A supported model family: an entry of {@link FAMILIES}. */
export type Family = (typeof FAMILIES)[number]

/** The folder that holds the requirements and every family folder, as an absolute path. */
export const INSTRUCTIONS_ROOT = import.meta.dir

/** The folder of {@link INSTRUCTIONS_ROOT} that holds the requirements, which a family mirrors. */
export const REQUIREMENTS_FOLDER = "requirements"

/** The guide every family folder holds at its root; it is not mirrored by a requirements file. */
export const GUIDE_FILE = "guide.md"

/**
 * Whether a file of a family folder, as a path relative to it with `/` separators, has a file of
 * the same path in `requirements/`: every Markdown file except the guide. Anything else, such as
 * `root-core.ts`, is code or the guide and stays outside the mirror.
 */
export const isMirrored = (path: string): boolean => path.endsWith(".md") && path !== GUIDE_FILE

/** The absolute path of a family folder, or of `requirements/` for {@link REQUIREMENTS_FOLDER}. */
export const folderOf = (name: string, root: string = INSTRUCTIONS_ROOT): string => join(root, name)
