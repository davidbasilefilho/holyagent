import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { FAMILIES } from "../src/instructions/families.ts"
import {
  DESIGN_CORE_MARKER,
  MATERIALITY_MARKER,
  skillFiles,
  stripCitations,
} from "../src/instructions/skills.ts"

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

describe("stripCitations", () => {
  test("removes a comment after text with the spaces before it, and keeps the text around it", () => {
    expect(stripCitations("Run it. <!-- K5 --> Then stop.\nNext <!-- K6, K7 -->\n")).toBe(
      "Run it. Then stop.\nNext\n",
    )
  })

  test("removes a comment on a line of its own with the line, and one of two blank lines around it", () => {
    expect(stripCitations("one\n<!-- K3 -->\ntwo\n")).toBe("one\ntwo\n")
    expect(stripCitations("one\n\n  <!-- K3 -->\n\ntwo\n")).toBe("one\n\ntwo\n")
    expect(stripCitations("<!-- K3 -->\n\ntwo\n")).toBe("two\n")
    expect(stripCitations("one\n<!-- K3,\nK4 -->\ntwo\n")).toBe("one\ntwo\n")
  })

  test("keeps the marker lines that a generator embeds shared text at", () => {
    const text = `one\n${MATERIALITY_MARKER}\n  ${DESIGN_CORE_MARKER}\ntwo <!-- K1 -->\n`
    expect(stripCitations(text)).toBe(`one\n${MATERIALITY_MARKER}\n  ${DESIGN_CORE_MARKER}\ntwo\n`)
  })

  test("returns text without a comment as it is", () => {
    const text = "# Title\n\n\n- a  b\n\n```\ncode\n```\n"
    expect(stripCitations(text)).toBe(text)
  })

  test("strips the citations of a SKILL.md in the generated skills, embeds the marker's text and leaves other files as they are", async () => {
    const root = await makeRoot()
    const skills = join(root, "claude-5.5", "skills")
    await mkdir(join(skills, "a"), { recursive: true })
    await writeFile(
      join(skills, "a", "SKILL.md"),
      `---\nname: a\n---\n<!-- K1: why -->\nbody <!-- K2 -->\n\n${MATERIALITY_MARKER}\n`,
    )
    await writeFile(join(skills, "a", "notes.md"), "kept <!-- K3 -->\n")

    const files = await Effect.runPromise(skillFiles("claude-5.5", (source) => source, root))

    expect(files.map(({ path, content }) => ({ path, content }))).toEqual([
      {
        path: "a/SKILL.md",
        content:
          "---\n# packages/runtime/src/instructions/claude-5.5/skills/a/SKILL.md\nname: a\n---\nbody\n\ndefinition\n",
      },
      { path: "a/notes.md", content: "kept <!-- K3 -->\n" },
    ])
  })

  test.each(FAMILIES)("leaves no HTML comment in the generated skills of %s", async (family) => {
    const files = await Effect.runPromise(skillFiles(family, (source) => `from ${source}`))
    expect(files.length).toBeGreaterThan(0)
    for (const { path, content } of files.filter(({ path }) => path.endsWith("SKILL.md")))
      expect({ path, comment: /<!--/.exec(content)?.[0] }).toEqual({ path, comment: undefined })
  })
})
