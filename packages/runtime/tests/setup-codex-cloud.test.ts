import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, readdir, symlink } from "node:fs/promises"
import { join } from "node:path"

import { Effect } from "effect"

import { run } from "../src/cli/program.ts"
import { codexSkillFiles } from "../src/setup/codex/assets.ts"
import { scratch } from "./setup-fixture.ts"

let fixture: Awaited<ReturnType<typeof scratch>>
let profile: string
let pkg: string

beforeEach(async () => {
  fixture = await scratch("holyagent-codex-cloud-test-")
  profile = join(fixture.directory, "current codex", "profile")
  pkg = join(fixture.directory, "package")
  await mkdir(profile, { recursive: true })
  await Bun.write(join(profile, "config.toml"), "# Unchanged\n")
  await Bun.write(
    join(pkg, "package.json"),
    JSON.stringify({ name: "holyagent", version: "0.4.0-dev.test" }),
  )
})
afterEach(() => fixture.remove())

const exportWith = (
  args: ReadonlyArray<string>,
  surface: "public" | "agent" = "public",
  codexHome = profile,
) =>
  Effect.runPromise(
    run(
      ["setup", "codex", "cloud", ...args],
      {
        cwd: fixture.directory,
        env: {
          HOME: fixture.directory,
          USERPROFILE: fixture.directory,
          CODEX_HOME: codexHome,
          HOLYAGENT_HOME: join(fixture.directory, "unused"),
        },
        stdin: Effect.die("Cloud export must not read stdin"),
        terminal: { stdin: true, stdout: true },
        t3Workflow: true,
        setupTui: () => Effect.die("Cloud export must not load the TUI"),
        installedPackageRoot: pkg,
      },
      surface,
    ),
  )

const contents = (zip: Buffer): ReadonlyMap<string, string> => {
  const end = zip.length - 22
  expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  const count = zip.readUInt16LE(end + 10)
  const files = new Map<string, string>()
  let reader = zip.readUInt32LE(end + 16)
  for (let index = 0; index < count; index++) {
    expect(zip.readUInt32LE(reader)).toBe(0x02014b50)
    expect(zip.readUInt16LE(reader + 10)).toBe(0)
    const nameSize = zip.readUInt16LE(reader + 28)
    const name = zip.toString("utf8", reader + 46, reader + 46 + nameSize)
    const local = zip.readUInt32LE(reader + 42)
    expect(zip.readUInt32LE(local)).toBe(0x04034b50)
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const data = zip.subarray(dataStart, dataStart + zip.readUInt32LE(reader + 24))
    expect(Bun.hash.crc32(data)).toBe(zip.readUInt32LE(reader + 16))
    files.set(name, data.toString("utf8"))
    reader += 46 + nameSize + zip.readUInt16LE(reader + 30) + zip.readUInt16LE(reader + 32)
  }
  expect(reader).toBe(end)
  return files
}

test("public Cloud help and preview leave the profile and destination untouched", async () => {
  const help = await exportWith(["--help"])
  expect(help.code).toBe(0)
  expect(help.stdout).toContain("setup codex cloud --output <path.zip>")
  const noPath = await exportWith([])
  expect(noPath.code).toBe(2)
  expect(noPath.stderr).toContain("Missing --output")
  const preview = await exportWith(["--output", "preview.zip", "--dry-run"])
  expect(preview.code).toBe(0)
  expect(preview.stdout).toContain("Would export the HolyAgent plugin ZIP")
  expect(preview.stdout).toContain("Workspace availability was not checked")
  expect(preview.stdout).toContain("Cloud activation is unverified")
  expect(await Bun.file(join(fixture.directory, "preview.zip")).exists()).toBe(false)
  expect(await readdir(profile)).toEqual(["config.toml"])
  expect(await Bun.file(join(profile, "config.toml")).text()).toBe("# Unchanged\n")
})

test("the ZIP is a deterministic portable plugin with bundled skills and no local configuration", async () => {
  const exported = await exportWith(["--output", "holyagent.zip"])
  expect(exported.code).toBe(0)
  expect(exported.stderr).toBe("")
  expect(exported.stdout).toContain("Exported the HolyAgent plugin ZIP")
  expect(exported.stdout).toContain("Admin console")
  expect(exported.stdout).toContain("Sources")
  expect(exported.stdout).toContain("Cloud activation is unverified")
  const archive = Buffer.from(
    await Bun.file(join(fixture.directory, "holyagent.zip")).arrayBuffer(),
  )
  const files = contents(archive)
  expect([...files.keys()]).toEqual(["plugin.json", ...codexSkillFiles.map(({ path }) => path)])
  expect(JSON.parse(files.get("plugin.json") ?? "")).toMatchObject({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "holyagent",
    version: "0.4.0-dev.test",
  })
  for (const { path, content } of codexSkillFiles) expect(files.get(path)).toBe(content)
  expect((await exportWith(["--output", join(fixture.directory, "second.zip")])).code).toBe(0)
  expect(Buffer.from(await Bun.file(join(fixture.directory, "second.zip")).arrayBuffer())).toEqual(
    archive,
  )
  expect(await readdir(profile)).toEqual(["config.toml"])
})

test("invalid or occupied destinations and managed homes are preserved", async () => {
  const existing = join(fixture.directory, "keep.zip")
  await Bun.write(existing, "keep these bytes")
  for (const args of [
    ["--output", existing],
    ["--output", existing, "--dry-run"],
    ["--output", "not-an-archive.txt"],
    ["--output", "missing/next.zip"],
    ["--output", join(profile, "forbidden.zip")],
  ]) {
    const result = await exportWith(args)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("! Codex Cloud export")
  }
  expect(await Bun.file(existing).text()).toBe("keep these bytes")
  expect(await readdir(profile)).toEqual(["config.toml"])
  expect(await Bun.file(join(fixture.directory, "missing", "next.zip")).exists()).toBe(false)
})

test.skipIf(process.platform === "win32")(
  "refuses a symlink destination and a parent alias to a profile",
  async () => {
    const existing = join(profile, "config.toml")
    await symlink(existing, join(fixture.directory, "symlink.zip"))
    expect((await exportWith(["--output", "symlink.zip"])).code).toBe(1)
    expect(await Bun.file(existing).text()).toBe("# Unchanged\n")
    await symlink(profile, join(fixture.directory, "alias"), "dir")
    expect((await exportWith(["--output", "alias/export.zip"])).code).toBe(1)
    expect(await readdir(profile)).toEqual(["config.toml"])
  },
)

test("refuses a not-yet-created Codex home under an aliased parent", async () => {
  const physical = join(fixture.directory, "physical")
  const alias = join(fixture.directory, "profile-alias")
  await mkdir(physical)
  await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir")
  const reserved = join(alias, "future.zip")
  for (const args of [
    ["--output", join(physical, "future.zip")],
    ["--output", join(physical, "future.zip"), "--dry-run"],
  ]) {
    const result = await exportWith(args, "public", reserved)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("outside Codex profile directories")
  }
  expect(await readdir(physical)).toEqual([])
  expect((await exportWith(["--output", "allowed.zip"], "public", reserved)).code).toBe(0)
})

test("concurrent exports cannot overwrite and the agent surface does not expose the command", async () => {
  const results = await Promise.all([
    exportWith(["--output", "race.zip"]),
    exportWith(["--output", "race.zip"]),
  ])
  expect(results.map(({ code }) => code).sort((a, b) => a - b)).toEqual([0, 1])
  expect(
    contents(Buffer.from(await Bun.file(join(fixture.directory, "race.zip")).arrayBuffer())).size,
  ).toBe(3)
  expect((await exportWith(["--output", "not-for-agents.zip"], "agent")).code).toBe(2)
  expect(await Bun.file(join(fixture.directory, "not-for-agents.zip")).exists()).toBe(false)
})
