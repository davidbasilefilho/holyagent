import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { DIST_DIRECTORY } from "../src/files.ts"
import { PLUGIN, ROOT } from "./built.ts"
import { isExecutable, pathEnv, searchPath } from "./host.ts"

// These helpers decide what the other tests do on Windows, which has no CI on every machine. The
// platform is a parameter of each, so the Windows branch is checked here on any system.

describe("the search path of a child process", () => {
  test("is joined with ; on Windows, which has no /usr/bin, and keeps the parent's folders", () => {
    expect(searchPath(["C:\\bun"], "win32", "C:\\Program Files\\Git\\bin;C:\\Windows")).toBe(
      "C:\\bun;C:\\Program Files\\Git\\bin;C:\\Windows",
    )
  })

  test("is joined with : elsewhere and ends with the system folders", () => {
    expect(searchPath(["/opt/bun"], "linux", "/ignored")).toBe("/opt/bun:/usr/bin:/bin")
  })

  test("is set under the name the environment already gives it, never as a second variable", () => {
    expect(Object.keys(pathEnv(["C:\\bun"], { Path: "C:\\Windows" }, "win32"))).toEqual(["Path"])
    expect(Object.keys(pathEnv(["C:\\bun"], {}, "win32"))).toEqual(["PATH"])
    expect(Object.keys(pathEnv(["/opt/bun"], { Path: "/x" }, "linux"))).toEqual(["PATH"])
  })
})

describe("whether a file of the repository can be run", () => {
  const wrapper = join(PLUGIN, "scripts", "holyagent")
  const bundle = join(PLUGIN, "scripts", "holyagent.js")

  test("is what the repository commits for it on the platform that runs the tests", async () => {
    expect(await isExecutable(wrapper)).toBe(true)
    expect(await isExecutable(bundle)).toBe(false)
  })

  // Skipped on Windows only: NTFS keeps no execute bit, so `stat` reads every file as
  // non-executable there. The win32 branch of `isExecutable` (the committed mode) is taken by the
  // test below on every platform, and by the test above only when the suite runs on Windows.
  test.skipIf(process.platform === "win32")(
    "is its execute bit where the file system has one",
    async () => {
      expect(await isExecutable(wrapper, "linux")).toBe(true)
      expect(await isExecutable(bundle, "linux")).toBe(false)
    },
  )

  test("is the mode the repository commits for it on Windows, which keeps no execute bit", async () => {
    expect(await isExecutable(wrapper, "win32")).toBe(true)
    expect(await isExecutable(bundle, "win32")).toBe(false)
    expect(await isExecutable(join(ROOT, DIST_DIRECTORY, "absent"), "win32")).toBe(false)
  })
})
