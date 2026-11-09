import { beforeEach, describe, expect, test } from "bun:test"
import { posix } from "node:path"

import { InMemoryFs } from "just-bash"

import { withNullDevice } from "../../src/pi/bash/devices.ts"

// The inner file system is in memory, so no test here can touch the machine's own /dev/null. Its
// /dev/null is a plain file that holds "host device": it survives only when the guard stops the call.
let inner: InMemoryFs

// `InMemoryFs.realpath` stops at a link to `/` and at `..` after a link, which a disk resolves, so the
// fake gets the disk's walk: one component at a time, a link replaced by its target, `..` after it.
const walk = async (fs: InMemoryFs, path: string, depth = 0): Promise<string> => {
  if (depth > 20) throw new Error(`ELOOP: too many symbolic links, realpath '${path}'`)
  let resolved = "/"
  for (const part of path.split("/").filter((piece) => piece !== "" && piece !== ".")) {
    if (part === "..") {
      resolved = posix.dirname(resolved)
      continue
    }
    const next = posix.join(resolved, part)
    const info = await fs.lstat(next)
    resolved = info.isSymbolicLink
      ? await walk(fs, posix.resolve(resolved, await fs.readlink(next)), depth + 1)
      : next
  }
  return resolved
}

const onDisk = (fs: InMemoryFs): InMemoryFs =>
  new Proxy(fs, {
    get: (target, name) => {
      const member: unknown = Reflect.get(target, name, target)
      if (name === "realpath")
        return (path: string) =>
          // `ReadWriteFs` answers without the root's slash: `dev/null` for `/dev/null`.
          walk(target, path).then((resolved) => (resolved === "/" ? resolved : resolved.slice(1)))
      if (typeof member !== "function") return member
      const bound: unknown = member.bind(target)
      return bound
    },
  })

let fs: ReturnType<typeof withNullDevice>

beforeEach(async () => {
  inner = new InMemoryFs({ "/dev/null": "host device", "/work/x": "kept\n" })
  await inner.mkdir("/tmp", { recursive: true })
  await inner.mkdir("/work/dir", { recursive: true })
  await inner.symlink("/dev", "/tmp/d")
  await inner.symlink("/tmp/d", "/tmp/d2")
  await inner.symlink("/dev/null", "/tmp/n")
  await inner.mkdir("/proc/self", { recursive: true })
  await inner.symlink("/", "/proc/self/root")
  fs = withNullDevice(onDisk(inner))
})

const failure = async (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "ok",
    (error: Error) => error.message,
  )

const deviceKept = async () => expect(await inner.readFile("/dev/null")).toBe("host device")

describe("a path that leads to the device is the device, however it is reached", () => {
  const aliases = [
    "/tmp/d/null",
    "/tmp/d2/null",
    "/proc/self/root/dev/null",
    "/proc/self/root/tmp/d/null",
    "/tmp/d/../dev/null",
    "/dev//null",
  ]

  test.each(aliases)("rm of %s is refused and the device stays", async (alias) => {
    expect(await failure(fs.rm(alias))).toMatch(/^EPERM/)
    expect(await failure(fs.rm(alias, { force: true, recursive: true }))).toMatch(/^EPERM/)
    await deviceKept()
  })

  test.each(aliases)("mv to or from %s is refused and the device stays", async (alias) => {
    expect(await failure(fs.mv("/work/x", alias))).toMatch(/^EPERM/)
    expect(await failure(fs.mv(alias, "/work/moved"))).toMatch(/^EPERM/)
    expect(await inner.exists("/work/moved")).toBe(false)
    expect(await inner.readFile("/work/x")).toBe("kept\n")
    await deviceKept()
  })

  test.each(aliases)("reads, writes and copies on %s act on the null device", async (alias) => {
    expect(await fs.readFile(alias)).toBe("")
    await fs.writeFile(alias, "dropped")
    await fs.appendFile(alias, "dropped")
    await fs.cp("/work/x", alias)
    expect((await fs.stat(alias)).size).toBe(0)
    expect(await fs.realpath(alias)).toBe("/dev/null")
    await fs.cp(alias, "/work/empty")
    expect(await inner.readFile("/work/empty")).toBe("")
    await deviceKept()
  })

  test.each(aliases)("mkdir, readdir, readlink and ln of %s are refused", async (alias) => {
    expect(await failure(fs.mkdir(alias))).toMatch(/^EEXIST/)
    expect(await failure(fs.readdir(alias))).toMatch(/^ENOTDIR/)
    expect(await failure(fs.readlink(alias))).toMatch(/^EINVAL/)
    expect(await failure(fs.link(alias, "/work/hard"))).toMatch(/^EPERM/)
    expect(await failure(fs.symlink(alias, "/work/soft"))).toMatch(/^EPERM/)
    expect(await failure(fs.symlink("/work/x", alias))).toMatch(/^EEXIST/)
    expect(await inner.exists("/work/hard")).toBe(false)
    expect(await inner.exists("/work/soft")).toBe(false)
  })

  test("a sibling of the device is not the device", async () => {
    await inner.writeFile("/dev/other", "x")
    await fs.rm("/dev/other")
    expect(await inner.exists("/dev/other")).toBe(false)
    await fs.rm("/tmp/missing/null", { force: true })
  })

  test("a link to the device is removed or moved as a link, not as the device", async () => {
    await fs.mv("/tmp/n", "/tmp/n-moved")
    expect(await inner.exists("/tmp/n")).toBe(false)
    await fs.rm("/tmp/n-moved")
    expect(await inner.exists("/tmp/n-moved")).toBe(false)
    await deviceKept()
  })

  test("a call on a path that does not lead to the device passes through", async () => {
    await fs.writeFile("/work/y", "y")
    await fs.cp("/work/y", "/work/z")
    await fs.mv("/work/z", "/work/w")
    await fs.rm("/work/w")
    expect(await inner.readFile("/work/y")).toBe("y")
    expect(await inner.exists("/work/w")).toBe(false)
  })
})

describe("removing or moving /dev, or a folder that holds the device, is refused", () => {
  test.each(["/dev", "/dev/", "/tmp/d/", "/proc/self/root/dev", "/dev/../dev", "/"])(
    "rm of %s",
    async (folder) => {
      expect(await failure(fs.rm(folder, { recursive: true, force: true }))).toMatch(/^EPERM/)
      await deviceKept()
    },
  )

  test.each(["/dev", "/tmp/d/", "/proc/self/root/dev"])("mv of %s", async (folder) => {
    expect(await failure(fs.mv(folder, "/work/dev-moved"))).toMatch(/^EPERM/)
    expect(await inner.exists("/work/dev-moved")).toBe(false)
    await deviceKept()
  })

  test("a link to /dev is removed as a link", async () => {
    await fs.rm("/tmp/d2")
    expect(await inner.exists("/tmp/d2")).toBe(false)
    expect(await inner.exists("/tmp/d/null")).toBe(true)
  })

  test("a folder that does not hold the device is removed", async () => {
    await fs.rm("/work/dir", { recursive: true })
    expect(await inner.exists("/work/dir")).toBe(false)
  })
})

describe("copies to the device", () => {
  test("from a missing source fail as a copy to any file does", async () => {
    expect(await failure(fs.cp("/work/missing", "/dev/null"))).toMatch(/ENOENT/)
    expect(await failure(fs.cp("/work/missing", "/tmp/d/null"))).toMatch(/ENOENT/)
  })

  test("from a folder fail", async () => {
    expect(await failure(fs.cp("/work/dir", "/dev/null"))).toMatch(/^EISDIR/)
    expect(await failure(fs.cp("/work/dir", "/dev/null", { recursive: true }))).toMatch(/^EISDIR/)
    await deviceKept()
  })

  test("from a file succeed and drop the data", async () => {
    expect(await failure(fs.cp("/work/x", "/dev/null"))).toBe("ok")
    await deviceKept()
  })
})

describe("the device used as a folder", () => {
  test.each(["/dev/null/", "/dev/null//", "/tmp/d/null/", "/proc/self/root/dev/null/"])(
    "%s gives ENOTDIR to every call",
    async (path) => {
      expect(await failure(fs.readFile(path))).toMatch(/^ENOTDIR/)
      expect(await failure(fs.writeFile(path, "x"))).toMatch(/^ENOTDIR/)
      expect(await failure(fs.stat(path))).toMatch(/^ENOTDIR/)
      expect(await failure(fs.rm(path))).toMatch(/^ENOTDIR/)
      expect(await failure(fs.mkdir(path))).toMatch(/^ENOTDIR/)
      expect(await failure(fs.mv("/work/x", path))).toMatch(/^ENOTDIR/)
      expect(await failure(fs.cp("/work/x", path))).toMatch(/^ENOTDIR/)
      expect(await failure(fs.cp(path, "/work/y"))).toMatch(/^ENOTDIR/)
      expect(await inner.exists("/work/y")).toBe(false)
      await deviceKept()
    },
  )
})
