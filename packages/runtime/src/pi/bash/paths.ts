/**
 * Just-bash's file system is POSIX: paths start at `/` and have no drive letters. On Windows each
 * existing drive is mounted at `/<letter>` (`C:\proj` is `/c/proj`), and these functions map a path
 * between the host's spelling and the shell's. On any other system both are the identity, so a path
 * is the same on both sides.
 */

const DRIVE_PATH = /^([A-Za-z]):(?:[\\/]+(.*))?$/
const VIRTUAL_DRIVE = /^\/([a-z])(?:\/(.*))?$/

/** The shell's path for a host path: `C:\proj\x` is `/c/proj/x` on Windows, unchanged elsewhere. */
export const toVirtualPath = (
  hostPath: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform !== "win32") return hostPath
  const drive = DRIVE_PATH.exec(hostPath)
  if (drive === null) return hostPath.replaceAll("\\", "/")
  const rest = (drive[2] ?? "").replaceAll("\\", "/")
  return `/${(drive[1] ?? "").toLowerCase()}${rest === "" ? "" : `/${rest}`}`
}

/**
 * The host's path for a shell path: `/c/proj/x` is `C:\proj\x` on Windows when `drives` holds `c`
 * (the mounted drive letters, lowercase); any other path, such as the shell's own `/usr/bin`, and
 * every path on another system, is returned unchanged.
 */
export const toHostPath = (
  virtualPath: string,
  drives: ReadonlySet<string>,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform !== "win32") return virtualPath
  const drive = VIRTUAL_DRIVE.exec(virtualPath)
  const letter = drive?.[1]
  if (letter === undefined || !drives.has(letter)) return virtualPath
  return `${letter.toUpperCase()}:\\${(drive?.[2] ?? "").replaceAll("/", "\\")}`
}

/**
 * An argument for a host program: one that names a file below a mounted drive (`/c/proj/x`) becomes
 * the host's path, since the program knows no mounts. Other arguments pass unchanged, a bare `/c`
 * among them, which is as likely a switch (`cmd /c`) as a drive.
 */
export const toHostArgument = (
  argument: string,
  drives: ReadonlySet<string>,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform !== "win32") return argument
  const drive = VIRTUAL_DRIVE.exec(argument)
  return drive?.[2] === undefined || drive[2] === ""
    ? argument
    : toHostPath(argument, drives, platform)
}

/** The drive roots of Windows, `A:\` to `Z:\`, in order. */
export const DRIVE_ROOTS: ReadonlyArray<string> = Array.from(
  { length: 26 },
  (_, index) => `${String.fromCharCode(65 + index)}:\\`,
)
