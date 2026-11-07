import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { Effect } from "effect"

import { loadConfig, userConfigFile } from "../../src/config/load.ts"
import { cleanup, put, scratch } from "../vcs-fixtures.ts"
import { DEFAULT_CONFIG } from "./defaults.ts"

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
    expect(error).toMatchObject({ _tag: "ConfigInvalid", path: where.projectPath })
    expect(error.message).toContain("extra")
    expect(error.message).toContain(where.projectPath)
  })

  test("an unknown key deep in the user file names the key and the user file", async () => {
    const where = await setup({
      user: JSON.stringify({ pi: { routes: { root: { modell: "x" } } } }),
      project: "{}",
    })
    const error = await failure(where)
    expect(error).toMatchObject({ _tag: "ConfigInvalid", path: where.userPath })
    expect(error.message).toContain("modell")
    expect(error.message).toContain("routes")
  })

  test("an unknown route is refused as an unknown key", async () => {
    const where = await setup({
      project: JSON.stringify({ pi: { routes: { "Worker.unknown": { model: "x" } } } }),
    })
    const error = await failure(where)
    expect(error).toMatchObject({ _tag: "ConfigInvalid", path: where.projectPath })
    expect(error.message).toContain("Worker.unknown")
  })

  test("an invalid value in the project file names the field and the file", async () => {
    const where = await setup({
      user: "{}",
      project: JSON.stringify({ pi: { routes: { root: { thinking: "ultra" } } } }),
    })
    const error = await failure(where)
    expect(error).toMatchObject({ _tag: "ConfigInvalid", path: where.projectPath })
    expect(error.message).toContain("thinking")
  })

  test.each([
    [{ pi: { codemode: { maxWorkers: 0 } } }, "maxWorkers"],
    [{ pi: { codemode: { maxWorkers: 2.5 } } }, "maxWorkers"],
    [{ pi: { codemode: { maxWorkers: 17 } } }, "maxWorkers"],
    [{ pi: { enable: "yes" } }, "enable"],
    [{ pi: { t3: { piProvider: true } } }, "piProvider"],
    [{ pi: { t3: { contextMeter: true } } }, "contextMeter"],
    [{ pi: null }, "pi"],
    [{ claude: null }, "claude"],
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
    expect(error).toMatchObject({ _tag: "ConfigInvalid", path: where.userPath })
    expect(error.message).toContain(field)
  })

  test("the message says it is a config, not a state file, and the hint names the config", async () => {
    const where = await setup({ project: '{"nope":1}' })
    const error = await failure(where)
    expect(error.message).toContain("is not a valid HolyAgent config")
    expect(error.message).not.toContain("state file")
  })

  test("text that is not JSON, or not an object, is refused with the file", async () => {
    for (const text of ["{", "", "[]", "null", '"x"']) {
      const where = await setup({ project: text })
      expect(await failure(where)).toMatchObject({ _tag: "ConfigInvalid", path: where.projectPath })
    }
  })

  test("a bad user file stops the load even when the project file is fine", async () => {
    const where = await setup({ user: '{"nope":1}', project: "{}" })
    expect(await failure(where)).toMatchObject({ _tag: "ConfigInvalid", path: where.userPath })
  })
})

describe("the pi and vcs sections", () => {
  test("pi.enable defaults to true and the t3 setup options default to true", async () => {
    const config = await load(await setup())
    expect(config.pi.enable).toBe(true)
    expect(config.pi.t3).toEqual({ scope: "global", worktrees: true, deviceAccess: true })
  })

  test("the cap of maxWorkers is 16: 1 and 16 load", async () => {
    for (const maxWorkers of [1, 16]) {
      const config = await load(
        await setup({ project: JSON.stringify({ pi: { codemode: { maxWorkers } } }) }),
      )
      expect(config.pi.codemode.maxWorkers).toBe(maxWorkers)
    }
  })

  test('"vcs": null reads as no vcs section, in either file', async () => {
    const config = await load(
      await setup({
        user: JSON.stringify({ vcs: null, pi: { features: { todo: false } } }),
        project: JSON.stringify({ vcs: null }),
      }),
    )
    expect(config.vcs).toEqual({})
    expect(config.pi.features.todo).toBe(false)
  })

  test('a project "vcs": null does not clear the vcs settings of the user file', async () => {
    const config = await load(
      await setup({
        user: JSON.stringify({ vcs: { allowWords: ["subagent"] } }),
        project: JSON.stringify({ vcs: null }),
      }),
    )
    expect(config.vcs.allowWords).toEqual(["subagent"])
  })
})

describe("a user-level off is final", () => {
  const OFF = [
    [
      "pi.features.computerUse",
      { features: { computerUse: false } },
      { features: { computerUse: true } },
    ],
    ["pi.features.web", { features: { web: "off" } }, { features: { web: "pi-web-kit" } }],
    ["pi.t3.deviceAccess", { t3: { deviceAccess: false } }, { t3: { deviceAccess: true } }],
  ] as const

  const valueOf = (config: Awaited<ReturnType<typeof load>>, key: string) =>
    key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], config)

  test.each(OFF)(
    "%s off in the user file stays off when the project turns it on",
    async (key, user, project) => {
      const config = await load(
        await setup({
          user: JSON.stringify({ pi: user }),
          project: JSON.stringify({ pi: project }),
        }),
      )
      expect(valueOf(config, key)).toBe(key === "pi.features.web" ? "off" : false)
    },
  )

  test.each(OFF)(
    "%s off in the user file stays off when the project sets it to the default or says nothing",
    async (key, user) => {
      const off = key === "pi.features.web" ? "off" : false
      const silent = await load(await setup({ user: JSON.stringify({ pi: user }), project: "{}" }))
      expect(valueOf(silent, key)).toBe(off)
      const other = await load(
        await setup({
          user: JSON.stringify({ pi: user }),
          project: JSON.stringify({ pi: { features: { todo: false } } }),
        }),
      )
      expect(valueOf(other, key)).toBe(off)
      expect(other.pi.features.todo).toBe(false)
    },
  )

  test.each(OFF)(
    "%s off in the project file turns it off over the user's on",
    async (key, user, project) => {
      // The roles swap: the project holds the off value and the user the on value.
      const config = await load(
        await setup({
          user: JSON.stringify({ pi: project }),
          project: JSON.stringify({ pi: user }),
        }),
      )
      expect(valueOf(config, key)).toBe(key === "pi.features.web" ? "off" : false)
    },
  )

  test("the user's on, or a user file that does not mention it, leaves the project in charge", async () => {
    const config = await load(
      await setup({
        user: JSON.stringify({ pi: { features: { computerUse: true, web: "provider" } } }),
        project: JSON.stringify({ pi: { features: { computerUse: false, web: "pi-web-kit" } } }),
      }),
    )
    expect(config.pi.features).toMatchObject({ computerUse: false, web: "pi-web-kit" })
  })

  test("a user web mode other than off is not final: the project may pick another", async () => {
    const config = await load(
      await setup({
        user: JSON.stringify({ pi: { features: { web: "pi-web-kit" } } }),
        project: JSON.stringify({ pi: { features: { web: "provider" } } }),
      }),
    )
    expect(config.pi.features.web).toBe("provider")
  })

  test("every other key keeps project-wins, booleans that are false in the user file included", async () => {
    const config = await load(
      await setup({
        user: JSON.stringify({
          pi: {
            enable: false,
            features: { todo: false, subagents: false },
            t3: { worktrees: false },
          },
        }),
        project: JSON.stringify({
          pi: { enable: true, features: { todo: true, subagents: true }, t3: { worktrees: true } },
        }),
      }),
    )
    expect(config.pi.enable).toBe(true)
    expect(config.pi.features).toMatchObject({ todo: true, subagents: true })
    expect(config.pi.t3.worktrees).toBe(true)
  })

  test("a final off does not touch the keys next to it", async () => {
    const config = await load(
      await setup({
        user: JSON.stringify({ pi: { t3: { deviceAccess: false } } }),
        project: JSON.stringify({ pi: { t3: { scope: "project", worktrees: false } } }),
      }),
    )
    expect(config.pi.t3).toEqual({ scope: "project", worktrees: false, deviceAccess: false })
  })
})
