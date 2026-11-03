import { stat } from "node:fs/promises"
import { dirname, posix, win32 } from "node:path"

import { $ } from "bun"

import { pathKey } from "../../../runtime/src/setup/shell.ts"
import { ROOT } from "./built.ts"

/** The environment variables a child process is given. */
export type ChildEnv = Record<string, string>

/**
 * The search path of a child process: the folders in `first`, then the folders the child needs to
 * find the system's programs, joined with the platform's list delimiter (`;` on Windows, where a
 * `:` would split nothing and read as part of a drive letter). POSIX hosts get `/usr/bin:/bin`;
 * Windows has no such folders, and Git for Windows, which the hooks and the wrapper need, is found
 * through the search path of the process that runs the tests, `parent`. The platform and the parent
 * are parameters so a test can stand in for Windows.
 */
export const searchPath = (
  first: ReadonlyArray<string>,
  platform: string = process.platform,
  parent: string = process.env[pathKey(process.env)] ?? "",
): string => {
  const windows = platform === "win32"
  return [...first, ...(windows ? [parent] : ["/usr/bin", "/bin"])]
    .filter((folder) => folder !== "")
    .join(windows ? win32.delimiter : posix.delimiter)
}

/**
 * The search path of a child as an environment entry, under the name `base` already spells it
 * (Windows keeps `Path`, and a second `PATH` beside it would leave two entries for one variable).
 */
export const pathEnv = (
  first: ReadonlyArray<string>,
  base: Readonly<Record<string, string | undefined>> = {},
  platform: string = process.platform,
): ChildEnv => ({
  [pathKey(base, platform === "win32")]: searchPath(first, platform),
})

/** The folder of the Bun that runs the tests. */
export const BUN_FOLDER = dirname(process.execPath)

/**
 * The variables a Windows child needs to start at all. A program of Git for Windows (`sh`, `git`)
 * given an environment without `SystemRoot` fails before its first line; elsewhere nothing is
 * added.
 */
export const systemEnv = (platform: string = process.platform): ChildEnv =>
  platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}

/**
 * The POSIX shell that runs the wrapper: `/bin/sh`, or on Windows the `sh` of Git for Windows,
 * found on the search path or beside the `git` that is. Throws when Windows has none, since the
 * wrapper cannot run there without it.
 */
export const posixShell = (platform: string = process.platform): string => {
  if (platform !== "win32") return "/bin/sh"
  const found = Bun.which("sh")
  if (found !== null) return found
  const git = Bun.which("git")
  const beside =
    git === null
      ? []
      : [".", "..\\bin", "..\\usr\\bin"].map((at) => win32.join(dirname(git), at, "sh.exe"))
  const shell = beside.find((candidate) => Bun.file(candidate).size > 0)
  if (shell === undefined) throw new Error("no POSIX shell: install Git for Windows")
  return shell
}

/**
 * The mode git has in its index for a file of the repository, such as `100755`; undefined when
 * untracked.
 */
const indexMode = async (path: string): Promise<string | undefined> => {
  const listed = await $`git ls-files -s -- ${path}`.cwd(ROOT).quiet().nothrow()
  return listed.stdout.toString().split(" ")[0] || undefined
}

/**
 * True when the file of the repository can be run. Where the file system keeps mode bits that is
 * its execute bit; Windows keeps none (every file reads as non-executable), so the mode the
 * repository commits for the file, which is what a checkout on POSIX gives it, stands in. The
 * platform is a parameter so a test can stand in for Windows.
 */
export const isExecutable = async (
  path: string,
  platform: string = process.platform,
): Promise<boolean> =>
  platform === "win32"
    ? (await indexMode(path)) === "100755"
    : ((await stat(path)).mode & 0o111) !== 0
