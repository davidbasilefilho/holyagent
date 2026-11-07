import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { Effect } from "effect"

import { loadConfig, userConfigFile } from "../../src/config/load.ts"
import { DEFAULT_CONFIG } from "../../src/config/schema.ts"
import { cleanup, put, scratch } from "../vcs-fixtures.ts"

afterEach(cleanup)

/** A home directory and a project state folder, each with the config text given (or no file). */
const setup = async (files: { user?: string; project?: string } = {}) => {
  const home = await scratch()
  const project = await scratch()
  await put(home, files.user === undefined ? {} : { ".holyagent/config.json": files.user })
  await put(project, files.project === undefined ? {} : { "config.json": files.project })
  return {
    env: { HOLYAGENT_HOME: home },
    projectDirectories: [project],
    userPath: join(home, ".holyagent", "config.json"),
    projectPath: join(project, "config.json"),
  }
}

const load = (where: Awaited<ReturnType<typeof setup>>) =>
  Effect.runPromise(loadConfig({ projectDirectories: where.projectDirectories, env: where.env }))

const failure = (where: Awaited<ReturnType<typeof setup>>) =>
  Effect.runPromise(
    Effect.flip(loadConfig({ projectDirectories: where.projectDirectories, env: where.env })),
  )

describe("the user-level file", () => {
  test("lives in .holyagent of HOLYAGENT_HOME, else of the home directory", () => {
    expect(userConfigFile({ HOLYAGENT_HOME: "/h", HOME: "/other" })).toBe(
      join("/h", ".holyagent", "config.json"),
    )
    expect(userConfigFile({ HOME: "/other" })).toBe(join("/other", ".holyagent", "config.json"))
    expect(userConfigFile({ HOLYAGENT_HOME: "", HOME: "/other" })).toBe(
      join("/other", ".holyagent", "config.json"),
    )
  })
})

describe("loading the config", () => {
  test("missing files read as the defaults", async () => {
    expect(await load(await setup())).toEqual(DEFAULT_CONFIG)
  })

  test("a project folder without a project file reads as the defaults too", async () => {
    const where = await setup()
    expect(
      await load({ ...where, projectDirectories: [join(where.projectDirectories[0]!, "x")] }),
    ).toEqual(DEFAULT_CONFIG)
  })

  test("only a user file: its settings apply and the rest stays at the defaults", async () => {
    const config = await load(
      await setup({ user: JSON.stringify({ pi: { codemode: { maxWorkers: 8 } } }) }),
    )
    expect(config.pi.codemode).toEqual({ mode: "only", maxWorkers: 8 })
    expect(config.pi.features).toEqual(DEFAULT_CONFIG.pi.features)
  })

  test("only a project file: its settings apply", async () => {
    const config = await load(
      await setup({ project: JSON.stringify({ pi: { features: { todo: false } } }) }),
    )
    expect(config.pi.features.todo).toBe(false)
    expect(config.pi.features.ask).toBe(true)
  })

  test("the project overrides the user file for the same key", async () => {
    const config = await load(
      await setup({
        user: JSON.stringify({ pi: { codemode: { maxWorkers: 8 }, t3: { scope: "project" } } }),
        project: JSON.stringify({ pi: { codemode: { maxWorkers: 2 } } }),
      }),
    )
    expect(config.pi.codemode.maxWorkers).toBe(2)
    // A key the project leaves out keeps the user's value and is not reset to its default.
    expect(config.pi.t3.scope).toBe("project")
  })

  test("nested objects merge key by key, down to one route's thinking level", async () => {
    const config = await load(
      await setup({
        user: JSON.stringify({
          pi: {
            routes: { root: { model: "other-model" }, "Reviewer.code": { thinking: "high" } },
            features: { web: "pi-web-kit" },
          },
        }),
        project: JSON.stringify({
          pi: { routes: { root: { thinking: "max" } }, features: { processes: false } },
        }),
      }),
    )
    expect(config.pi.routes.root).toEqual({ model: "other-model", thinking: "max" })
    expect(config.pi.routes["Reviewer.code"]).toEqual({
      model: "kimi-for-coding",
      thinking: "high",
    })
    expect(config.pi.routes["Worker.visual"]).toEqual(DEFAULT_CONFIG.pi.routes["Worker.visual"])
    expect(config.pi.features).toMatchObject({ web: "pi-web-kit", processes: false, todo: true })
  })

  test("a list in the project replaces the user's list wholesale", async () => {
    const config = await load(
      await setup({
        user: JSON.stringify({ vcs: { allowWords: ["subagent", "the user"] } }),
        project: JSON.stringify({ vcs: { allowWords: ["this session"] } }),
      }),
    )
    expect(config.vcs.allowWords).toEqual(["this session"])
  })

  test("an empty project list replaces a non-empty user list", async () => {
    const config = await load(
      await setup({
        user: JSON.stringify({ vcs: { allowWords: ["subagent"] } }),
        project: JSON.stringify({ vcs: { allowWords: [] } }),
      }),
    )
    expect(config.vcs.allowWords).toEqual([])
  })

  test("the first project folder that has a file is the project's", async () => {
    const where = await setup({ user: "{}" })
    const first = await scratch()
    const second = await scratch()
    const third = await scratch()
    await put(second, { "config.json": JSON.stringify({ claude: {}, vcs: { allowWords: ["a"] } }) })
    await put(third, { "config.json": JSON.stringify({ vcs: { allowWords: ["b"] } }) })
    const config = await Effect.runPromise(
      loadConfig({ projectDirectories: [first, second, third], env: where.env }),
    )
    expect(config.vcs.allowWords).toEqual(["a"])
  })
})

describe("a bad file", () => {
  test("an unknown top-level key in the project file names the key and the file", async () => {
    const where = await setup({ project: JSON.stringify({ vcs: {}, extra: 1 }) })
    const error = await failure(where)
    expect(error).toMatchObject({ _tag: "CorruptRecord", path: where.projectPath })
    expect(error.message).toContain("extra")
    expect(error.message).toContain(where.projectPath)
  })

  test("an unknown key deep in the user file names the key and the user file", async () => {
    const where = await setup({
      user: JSON.stringify({ pi: { routes: { root: { modell: "x" } } } }),
      project: "{}",
    })
    const error = await failure(where)
    expect(error).toMatchObject({ _tag: "CorruptRecord", path: where.userPath })
    expect(error.message).toContain("modell")
    expect(error.message).toContain("routes")
  })

  test("an unknown route is refused as an unknown key", async () => {
    const where = await setup({
      project: JSON.stringify({ pi: { routes: { "Worker.unknown": { model: "x" } } } }),
    })
    const error = await failure(where)
    expect(error).toMatchObject({ _tag: "CorruptRecord", path: where.projectPath })
    expect(error.message).toContain("Worker.unknown")
  })

  test("an invalid value in the project file names the field and the file", async () => {
    const where = await setup({
      user: "{}",
      project: JSON.stringify({ pi: { routes: { root: { thinking: "ultra" } } } }),
    })
    const error = await failure(where)
    expect(error).toMatchObject({ _tag: "CorruptRecord", path: where.projectPath })
    expect(error.message).toContain("thinking")
  })

  test.each([
    [{ pi: { codemode: { maxWorkers: 0 } } }, "maxWorkers"],
    [{ pi: { codemode: { maxWorkers: 2.5 } } }, "maxWorkers"],
    [{ pi: { codemode: { mode: "off" } } }, "mode"],
    [{ pi: { provider: "openai" } }, "provider"],
    [{ pi: { features: { todo: "yes" } } }, "todo"],
    [{ pi: { features: { web: true } } }, "web"],
    [{ pi: { routes: { root: { model: "" } } } }, "model"],
    [{ claude: { anything: 1 } }, "anything"],
    [{ vcs: { allowWords: "subagent" } }, "allowWords"],
    [{ vcs: { allowWords: [1] } }, "allowWords"],
  ])("%j in the user file is refused with the field %s", async (content, field) => {
    const where = await setup({ user: JSON.stringify(content) })
    const error = await failure(where)
    expect(error).toMatchObject({ _tag: "CorruptRecord", path: where.userPath })
    expect(error.message).toContain(field)
  })

  test("text that is not JSON, or not an object, is refused with the file", async () => {
    for (const text of ["{", "", "[]", "null", '"x"']) {
      const where = await setup({ project: text })
      expect(await failure(where)).toMatchObject({ _tag: "CorruptRecord", path: where.projectPath })
    }
  })

  test("a bad user file stops the load even when the project file is fine", async () => {
    const where = await setup({ user: '{"nope":1}', project: "{}" })
    expect(await failure(where)).toMatchObject({ _tag: "CorruptRecord", path: where.userPath })
  })
})
