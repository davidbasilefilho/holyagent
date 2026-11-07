import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { Effect } from "effect"

import { readSettings } from "../src/vcs/settings.ts"
import { cleanup, put, scratch } from "./vcs-fixtures.ts"

afterEach(cleanup)

const read = async (directories: ReadonlyArray<string>, home?: string) =>
  Effect.runPromise(readSettings(directories, { HOLYAGENT_HOME: home ?? (await scratch()) }))

describe("readSettings", () => {
  test("a missing file reads as the defaults", async () => {
    expect(await read([await scratch()])).toEqual({})
  })

  test("reads allowWords and the old keys that are still accepted", async () => {
    const dir = await scratch()
    await put(dir, {
      "config.json": JSON.stringify({
        vcs: { api: true, allowWords: ["subagent"], stateBranch: "x" },
      }),
    })
    expect(await read([dir])).toEqual({ api: true, allowWords: ["subagent"], stateBranch: "x" })
  })

  test("the config file of the first folder that has one is used", async () => {
    const [first, second, third] = [await scratch(), await scratch(), await scratch()] as [
      string,
      string,
      string,
    ]
    await put(second, { "config.json": JSON.stringify({ vcs: { allowWords: ["a"] } }) })
    await put(third, { "config.json": JSON.stringify({ vcs: { allowWords: ["b"] } }) })
    expect((await read([first, second, third])).allowWords).toEqual(["a"])
  })

  test("an unknown key inside vcs is refused and names the file", async () => {
    const dir = await scratch()
    await put(dir, { "config.json": JSON.stringify({ vcs: { bogus: 1 } }) })
    const error = await Effect.runPromise(
      Effect.flip(readSettings([dir], { HOLYAGENT_HOME: await scratch() })),
    )
    expect(error).toMatchObject({ _tag: "CorruptRecord", path: join(dir, "config.json") })
    expect(error.message).toContain("bogus")
  })

  test("the sections of the other hosts are read and checked too", async () => {
    const dir = await scratch()
    await put(dir, {
      "config.json": JSON.stringify({ vcs: { allowWords: ["x"] }, pi: {}, claude: {} }),
    })
    expect((await read([dir])).allowWords).toEqual(["x"])
  })

  test("the user's vcs settings apply under the project's, and a project list replaces theirs", async () => {
    const home = await scratch()
    const dir = await scratch()
    await put(home, {
      ".holyagent/config.json": JSON.stringify({ vcs: { allowWords: ["from the user file"] } }),
    })
    expect((await read([dir], home)).allowWords).toEqual(["from the user file"])
    await put(dir, { "config.json": JSON.stringify({ vcs: { allowWords: ["from the project"] } }) })
    expect((await read([dir], home)).allowWords).toEqual(["from the project"])
  })
})
