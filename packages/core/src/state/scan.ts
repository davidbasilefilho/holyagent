import { readdir } from "node:fs/promises"
import { join } from "node:path"

/** Lists regular files below a directory, without following symlink directories. */
export const scanFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const visit = async (prefix: string): Promise<ReadonlyArray<string>> => {
    const entries = await readdir(join(directory, prefix), { withFileTypes: true })
    const rows = await Promise.all(
      entries.map(async (entry) => {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`
        return entry.isDirectory() ? visit(path) : entry.isFile() ? [path] : []
      }),
    )
    return rows.flat()
  }
  return (await visit("")).toSorted()
}

/** Matches the simple slash-separated file patterns used by the state store. */
export const matchesPattern = (path: string, pattern: string): boolean => {
  const quote = (part: string) =>
    part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", "[^/]*")
  return new RegExp(`^${pattern.split("/").map(quote).join("/")}$`).test(path)
}

/** Lists files matching the state store's shallow slash-separated patterns. */
export const scanMatching = async (
  directory: string,
  pattern: string,
): Promise<ReadonlyArray<string>> => {
  const parts = pattern.split("/")
  const visit = async (prefix: string, index: number): Promise<ReadonlyArray<string>> => {
    const segment = parts[index]
    if (segment === undefined) return []
    const entries = await readdir(join(directory, prefix), { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return []
        throw error
      },
    )
    const rows = await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith(".") && !segment.startsWith(".")) return []
        if (!matchesPattern(entry.name, segment)) return []
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`
        if (index === parts.length - 1) return entry.isFile() ? [path] : []
        return entry.isDirectory() ? visit(path, index + 1) : []
      }),
    )
    return rows.flat()
  }
  return (await visit("", 0)).toSorted()
}
