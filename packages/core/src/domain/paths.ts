import { sep } from "node:path"

import { Schema } from "effect"

const UNSAFE_CHARACTERS = /[\\:*?"<>|\p{Cc}]/u

/**
 * Why a path is not a relative, portable project path, or undefined when it is one: `/`-separated,
 * not absolute, with no empty, `.` or `..` segment, no trailing dot or space in a segment and none
 * of `\ : * ? " < > |` or control characters, which some file system rejects.
 */
export const pathProblem = (path: string): string | undefined => {
  if (path.startsWith("/")) return "absolute path"
  if (UNSAFE_CHARACTERS.test(path)) return "character that is not portable"
  for (const segment of path.split("/")) {
    if (segment === "") return "empty segment"
    if (segment === "." || segment === "..") return `"${segment}" segment`
    if (segment.endsWith(".") || segment.endsWith(" ")) return "trailing dot or space"
  }
  return undefined
}

/** A relative, portable project path (see {@link pathProblem}). */
export const PortablePath = Schema.String.check(
  Schema.makeFilter((path: string) => pathProblem(path) ?? undefined),
)

/** Two paths overlap when they are equal ignoring case or one is a directory prefix of the other. */
export const pathsOverlap = (a: string, b: string): boolean => {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** The first path of the first list that overlaps a path of the second, if any. */
export const firstOverlap = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): string | undefined => a.find((left) => b.some((right) => pathsOverlap(left, right)))

/**
 * A path with the platform's separator written as `/`, the form git, globs and the portable paths
 * of the records use. On Windows (`\`) a `relative()` or `join()` result becomes `a/b`; on POSIX
 * the separator already is `/` and the path comes back unchanged. The separator is a parameter so a
 * test can stand in for Windows.
 */
export const toPosix = (path: string, separator: string = sep): string =>
  separator === "/" ? path : path.replaceAll(separator, "/")

/**
 * A path git printed (`C:/repo/.git`, always `/`-separated) in the platform's own form, so it
 * compares with what `join()` and `realpath()` return. On POSIX it comes back unchanged. The
 * separator is a parameter so a test can stand in for Windows.
 */
export const fromGitPath = (path: string, separator: string = sep): string =>
  separator === "/" ? path : path.replaceAll("/", separator)
