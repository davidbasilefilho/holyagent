import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { readdir, realpath } from "node:fs/promises"
import { join } from "node:path"

import { Effect } from "effect"

import { CODEX_ASSET_VERSION, CODEX_MARKETPLACE, CODEX_PLUGIN } from "../src/setup/codex/assets.ts"
import { type CodexSetupOptions, setupCodex } from "../src/setup/codex/setup.ts"
import { CODEX_STARTUP_MARKETPLACE, codexStartupFiles } from "../src/setup/codex/startup.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"

const roleName = "agents/holyagent-reviewer-code.toml"
const skillName = join(
  CODEX_STARTUP_MARKETPLACE,
  "plugins",
  "holyagent",
  "skills",
  "holyagent-workflow",
  "SKILL.md",
)

const probe = async (directory: string, onNativeVersion?: () => void) => {
  const home = join(await realpath(directory), "profile")
  const sources = await Effect.runPromise(codexStartupFiles(home))
  const sourceRoot = join(CODEX_STARTUP_MARKETPLACE, "plugins", "holyagent")
  const cache = join(home, "plugins", "cache", CODEX_MARKETPLACE, "holyagent", CODEX_ASSET_VERSION)
  const snapshot = new Map(sources.map(({ path, content }) => [path, content]))
  for (const { path, content } of sources) {
    await Bun.write(join(home, path), content)
    if (path.startsWith(`${sourceRoot}/`) || path.startsWith(`${sourceRoot}\\`))
      await Bun.write(join(cache, path.slice(sourceRoot.length + 1)), content)
  }
  const config = join(home, "config.toml")
  const choices = `${snapshot.get("config.toml")}\n[marketplaces."${CODEX_MARKETPLACE}"]\nsource = ${JSON.stringify(join(home, CODEX_STARTUP_MARKETPLACE))}\nsource_type = "local"\n\n[plugins."${CODEX_PLUGIN}"]\nenabled = true\n`
  await Bun.write(config, choices)
  const hashes = Object.fromEntries(
    sources
      .filter(({ path }) => path !== "config.toml")
      .map(({ path, content }) => [path, Bun.CryptoHasher.hash("sha256", content, "hex")]),
  )
  await Bun.write(
    join(home, "holyagent", "setup-v1.json"),
    JSON.stringify({ version: 1, files: hashes }),
  )
  await Bun.write(join(home, "unrelated.txt"), "User data\n")
  const shell = fakeShell({
    commands: ["codex"],
    respond: (line) => {
      if (line === "codex --version") {
        onNativeVersion?.()
        return { stdout: "codex-cli 0.172.0\n" }
      }
      if (line === "codex plugin marketplace add --help")
        return {
          stdout: "Usage: codex plugin marketplace add [OPTIONS] <SOURCE>\n\n      --json\n",
        }
      if (line === "codex plugin add --help")
        return { stdout: "Usage: codex plugin add [OPTIONS] <PLUGIN>\n\n      --json\n" }
      if (line === "codex plugin list --help")
        return {
          stdout:
            "Usage: codex plugin list [OPTIONS]\n\n      --marketplace <NAME>\n      --json\n",
        }
      if (line.startsWith("codex plugin list"))
        return {
          stdout: JSON.stringify({
            installed: [{ pluginId: CODEX_PLUGIN, enabled: true, version: CODEX_ASSET_VERSION }],
          }),
        }
      throw new Error(`Unexpected command ${line}`)
    },
  })
  const setup = (options: Omit<CodexSetupOptions, "home">) => {
    const run = setupCodex({ HOME: directory }, { home, ...options }).pipe(
      Effect.provide(shell.layer),
    )
    return Effect.runPromise(run)
  }
  return {
    home,
    snapshot,
    choices,
    config,
    shell,
    setup,
    backupRoot: join(home, "holyagent", "setup-backups"),
  }
}

test("only confirmed Codex instruction conflicts get a backup and other settings stay byte-for-byte", async () => {
  const fixture = await scratch("holyagent-codex-managed-instructions-")
  try {
    const p = await probe(fixture.directory)
    const originals = new Map([
      ["AGENTS.md", "# HolyAgent\n\nedited root instructions\n"],
      [
        roleName,
        (p.snapshot.get(roleName) ?? "").replace(
          /^developer_instructions = .*$/m,
          'developer_instructions = "edited role instructions"',
        ),
      ],
      [skillName, "---\nname: holyagent-workflow\n---\nedited workflow instructions\n"],
    ])
    for (const [file, before] of originals) await Bun.write(join(p.home, file), before)
    await expect(p.setup({ dryRun: false })).rejects.toMatchObject({
      detail: expect.stringContaining("Kept modified or unowned"),
    })
    await expect(p.setup({ dryRun: true })).rejects.toMatchObject({
      detail: expect.stringContaining("Kept modified or unowned"),
    })
    await expect(p.setup({ dryRun: false, managedInstructions: "replace" })).rejects.toMatchObject({
      detail: expect.stringContaining("Kept modified or unowned"),
    })
    const preview = await p.setup({ dryRun: true, managedInstructions: "review" })
    if (!("fingerprint" in preview)) throw new Error("Expected a review fingerprint")
    expect(preview.managedConflicts?.map(({ file }) => file).toSorted()).toEqual(
      [...originals.keys()].map((file) => join(p.home, file)).toSorted(),
    )
    expect(p.shell.calls).toEqual([])
    for (const [file, before] of originals)
      expect(await Bun.file(join(p.home, file)).text()).toBe(before)
    const result = await p.setup({
      dryRun: false,
      managedInstructions: "replace",
      expectedPlan: preview.fingerprint,
    })
    expect(result).toMatchObject({ ok: true })
    const [backup] = await readdir(p.backupRoot)
    if (backup === undefined) throw new Error("Expected backup folder")
    for (const [file, before] of originals) {
      expect(await Bun.file(join(p.backupRoot, backup, file)).text()).toBe(before)
      expect(await Bun.file(join(p.home, file)).text()).toBe(p.snapshot.get(file) ?? "")
    }
    expect(await Bun.file(join(p.backupRoot, backup, "config.toml")).exists()).toBe(false)
    expect(await Bun.file(p.config).text()).toBe(p.choices)
    expect(await Bun.file(join(p.home, "unrelated.txt")).text()).toBe("User data\n")
  } finally {
    await fixture.remove()
  }
})

test("a race before writing leaves the Codex files untouched and has no backup to restore", async () => {
  const fixture = await scratch("holyagent-codex-managed-race-")
  try {
    let role: string | undefined
    const p = await probe(fixture.directory, () => {
      if (role !== undefined) writeFileSync(role, "a newer external edit\n")
    })
    const rootFile = join(p.home, "AGENTS.md")
    role = join(p.home, roleName)
    const original = "reviewed local root instructions\n"
    await Bun.write(rootFile, original)
    const preview = await p.setup({ dryRun: true, managedInstructions: "review" })
    if (!("fingerprint" in preview)) throw new Error("Expected a review fingerprint")
    await expect(
      p.setup({ dryRun: false, managedInstructions: "replace", expectedPlan: preview.fingerprint }),
    ).rejects.toMatchObject({ detail: expect.stringContaining("Profile changed during setup") })
    expect(await Bun.file(rootFile).text()).toBe(original)
    expect(await Bun.file(role).text()).toBe("a newer external edit\n")
    await expect(readdir(p.backupRoot)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await fixture.remove()
  }
})

test("receipt absence, role preferences, and a plugin opt-out never become replaceable", async () => {
  const fixture = await scratch("holyagent-codex-protected-preferences-")
  try {
    const p = await probe(fixture.directory)
    const role = join(p.home, roleName)
    const comment = `# user-maintained policy\n${p.snapshot.get(roleName)}`
    await Bun.write(role, comment)
    await expect(p.setup({ dryRun: true, managedInstructions: "review" })).rejects.toMatchObject({
      detail: expect.stringContaining("Kept modified or unowned"),
    })
    expect(await Bun.file(role).text()).toBe(comment)
    await Bun.write(role, p.snapshot.get(roleName) ?? "")
    const receipt = join(p.home, "holyagent", "setup-v1.json")
    const data = (await Bun.file(receipt).json()) as {
      version: number
      files: Record<string, string>
    }
    delete data.files["AGENTS.md"]
    await Bun.write(receipt, JSON.stringify(data))
    const root = join(p.home, "AGENTS.md")
    await Bun.write(root, "My own startup file\n")
    await expect(p.setup({ dryRun: true, managedInstructions: "review" })).rejects.toMatchObject({
      detail: expect.stringContaining("Kept modified or unowned"),
    })
    expect(await Bun.file(root).text()).toBe("My own startup file\n")
    await Bun.write(p.config, p.choices.replace("[features]", "[features]\nplugins = false"))
    await expect(p.setup({ dryRun: true, managedInstructions: "review" })).rejects.toMatchObject({
      detail: expect.stringContaining("plugins = false"),
    })
    expect(p.shell.calls).toEqual([])
  } finally {
    await fixture.remove()
  }
})
