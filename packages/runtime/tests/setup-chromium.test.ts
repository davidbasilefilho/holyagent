import { describe, expect, test } from "bun:test"

import {
  CHROMIUM_EXECUTABLE_VARIABLE,
  findChromium,
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

const find = (
  env: Record<string, string>,
  files: ReadonlyArray<string>,
  platform: string = "linux",
) => findChromium(env, platform, machine(files).exists, machine(files).list)

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

  test("the path the person set wins, existing or not, and HOLYAGENT_CHROMIUM_PATH is its variable", () => {
    expect(CHROMIUM_EXECUTABLE_VARIABLE).toBe("HOLYAGENT_CHROMIUM_PATH")
    expect(
      find({ [CHROMIUM_EXECUTABLE_VARIABLE]: "/mine/chrome" }, [
        `${PREINSTALLED_BROWSERS}/chromium`,
      ]),
    ).toBe("/mine/chrome")
  })
})
