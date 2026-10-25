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
