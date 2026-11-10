import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CHROMIUM_EXECUTABLE_VARIABLE,
  chromiumFixFor,
  findChromium,
  LEGACY_CHROMIUM_EXECUTABLE_VARIABLE,
  PREINSTALLED_BROWSERS,
} from "../src/setup/chromium.ts"

// A file system of a few paths, written with `/`: `exists` and `list` answer from it for a path in
// either separator, so the fixture is the same on every host.
const slashed = (path: string) => path.replaceAll("\\", "/")
const machine = (files: ReadonlyArray<string>) => ({
  exists: (path: string) => files.includes(slashed(path)),
  list: (folder: string) => [
    ...new Set(
      files
        .filter((file) => file.startsWith(`${slashed(folder)}/`))
        .map((file) => file.slice(folder.length + 1).split("/")[0] ?? ""),
    ),
  ],
})

// No command is on the PATH unless a test says so, so that the host's own PATH never decides.
const find = (
  env: Record<string, string>,
  files: ReadonlyArray<string>,
  platform: string = "linux",
  which: (command: string) => string | undefined = () => undefined,
) => findChromium(env, platform, machine(files).exists, machine(files).list, which)

describe("the Chromium a machine provides for the headless browser", () => {
  test("is the chromium entry of the preinstalled browsers folder when it exists", () => {
    expect(find({}, [`${PREINSTALLED_BROWSERS}/chromium`])).toBe(
      `${PREINSTALLED_BROWSERS}/chromium`,
    )
  })

  test("else the newest chromium build in it, by its revision and not its name", () => {
    const files = [
      `${PREINSTALLED_BROWSERS}/chromium-999/chrome-linux64/chrome`,
      `${PREINSTALLED_BROWSERS}/chromium-1243/chrome-linux64/chrome`,
      `${PREINSTALLED_BROWSERS}/chromium_headless_shell-1300/chrome-linux/headless_shell`,
    ]
    expect(find({}, files)).toBe(`${PREINSTALLED_BROWSERS}/chromium-1243/chrome-linux64/chrome`)
  })

  test("finds the executable where Playwright puts it on each platform", () => {
    expect(
      find(
        {},
        [`${PREINSTALLED_BROWSERS}/chromium-1/chrome-mac/Chromium.app/Contents/MacOS/Chromium`],
        "darwin",
      ),
    ).toBe(`${PREINSTALLED_BROWSERS}/chromium-1/chrome-mac/Chromium.app/Contents/MacOS/Chromium`)
    expect(find({}, [`${PREINSTALLED_BROWSERS}/chromium-1/chrome-win/chrome.exe`], "win32")).toBe(
      "\\opt\\pw-browsers\\chromium-1\\chrome-win\\chrome.exe",
    )
  })

  test("joins the path the way the platform asked for does, not the way the host does", () => {
    const files = [`${PREINSTALLED_BROWSERS}/chromium`]
    expect(find({}, files, "linux")).toBe("/opt/pw-browsers/chromium")
    expect(find({}, files, "win32")).toBe("\\opt\\pw-browsers\\chromium")
    expect(find({ PLAYWRIGHT_BROWSERS_PATH: "C:\\pw" }, ["C:/pw/chromium"], "win32")).toBe(
      "C:\\pw\\chromium",
    )
  })

  test("a build folder without the executable is not a Chromium", () => {
    expect(
      find({}, [`${PREINSTALLED_BROWSERS}/chromium-1243/INSTALLATION_COMPLETE`]),
    ).toBeUndefined()
    expect(find({}, [])).toBeUndefined()
  })

  test("PLAYWRIGHT_BROWSERS_PATH names the only folder looked in, and 0 or empty leave the default", () => {
    const files = ["/custom/chromium", `${PREINSTALLED_BROWSERS}/chromium`]
    expect(find({ PLAYWRIGHT_BROWSERS_PATH: "/custom" }, files)).toBe("/custom/chromium")
    expect(find({ PLAYWRIGHT_BROWSERS_PATH: "/elsewhere" }, files)).toBeUndefined()
    expect(find({ PLAYWRIGHT_BROWSERS_PATH: "0" }, files)).toBe(`${PREINSTALLED_BROWSERS}/chromium`)
    expect(find({ PLAYWRIGHT_BROWSERS_PATH: "" }, files)).toBe(`${PREINSTALLED_BROWSERS}/chromium`)
  })

  test("the path the person set wins over the folders when it exists, and HOLYAGENT_CHROMIUM_PATH is its variable", () => {
    expect(CHROMIUM_EXECUTABLE_VARIABLE).toBe("HOLYAGENT_CHROMIUM_PATH")
    expect(
      find({ [CHROMIUM_EXECUTABLE_VARIABLE]: "/mine/chrome" }, [
        "/mine/chrome",
        `${PREINSTALLED_BROWSERS}/chromium`,
      ]),
    ).toBe("/mine/chrome")
  })

  test("the old PLAYWRIGHT_MCP_EXECUTABLE_PATH is read when the new variable is unset or empty, and loses to it otherwise", () => {
    expect(LEGACY_CHROMIUM_EXECUTABLE_VARIABLE).toBe("PLAYWRIGHT_MCP_EXECUTABLE_PATH")
    const files = ["/old/chrome", "/new/chrome"]
    expect(find({ PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/old/chrome" }, files)).toBe("/old/chrome")
    expect(
      find({ HOLYAGENT_CHROMIUM_PATH: "", PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/old/chrome" }, files),
    ).toBe("/old/chrome")
    expect(
      find(
        { HOLYAGENT_CHROMIUM_PATH: "/new/chrome", PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/old/chrome" },
        files,
      ),
    ).toBe("/new/chrome")
  })

  test("a configured path that does not exist is no Chromium, and no other one stands in for it", () => {
    const files = [`${PREINSTALLED_BROWSERS}/chromium`]
    expect(find({ HOLYAGENT_CHROMIUM_PATH: "/mine/gone" }, files)).toBeUndefined()
    expect(find({ PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/old/gone" }, files)).toBeUndefined()
  })

  test("a configured bare command name is found on the PATH and resolves to that file, and one that is not there is no Chromium", () => {
    const onPath = (command: string) => (command === "chromium" ? "/usr/bin/chromium" : undefined)
    const files = [`${PREINSTALLED_BROWSERS}/chromium`]
    expect(find({ HOLYAGENT_CHROMIUM_PATH: "chromium" }, files, "linux", onPath)).toBe(
      "/usr/bin/chromium",
    )
    expect(find({ PLAYWRIGHT_MCP_EXECUTABLE_PATH: "chromium" }, files, "linux", onPath)).toBe(
      "/usr/bin/chromium",
    )
    expect(
      find({ HOLYAGENT_CHROMIUM_PATH: "chromium-browser" }, files, "linux", onPath),
    ).toBeUndefined()
  })

  test("a configured path with a separator must exist as given and is never looked up on the PATH", () => {
    const anywhere = () => "/usr/bin/chromium"
    for (const configured of ["./chromium", "bin/chromium", "C:\\chrome\\chrome.exe"])
      expect(find({ HOLYAGENT_CHROMIUM_PATH: configured }, [], "linux", anywhere)).toBeUndefined()
    expect(
      find({ HOLYAGENT_CHROMIUM_PATH: "bin/chromium" }, ["bin/chromium"], "linux", anywhere),
    ).toBe("bin/chromium")
  })

  test("the PATH lookup reads the environment it is given", () => {
    const folder = mkdtempSync(join(tmpdir(), "holyagent-chromium-"))
    try {
      const name = process.platform === "win32" ? "fake-chromium.cmd" : "fake-chromium"
      const file = join(folder, name)
      writeFileSync(file, "")
      chmodSync(file, 0o755)
      const env = { HOLYAGENT_CHROMIUM_PATH: "fake-chromium", PATH: folder }
      expect(findChromium(env, process.platform)).toBe(file)
      expect(findChromium({ ...env, PATH: join(folder, "elsewhere") })).toBeUndefined()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("the fix names the configured path that does not exist and the variable it is in, else it is the fix alone", () => {
    const { exists } = machine(["/mine/chrome"])
    expect(chromiumFixFor({ HOLYAGENT_CHROMIUM_PATH: "/gone" }, "set it", exists)).toBe(
      "HOLYAGENT_CHROMIUM_PATH is set to /gone, which does not exist; set it",
    )
    expect(chromiumFixFor({ PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/gone" }, "set it", exists)).toBe(
      "PLAYWRIGHT_MCP_EXECUTABLE_PATH is set to /gone, which does not exist; set it",
    )
    expect(chromiumFixFor({ HOLYAGENT_CHROMIUM_PATH: "/mine/chrome" }, "set it", exists)).toBe(
      "set it",
    )
    expect(chromiumFixFor({}, "set it", exists)).toBe("set it")
    const none = () => undefined
    expect(chromiumFixFor({ HOLYAGENT_CHROMIUM_PATH: "chromium" }, "set it", exists, none)).toBe(
      "HOLYAGENT_CHROMIUM_PATH is set to chromium, which does not exist; set it",
    )
    expect(
      chromiumFixFor(
        { HOLYAGENT_CHROMIUM_PATH: "chromium" },
        "set it",
        exists,
        () => "/bin/chromium",
      ),
    ).toBe("set it")
  })
})
