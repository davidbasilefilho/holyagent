import { expect, test } from "bun:test"
import { mkdir, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import { setupCodex } from "../src/setup/codex/setup.ts"
import { codexStartupConfig } from "../src/setup/codex/startup.ts"
import { Shell } from "../src/setup/shell.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"

const quietSkills = `${codexStartupConfig()}\n[skills]\ninclude_instructions = false\n`
const skillNotice = "this profile disables automatic skill listings"

test.each([true, false])(
  "plugins=false stops Codex setup without writes (dry run: %s)",
  async (dryRun) => {
    const fixture = await scratch("holyagent-codex-plugin-opt-out-")
    try {
      const home = fixture.directory
      const config = join(home, "config.toml")
      const original = `${codexStartupConfig()}plugins = false\n`
      await Bun.write(config, original)
      const shell = fakeShell({ commands: ["codex"] })
      const result = await Effect.runPromise(
        setupCodex({ HOME: home }, { home, dryRun }).pipe(Effect.provide(shell.layer), Effect.flip),
      )
      expect(result.detail).toContain("[features] plugins = false")
      expect(await Bun.file(config).text()).toBe(original)
      expect(await readdir(home)).toEqual(["config.toml"])
      expect(shell.calls).toEqual([])
    } finally {
      await fixture.remove()
    }
  },
)

test("preview reports suppressed automatic skill listings without changing the home", async () => {
  const fixture = await scratch("holyagent-codex-skill-preview-")
  try {
    const home = fixture.directory
    const config = join(home, "config.toml")
    await Bun.write(config, quietSkills)
    const shell = fakeShell({ commands: ["codex"] })
    const result = await Effect.runPromise(
      setupCodex({ HOME: home }, { home, dryRun: true }).pipe(Effect.provide(shell.layer)),
    )
    expect(result.lines.join("\n")).toContain(skillNotice)
    expect(await Bun.file(config).text()).toBe(quietSkills)
    expect(await readdir(home)).toEqual(["config.toml"])
    expect(shell.calls).toEqual([])
  } finally {
    await fixture.remove()
  }
})

const native = Bun.env.HOLYAGENT_TEST_CODEX

test.skipIf(native === undefined)(
  "native setup retains the skill preference and its automatic prompt omits the skill",
  async () => {
    if (native === undefined) throw new Error("Set HOLYAGENT_TEST_CODEX to the native Codex binary")
    const fixture = await scratch("holyagent-codex-skill-native-")
    try {
      const home = join(fixture.directory, "home")
      const project = join(fixture.directory, "project")
      const config = join(home, "config.toml")
      const env = {
        HOME: fixture.directory,
        USERPROFILE: fixture.directory,
        CODEX_HOME: home,
        PATH: dirname(native),
        TERM: "dumb",
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
      }
      await mkdir(project)
      await Bun.write(config, quietSkills)
      const result = await Effect.runPromise(
        setupCodex(env, { home, dryRun: false }).pipe(Effect.provide(Shell.live(env))),
      )
      expect(result.lines.join("\n")).toContain(skillNotice)
      const persisted = Bun.TOML.parse(await Bun.file(config).text())
      expect(persisted).toMatchObject({ skills: { include_instructions: false } })
      const prompt = await $`${native} debug prompt-input ${"Check the scope"}`
        .cwd(project)
        .env(env)
        .quiet()
        .text()
      expect(prompt).toContain("If you are the root, handle straightforward work directly")
      expect(prompt).not.toContain("holyagent:holyagent-workflow")
    } finally {
      await fixture.remove()
    }
  },
  30_000,
)
