import { posix } from "node:path"

import { Effect } from "effect"
import type { FsStat, IFileSystem } from "just-bash"

/** The one device file the shell has. */
export const NULL_DEVICE = "/dev/null"

const NULL_STAT: FsStat = {
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
  mode: 0o666,
  size: 0,
  mtime: new Date(0),
}

// What each file system call gives for the device: writes vanish, reads are empty.
const NULL_CALLS: Readonly<Record<string, () => unknown>> = {
  writeFile: () => undefined,
  appendFile: () => undefined,
  readFile: () => "",
  readFileBytes: () => "",
  readFileBuffer: () => new Uint8Array(0),
  exists: () => true,
  stat: () => NULL_STAT,
  lstat: () => NULL_STAT,
}

/**
 * The file system with {@link NULL_DEVICE} made a real null device. just-bash writes a redirect to
 * `/dev/null` (`>/dev/null`, `&>/dev/null`) as a file, which the disk refuses as a special file and
 * which an in-memory `/dev` would keep; so every call on that path is answered here instead: a
 * write is dropped, a read is empty, and it exists as an empty file. Other paths pass through.
 */
export const withNullDevice = (fs: IFileSystem): IFileSystem =>
  new Proxy(fs, {
    get: (target, name) => {
      const member: unknown = Reflect.get(target, name, target)
      const answer = typeof name === "string" ? NULL_CALLS[name] : undefined
      if (typeof member !== "function" || answer === undefined) return member
      return (...args: Array<unknown>): unknown => {
        if (typeof args[0] === "string" && posix.normalize(args[0]) === NULL_DEVICE)
          return Effect.runPromise(Effect.sync(answer))
        const result: unknown = Reflect.apply(member, target, args)
        return result
      }
    },
  })
