import { join } from "node:path"

import { toPosix } from "../../../runtime/src/domain/paths.ts"
import {
  type GeneratedFile as BaseFile,
  generatedNote as noteFor,
  jsonText,
} from "../../../runtime/src/instructions/generated.ts"
import {
  instructionsDirectory,
  noteInFrontmatter as noteInMarkdown,
} from "../../../runtime/src/instructions/skills.ts"

/** The plugin's folder, relative to the repository root. */
export const PLUGIN_DIRECTORY = "packages/integrations/claude"

/** The built plugin that Claude Code loads, relative to the repository root. */
export const DIST_DIRECTORY = `${PLUGIN_DIRECTORY}/dist`

/**
 * The bundled ripgrep and fd with their licenses, relative to the repository root. Unlike the rest
 * of the built plugin, `build.ts` leaves it in place: `scripts/vendor.ts` fills it from the pinned
 * release archives, so a build needs no network.
 */
export const VENDOR_DIRECTORY = `${DIST_DIRECTORY}/scripts/vendor`

/** The instruction sources the plugin is built from, relative to the repository root. */
export const INSTRUCTIONS_DIRECTORY = instructionsDirectory("claude-5.5")

/** The repository root. */
export const REPOSITORY = join(import.meta.dir, "../../../..")

export { jsonText }

/** One generated file: its path relative to the repository root and its content. */
export interface GeneratedFile extends BaseFile {
  /** True for a file the plugin runs, which is written executable. */
  readonly executable?: true
}

/** Reads a file of the repository as text. */
export const readSource = (path: string): Promise<string> => Bun.file(join(REPOSITORY, path)).text()

/** The files below a folder of the repository, as paths relative to it, in a stable order. */
export const listFiles = async (directory: string): Promise<ReadonlyArray<string>> =>
  (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(REPOSITORY, directory) })))
    .map((path) => toPosix(path))
    .toSorted()

/** The note a generated file carries, where its format allows one. */
export const generatedNote = (source: string): string =>
  noteFor(`${PLUGIN_DIRECTORY}/build.ts`, source)

/** Puts the note of a generated file into Markdown that starts with frontmatter. */
export const noteInFrontmatter = (text: string, source: string): string =>
  noteInMarkdown(text, generatedNote(source))
