import { posix } from "node:path"

import { Data, Effect } from "effect"
import type { FsStat, IFileSystem } from "just-bash"

/** The one device file the shell has. */
export const NULL_DEVICE = "/dev/null"

/** A file system call that the null device refuses, as the disk would refuse it (`EPERM`, ...). */
export class NullDeviceRefused extends Data.TaggedError("NullDeviceRefused")<{
  readonly message: string
}> {}

const NULL_STAT: FsStat = {
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
  mode: 0o666,
  size: 0,
  mtime: new Date(0),
  // Lets `cp` and `mv` tell the device from another file, which they cannot do without an identity.
  identity: "holyagent:null-device",
}

// Whether `path` names the device, however it is spelled (`/dev//null`, `/dev/../dev/null/`).
const isDevice = (path: unknown): path is string =>
  typeof path === "string" && posix.normalize(path).replace(/\/+$/, "") === NULL_DEVICE

const answer = (value: unknown): Promise<unknown> => Effect.runPromise(Effect.succeed(value))

const refuse = (code: string, reason: string, call: string, path: string): Promise<unknown> =>
  Effect.runPromise(
    Effect.fail(new NullDeviceRefused({ message: `${code}: ${reason}, ${call} '${path}'` })),
  )

const denied = (call: string, path: string) =>
  refuse("EPERM", "operation not permitted", call, path)

// What each call that names the device alone gives: writes vanish, reads are empty, and the device
// stays what it is (it cannot be removed, made again, listed or read as a link).
const ON_PATH: ReadonlyMap<string, (path: string) => Promise<unknown>> = new Map(
  Object.entries({
    writeFile: () => answer(undefined),
    appendFile: () => answer(undefined),
    chmod: () => answer(undefined),
    utimes: () => answer(undefined),
    readFile: () => answer(""),
    readFileBytes: () => answer(""),
    readFileBuffer: () => answer(new Uint8Array(0)),
    exists: () => answer(true),
    stat: () => answer(NULL_STAT),
    lstat: () => answer(NULL_STAT),
    realpath: () => answer(NULL_DEVICE),
    rm: (path) => denied("rm", path),
    mkdir: (path) => refuse("EEXIST", "file already exists", "mkdir", path),
    readdir: (path) => refuse("ENOTDIR", "not a directory", "scandir", path),
    readlink: (path) => refuse("EINVAL", "invalid argument", "readlink", path),
  }),
)

// The calls that name two paths: an answer, or `undefined` to pass the call through.
const ON_PAIR: ReadonlyMap<
  string,
  (fs: IFileSystem, first: unknown, second: unknown) => Promise<unknown> | undefined
> = new Map(
  Object.entries({
    // Moving the device away, or another file over it, would replace it.
    mv: (_fs, source, destination) =>
      isDevice(source)
        ? denied("mv", source)
        : isDevice(destination)
          ? denied("mv", destination)
          : undefined,
    // A copy to the device is dropped; a copy from it is an empty file.
    cp: (fs, source, destination) =>
      isDevice(destination)
        ? answer(undefined)
        : isDevice(source) && typeof destination === "string"
          ? fs.writeFile(destination, "")
          : undefined,
    // A link to the device would reach the device itself for every later call through the link.
    link: (_fs, existing, created) =>
      isDevice(existing)
        ? denied("link", existing)
        : isDevice(created)
          ? denied("link", created)
          : undefined,
    symlink: (_fs, target, created) =>
      isDevice(target)
        ? denied("symlink", target)
        : isDevice(created)
          ? refuse("EEXIST", "file already exists", "symlink", created)
          : undefined,
  }),
)

/**
 * The file system with {@link NULL_DEVICE} made a real null device. just-bash writes a redirect to
 * `/dev/null` (`>/dev/null`, `&>/dev/null`) as a file, which the disk refuses as a special file and
 * which an in-memory `/dev` would keep; so every call on that path is answered here and none
 * reaches the host's device: a write, `chmod` and `utimes` are dropped, a read is empty, it exists
 * as an empty file, a copy to it is dropped and a copy from it is an empty file. A call that would
 * remove, replace, list or link the device (`rm`, `mv` to or from it, `mkdir`, `readdir`,
 * `readlink`, `ln` of it) is refused with the error the disk would give. Other paths pass through,
 * a link to the device that something else made included.
 */
export const withNullDevice = (fs: IFileSystem): IFileSystem =>
  new Proxy(fs, {
    get: (target, name) => {
      const member: unknown = Reflect.get(target, name, target)
      if (typeof member !== "function" || typeof name !== "string") return member
      const onPath = ON_PATH.get(name)
      const onPair = ON_PAIR.get(name)
      if (onPath === undefined && onPair === undefined) return member
      return (...args: Array<unknown>): unknown => {
        const [first, second] = args
        const handled =
          onPair !== undefined
            ? onPair(target, first, second)
            : isDevice(first)
              ? onPath?.(first)
              : undefined
        if (handled !== undefined) return handled
        const result: unknown = Reflect.apply(member, target, args)
        return result
      }
    },
  })
