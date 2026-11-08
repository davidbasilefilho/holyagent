import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

import { Data, Effect } from "effect"

import { toPosix } from "../domain/paths.ts"

/** A folder of instruction files could not be read or written. */
export class InstructionsError extends Data.TaggedError("InstructionsError")<{
  readonly path: string
  readonly cause: unknown
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.path}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

/** The shape of a requirement id: `R-` and one or more dash-separated upper-case words. */
export const REQUIREMENT_ID = /^R-[A-Z]+(?:-[A-Z]+)*$/

/** The ids a requirements file defines, in order, and the ids it only refers to. */
export interface ParsedRequirements {
  readonly ids: ReadonlyArray<string>
  readonly references: ReadonlyArray<string>
}

const DEFINITION = /^- (R-[A-Z]+(?:-[A-Z]+)*): \S/
const REFERENCE = /^- See: (.+)$/

/**
 * Reads a requirements file. A line `- R-ID: text` defines a requirement, and a line `- See: R-A,
 * R-B` refers to requirements that another file defines, because they govern this file's
 * instructions too. Any other line is prose and is not read.
 */
export const parseRequirements = (text: string): ParsedRequirements => {
  const lines = text.split(/\r?\n/)
  return {
    ids: lines.flatMap((line) => DEFINITION.exec(line)?.[1] ?? []),
    references: lines.flatMap((line) =>
      (REFERENCE.exec(line)?.[1] ?? "").split(",").flatMap((id) => id.trim() || []),
    ),
  }
}

/** The folders and the files below a folder, as `/`-separated paths relative to it, sorted. */
export interface Tree {
  readonly directories: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
}

/**
 * Lists everything below `directory`; fails with InstructionsError when it cannot be read. With
 * `plain`, dotfiles and symbolic links are left out, with everything below them, so a tree that
 * ships as it is carries no hidden or linked file.
 */
export const listTree = (
  directory: string,
  options: { readonly plain?: boolean } = {},
): Effect.Effect<Tree, InstructionsError> =>
  Effect.tryPromise({
    try: () => readdir(directory, { recursive: true, withFileTypes: true }),
    catch: (cause) => new InstructionsError({ path: directory, cause }),
  }).pipe(
    Effect.map((entries) => {
      const listed = entries.map((entry) => ({
        entry,
        path: toPosix(relative(directory, join(entry.parentPath, entry.name))),
      }))
      const skipped = options.plain
        ? listed.filter(({ entry }) => entry.name.startsWith(".") || entry.isSymbolicLink())
        : []
      const kept = listed.filter(
        ({ path }) =>
          !skipped.some((hidden) => path === hidden.path || path.startsWith(`${hidden.path}/`)),
      )
      const paths = (directories: boolean) =>
        kept
          .filter(({ entry }) => entry.isDirectory() === directories)
          .map(({ path }) => path)
          .toSorted()
      return { directories: paths(true), files: paths(false) }
    }),
  )
