import { join } from "node:path"

import {
  type GeneratedFile as BaseFile,
  generatedNote as noteFor,
} from "../../../runtime/src/instructions/generated.ts"

/** One generated file: its path relative to the repository root and its content. */
export interface GeneratedFile extends BaseFile {
  /** True for a file the package runs, which is written executable. */
  readonly executable?: true
}

/** The package's folder, relative to the repository root. */
export const PACKAGE_DIRECTORY = "packages/integrations/pi"

/** The built Pi package that Pi loads, relative to the repository root. */
export const DIST_DIRECTORY = `${PACKAGE_DIRECTORY}/dist`

/** The generator and the extension source, relative to the repository root. */
export const SOURCES = `${PACKAGE_DIRECTORY}/src`

/** The repository root. */
export const REPOSITORY = join(import.meta.dir, "../../../..")

/** The note a generated file carries, where its format allows one. */
export const generatedNote = (source: string): string =>
  noteFor(`${PACKAGE_DIRECTORY}/build.ts`, source)
