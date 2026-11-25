import { expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { $ } from "bun"
import { Effect, Layer, Option } from "effect"

import { Shell } from "../../../core/src/setup/shell.ts"
import { defaultCodexHome, setupCodex } from "../src/setup.ts"
import { codexStartupConfig } from "../src/startup.ts"

const fixture = async (f: (scratch: string) => Promise<void>) => {
  const scratch = await mkdtemp(join(tmpdir(), "holyagent-public-codex-"))
  try {
    await f(scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

const failOnRun = Layer.succeed(Shell, {
  which: () => Effect.succeed(Option.some("codex")),
  run: () => Effect.die("dry run must not invoke Codex"),
})

const plan = (home: string) =>
  setupCodex({ HOME: dirname(home) }, { home, dryRun: true }).pipe(Effect.provide(failOnRun))

test("the public preview is read-only and uses its own home rather than ambient CODEX_HOME", () =>
  fixture(async (scratch) => {
    const old = join(scratch, ".codex")
    const scoped = defaultCodexHome({ HOME: scratch, CODEX_HOME: old })
    const result = await Effect.runPromise(plan(scoped))
    expect(result.lines.join("\n")).toContain(`~ Codex home: ${scoped}`)
    expect(result.lines.join("\n")).toContain("register the local marketplace")
    await expect(lstat(scoped)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(old)).rejects.toMatchObject({ code: "ENOENT" })
  }))

test("a conflicting native setup or an opt-out is a preflight failure with no writes", () =>
  fixture(async (scratch) => {
    const home = join(scratch, "profile")
    const config = join(home, "config.toml")
    await mkdir(home)
    for (const [contents, detail] of [
      ['model = "gpt-6.2-sol"\n[agents]\nenabled = true\n', "delegation settings"],
      [
        `${codexStartupConfig()}\n[plugins."holyagent@holyagent-local"]\nenabled = false\n`,
        "disabled in this profile",
      ],
    ]) {
      await Bun.write(config, contents ?? "")
      const problem = await Effect.runPromise(Effect.flip(plan(home)))
      expect(problem.detail).toContain(detail ?? "")
      expect(await Bun.file(config).text()).toBe(contents ?? "")
      await expect(lstat(join(home, "holyagent"))).rejects.toMatchObject({ code: "ENOENT" })
    }
  }))

test.skipIf(process.platform === "win32")("setup rejects symlinked role directories", () =>
  fixture(async (scratch) => {
    const home = join(scratch, "profile")
    await mkdir(home)
    await symlink(scratch, join(home, "agents"), "dir")
    const problem = await Effect.runPromise(Effect.flip(plan(home)))
    expect(problem.detail).toContain(join(home, "agents"))
    await expect(lstat(join(scratch, "holyagent-reviewer-code.toml"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  }),
)

const native = Bun.env.HOLYAGENT_TEST_CODEX

test.skipIf(native === undefined)(
  "native setup installs and upgrades the plugin while keeping the profile and user settings",
  () =>
    fixture(async (scratch) => {
      if (native === undefined) throw new Error("Set HOLYAGENT_TEST_CODEX to the native Codex bin")
      const home = join(scratch, "dedicated")
      const env = {
        ...Bun.env,
        HOME: scratch,
        USERPROFILE: scratch,
        CODEX_HOME: home,
        PATH: dirname(native),
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
      }
      await mkdir(home)
      const config = join(home, "config.toml")
      const original = `approval_policy = "on-request"\n${codexStartupConfig()}`
      await Bun.write(config, original)
      const runSetup = (version: string) =>
        setupCodex(env, { home, version, dryRun: false }).pipe(Effect.provide(Shell.live(env)))
      const apply = (version: string) => Effect.runPromise(runSetup(version))
      const first = "0.4.0-dev.2026-11-25.gabcdef0"
      const next = "0.4.0-dev.2026-11-25.gabcdef1"
      expect((await apply(first)).lines.join("\n")).toContain(
        `install holyagent@holyagent-local ${first}`,
      )
      expect((await apply(first)).lines.join("\n")).toContain(`${first} already present`)
      expect((await apply(next)).lines.join("\n")).toContain(
        `install holyagent@holyagent-local ${next}`,
      )
      expect((await apply(next)).lines.join("\n")).toContain(`${next} already present`)
      expect(Bun.TOML.parse(await Bun.file(config).text())).toMatchObject({
        approval_policy: "on-request",
        model: "gpt-6.2-sol",
        agents: { enabled: false, max_depth: 1 },
      })
      const prompt = await $`${native} debug prompt-input ${"Check the scope"}`.env(env).quiet()
      expect(prompt.text()).toContain("holyagent:holyagent-workflow")
      expect(prompt.text()).not.toContain("spawn_agent")
      const role = join(home, "agents", "holyagent-reviewer-code.toml")
      await Bun.write(role, "# manual override\n")
      expect(await Effect.runPromise(Effect.flip(runSetup("0.4.0")))).toMatchObject({
        detail: expect.stringContaining("unowned Codex setup file"),
      })
      expect(await Bun.file(role).text()).toBe("# manual override\n")
      expect(await Bun.file(join(home, "auth.json")).exists()).toBe(false)
    }),
  30_000,
)
