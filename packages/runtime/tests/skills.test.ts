import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { skillFiles } from "../src/instructions/skills.ts"

const roots: string[] = []

/** A root holding one family with the shared sources and the given skill files. */
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "skills-"))
  roots.push(root)
  const family = join(root, "claude-5.5")
  await mkdir(join(family, "shared"), { recursive: true })
  await mkdir(join(family, "design-core"), { recursive: true })
  await writeFile(join(family, "shared", "materiality.md"), "definition\n")
  await writeFile(join(family, "design-core", "core.md"), "core\n")
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("the skill files", () => {
  test("leave out dotfiles, dot folders and symbolic links, and ship the rest", async () => {
    const root = await makeRoot()
    const skills = join(root, "claude-5.5", "skills")
    await mkdir(join(skills, "a", "refs"), { recursive: true })
    await mkdir(join(skills, ".hidden"), { recursive: true })
    await mkdir(join(skills, "outside"), { recursive: true })
    await writeFile(join(skills, "a", "SKILL.md"), "---\nname: a\n---\nbody\n")
    await writeFile(join(skills, "a", "refs", "guide.md"), "guide")
    await writeFile(join(skills, "a", ".DS_Store"), "junk")
    await writeFile(join(skills, ".hidden", "SKILL.md"), "---\nname: hidden\n---\n")
    await writeFile(join(skills, "outside", "target.md"), "target")
    await symlink(join(skills, "outside", "target.md"), join(skills, "a", "link.md"))
    await symlink(join(skills, "outside"), join(skills, "a", "linked"))

    const files = await Effect.runPromise(skillFiles("claude-5.5", (source) => source, root))

    expect(files.map(({ path }) => path)).toEqual([
      "a/SKILL.md",
      "a/refs/guide.md",
      "outside/target.md",
    ])
  })
})
