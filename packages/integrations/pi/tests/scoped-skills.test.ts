import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { skillFiles } from "../../../runtime/src/instructions/skills.ts"
import { manifest } from "../src/generate.ts"

test("Pi SDK discovers an unrelated user skill but not the generated private guidance", async () => {
  const home = await mkdtemp(join(tmpdir(), "holyagent-loader-"))
  try {
    const pkg = join(home, "package")
    const agent = join(home, ".pi", "agent")
    const user = join(agent, "skills", "unrelated", "SKILL.md")
    await mkdir(dirname(user), { recursive: true })
    await writeFile(
      user,
      "---\nname: unrelated\ndescription: unrelated user skill\n---\nuser body\n",
    )
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, "package.json"), manifest().content)
    await mkdir(join(pkg, "prompts"), { recursive: true })
    await writeFile(
      join(pkg, "prompts", "package-proof.md"),
      "---\ndescription: package fixture\n---\npackage prompt\n",
    )
    for (const file of await Effect.runPromise(skillFiles("kimi-k3.1", (source) => source))) {
      const dest = join(pkg, "guidance", "kimi-k3.1", file.path)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, file.content)
    }
    await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [pkg] }))
    const sdk = Bun.resolveSync("@earendil-works/pi-coding-agent", import.meta.dir)
    const script = `import { DefaultResourceLoader } from ${JSON.stringify(sdk)};\nconst loader = new DefaultResourceLoader({ cwd: ${JSON.stringify(home)}, agentDir: ${JSON.stringify(agent)}, noExtensions: true, noThemes: true, noContextFiles: true });\nawait loader.reload(); console.log(JSON.stringify({skills: loader.getSkills().skills.map(s => s.name), prompts: loader.getPrompts().prompts.map(p => p.name)}));`
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home, USERPROFILE: home, PI_OFFLINE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(JSON.parse(stdout.trim())).toEqual({ skills: ["unrelated"], prompts: ["package-proof"] })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("Pi role prompts route only mapped family guidance and keep bodies out", async () => {
  const { ROUTES } = await import("../../../runtime/src/domain/route.ts")
  const { OWNED_GUIDANCE } = await import("../../../runtime/src/instructions/skills.ts")
  const { PI_ROOT_PROMPTS } = await import("../../../runtime/src/pi/root-prompt.ts")
  const { agentFiles } = await import("../src/agents.ts")
  for (const family of ["kimi-k3.1", "gpt-6"] as const) {
    const agents = await agentFiles(family)
    for (const route of ROUTES) {
      const prompt = agents.find((file) => file.path.endsWith(`/${route.agent}.md`))?.content ?? ""
      if (OWNED_GUIDANCE.some((entry) => entry.roles.includes(route.roleTask)))
        expect(prompt).toContain("Read the relevant guidance when its situation applies.")
      for (const entry of OWNED_GUIDANCE)
        expect(prompt.includes(`/guidance/${family}/${entry.name}/SKILL.md`)).toBe(
          entry.roles.includes(route.roleTask),
        )
      expect(prompt).not.toContain("# Library documentation lookup")
    }
    const root = PI_ROOT_PROMPTS[family]
    expect(root).toContain(`/guidance/${family}/visual-judging/SKILL.md`)
    expect(root).not.toContain("# Library documentation lookup")
  }
})

test("npm's package whitelist ships all family guidance without advertising owned skills", async () => {
  const { build } = await import("../build.ts")
  const { DIST_DIRECTORY } = await import("../src/files.ts")
  const root = await mkdtemp(join(tmpdir(), "holyagent-npm-pack-"))
  try {
    const files = await build(root)
    const pkg = join(root, DIST_DIRECTORY)
    const manifest = JSON.parse(await Bun.file(join(pkg, "package.json")).text()) as {
      pi: Record<string, unknown>
    }
    expect(manifest.pi).not.toHaveProperty("skills")
    const child = Bun.spawn(
      [
        "npm",
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--offline",
        "--cache",
        join(root, "cache"),
      ],
      {
        cwd: pkg,
        env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit, err).toBe(0)
    const packed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>
    const paths = packed[0]?.files.map(({ path }) => path).toSorted() ?? []
    const expected = files
      .filter((file) => file.startsWith(`${DIST_DIRECTORY}/guidance/`))
      .map((file) => file.slice(`${DIST_DIRECTORY}/`.length))
      .toSorted()
    expect(expected.length).toBeGreaterThan(0)
    expect(paths.filter((path) => path.startsWith("guidance/"))).toEqual(expected)
    expect(paths.some((path) => path.startsWith("skills/"))).toBe(false)
    for (const family of ["gpt-6", "kimi-k3.1"])
      expect(paths).toContain(`guidance/${family}/documentation-lookup/SKILL.md`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
