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

// Where a path leads once the inner file system has resolved it: to the device, to a folder that is
// or contains the device, to the device used as a folder (`/dev/null/`), or somewhere else.
type Spot = "device" | "notdir" | "ancestor" | "elsewhere"

// The final step of a call that this file system answers itself or passes on.
type Step = () => Promise<unknown>

// The inner file system's real path as an absolute one (`ReadWriteFs` answers `dev/null` without
// the root's slash), or the lexical path where it cannot say (a missing parent).
const real = (fs: IFileSystem, path: string): Effect.Effect<string> =>
  Effect.tryPromise({ try: () => fs.realpath(path), catch: (error) => error }).pipe(
    Effect.map((resolved) => posix.resolve("/", resolved)),
    Effect.orElseSucceed(() => posix.normalize(path)),
  )

// The real path of `path`. A link at its end is not followed, as the kernel does not follow it for
// `rm` and `mv`, so the real parent plus the name stands for it, which also resolves a missing leaf
// and the device itself alike; a trailing slash makes the kernel follow the link.
const resolve = (fs: IFileSystem, path: string): Effect.Effect<string> => {
  const trailing = path.length > 1 && path.endsWith("/")
  const bare = trailing ? path.replace(/\/+$/, "") : path
  const name = posix.basename(bare)
  return trailing || name === "" || name === "." || name === ".."
    ? real(fs, bare)
    : Effect.map(real(fs, posix.dirname(bare)), (parent) => posix.join(parent, name))
}

// The real path of `path` with a link at its end followed, for the calls the inner file system
// follows (`chmod`, `utimes`, reads and writes), which would otherwise reach the host's device
// through a link the shell made. Where the walk fails (a missing leaf) the unfollowed path stands.
const followed = (fs: IFileSystem, path: string): Effect.Effect<string> =>
  Effect.tryPromise({ try: () => fs.realpath(path), catch: (error) => error }).pipe(
    Effect.map((resolved) => posix.resolve("/", resolved)),
    Effect.catch(() => resolve(fs, path)),
  )

// Whether the real path is the device or a folder that holds it, which removing or moving takes along.
const holdsDevice = (path: string): boolean => path === "/" || path === posix.dirname(NULL_DEVICE)

// Where `path` leads, however it is spelled or reached: `/dev//null`, a link to `/dev` and
// `/proc/self/root/dev/null` all end at the device. A relative path is the inner file system's.
// A link at the end is followed only when `follow` is set, as for the calls that follow it.
const classify = (fs: IFileSystem, path: unknown, follow = false): Effect.Effect<Spot> =>
  typeof path !== "string" || !path.startsWith("/")
    ? Effect.succeed("elsewhere")
    : Effect.map(follow ? followed(fs, path) : resolve(fs, path), (resolved): Spot =>
        resolved === NULL_DEVICE
          ? path.length > 1 && path.endsWith("/")
            ? "notdir"
            : "device"
          : holdsDevice(resolved)
            ? "ancestor"
            : "elsewhere",
      )

const answer = (value: unknown): Promise<unknown> => Effect.runPromise(Effect.succeed(value))

const refuse = (code: string, reason: string, call: string, path: string): Promise<unknown> =>
  Effect.runPromise(
    Effect.fail(new NullDeviceRefused({ message: `${code}: ${reason}, ${call} '${path}'` })),
  )

const denied = (call: string, path: string) =>
  refuse("EPERM", "operation not permitted", call, path)

const notDirectory = (call: string, path: string) =>
  refuse("ENOTDIR", "not a directory", call, path)

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

// The calls on one path that the inner file system carries out on the end of a link: a link to the
// device made by the shell (`ln -s ../dev/null n`) must not reach the host's device through them.
// `rm`, `mkdir`, `readlink` and `lstat` act on the link itself, so they are not here.
const FOLLOWS: ReadonlySet<string> = new Set([
  "writeFile",
  "appendFile",
  "chmod",
  "utimes",
  "readFile",
  "readFileBytes",
  "readFileBuffer",
  "exists",
  "stat",
])

// The two paths of a call and where each leads.
interface Pair {
  readonly first: unknown
  readonly second: unknown
  readonly from: Spot
  readonly to: Spot
}

// A step for the calls that name two paths, or `undefined` to pass the call through.
const ON_PAIR: ReadonlyMap<string, (fs: IFileSystem, pair: Pair) => Step | undefined> = new Map(
  Object.entries({
    // Moving the device or its folder away, or another file over the device, would replace it.
    mv: (_fs, { first, second, from, to }) =>
      from === "device" || from === "ancestor"
        ? () => denied("mv", String(first))
        : to === "device"
          ? () => denied("mv", String(second))
          : undefined,
    // A copy to the device is dropped, unless the source is missing or a folder, which fail as they
    // do for a copy to any file; a copy from it is an empty file.
    cp: (fs, { first, second, to, from }) =>
      to === "device" && typeof first === "string"
        ? () =>
            fs
              .stat(first)
              .then((source) =>
                source.isDirectory
                  ? refuse("EISDIR", "illegal operation on a directory", "cp", first)
                  : undefined,
              )
        : from === "device" && typeof second === "string"
          ? () => fs.writeFile(second, "")
          : undefined,
    // A link to the device would reach the device itself for every later call through the link.
    link: (_fs, { first, second, from, to }) =>
      from === "device"
        ? () => denied("link", String(first))
        : to === "device"
          ? () => denied("link", String(second))
          : undefined,
    symlink: (_fs, { first, second, from, to }) =>
      from === "device"
        ? () => denied("symlink", String(first))
        : to === "device"
          ? () => refuse("EEXIST", "file already exists", "symlink", String(second))
          : undefined,
  }),
)

// The step for one call, or `undefined` to pass it to the inner file system. A path that is the
// device used as a folder (`/dev/null/`) gives ENOTDIR whatever the call, as it does on disk.
const decide = (
  fs: IFileSystem,
  name: string,
  args: ReadonlyArray<unknown>,
): Effect.Effect<Step | undefined> => {
  const [first, second] = args
  const onPair = ON_PAIR.get(name)
  if (onPair !== undefined)
    return Effect.map(
      Effect.all([classify(fs, first), classify(fs, second)]),
      ([from, to]): Step | undefined =>
        from === "notdir" || to === "notdir"
          ? () => notDirectory(name, String(from === "notdir" ? first : second))
          : onPair(fs, { first, second, from, to }),
    )
  const onPath = ON_PATH.get(name)
  return Effect.map(classify(fs, first, FOLLOWS.has(name)), (spot): Step | undefined =>
    spot === "notdir"
      ? () => notDirectory(name, String(first))
      : spot === "ancestor" && name === "rm"
        ? () => denied("rm", String(first))
        : spot === "device" && onPath !== undefined
          ? () => onPath(String(first))
          : undefined,
  )
}

/**
 * The file system with {@link NULL_DEVICE} made a real null device. just-bash writes a redirect to
 * `/dev/null` (`>/dev/null`, `&>/dev/null`) as a file, which the disk refuses as a special file and
 * which an in-memory `/dev` would keep; so every call on that path is answered here and none
 * reaches the host's device: a write, `chmod` and `utimes` are dropped, a read is empty, it exists
 * as an empty file, a copy to it is dropped (a missing or folder source fails) and a copy from it
 * is an empty file. A call that would remove, replace, list or link the device (`rm`, `mv` to or
 * from it, `mkdir`, `readdir`, `readlink`, `ln` of it) is refused with the error the disk would
 * give, and so is removing or moving `/dev` or a folder that holds it; `/dev/null/` gives
 * `ENOTDIR`. A path counts as the device by its real path in the inner file system (the real parent
 * plus the name, so a link in the path, `/proc/self/root/dev/null` and a missing leaf resolve
 * alike), not by its spelling; a call that follows a link at the end (`chmod`, `utimes`, reads and
 * writes) counts the full real path, so a link to the device is the device for it, while `rm`, `mv`
 * and `ln` act on the link itself. Other paths pass through.
 */
export const withNullDevice = (fs: IFileSystem): IFileSystem =>
  new Proxy(fs, {
    get: (target, name) => {
      const member: unknown = Reflect.get(target, name, target)
      if (typeof member !== "function" || typeof name !== "string") return member
      if (!ON_PATH.has(name) && !ON_PAIR.has(name)) return member
      return (...args: Array<unknown>): Promise<unknown> =>
        Effect.runPromise(decide(target, name, args)).then((step): unknown =>
          step === undefined ? Reflect.apply(member, target, args) : step(),
        )
    },
  })
