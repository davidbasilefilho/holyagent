import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { ROUTES } from "../src/domain/route.ts"

const INSTRUCTIONS = join(import.meta.dir, "../src/instructions")
const CLAUDE = join(INSTRUCTIONS, "claude-5.5")

/** The frontmatter keys claude.ai accepts in a skill. */
const SKILL_KEYS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"]

/** Every instruction file under the claude-5.5 and requirements folders. */
const instructionFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? instructionFiles(join(directory, entry.name))
      : entry.name.endsWith(".md")
        ? [join(directory, entry.name)]
        : [],
  )

const FILES = instructionFiles(INSTRUCTIONS)
const read = (path: string) => readFileSync(path, "utf8")

/** The top-level keys of a file's frontmatter, or undefined when it has none. */
const frontmatterKeys = (text: string): ReadonlyArray<string> | undefined => {
  const lines = text.split("\n")
  if (lines[0] !== "---") return undefined
  const end = lines.indexOf("---", 1)
  return lines.slice(1, end).flatMap((line) => /^([A-Za-z][\w-]*):/.exec(line)?.[1] ?? [])
}

describe("instruction sources", () => {
  test("hold the root, the specialist conduct, a role per route, skills and requirements", () => {
    expect(FILES.length).toBeGreaterThan(0)
    for (const name of ["root.md", "specialist.md"])
      expect(read(join(CLAUDE, name)).length).toBeGreaterThan(0)
    for (const name of ["mergeability.md", "commit-text.md", "cache.md"])
      expect(read(join(INSTRUCTIONS, "requirements", name)).length).toBeGreaterThan(0)
  })

  test("have one role file for each route and no other", () => {
    const roles = readdirSync(join(CLAUDE, "roles")).toSorted()
    expect(roles).toEqual(ROUTES.map((route) => `${route.agent}.md`).toSorted())
    for (const role of roles) expect(read(join(CLAUDE, "roles", role)).trim()).not.toBe("")
  })

  test("give each skill a folder named after it and only the frontmatter keys claude.ai accepts", () => {
    const skills = readdirSync(join(CLAUDE, "skills"))
    expect(skills.toSorted()).toEqual(["interface-inspection", "merge-ready"])
    for (const skill of skills) {
      const text = read(join(CLAUDE, "skills", skill, "SKILL.md"))
      const keys = frontmatterKeys(text)
      expect(keys).toBeDefined()
      for (const key of keys ?? []) expect(SKILL_KEYS).toContain(key)
      expect(keys).toContain("name")
      expect(keys).toContain("description")
      expect(text).toContain(`name: ${skill}\n`)
    }
  })

  test("refer to no skill that has been folded into the root rules or the CLI help", () => {
    for (const path of FILES)
      expect({
        path,
        found: /\b(grill-me|continue-work|stacks-and-ci)\b|`assignments` skill/.exec(
          read(path),
        )?.[0],
      }).toEqual({
        path,
        found: undefined,
      })
  })

  test("hold no dates, times or other time-varying text, so prompts stay cache-stable", () => {
    const varying = [
      /\b\d{4}-\d{2}-\d{2}\b/,
      /\b20\d{2}\b/,
      /\b\d{1,2}:\d{2}\b/,
      /\b(today|yesterday|tomorrow)\b/i,
    ]
    for (const path of FILES)
      for (const pattern of varying)
        expect({ path, found: pattern.exec(read(path))?.[0] }).toEqual({ path, found: undefined })
  })

  test("never mention the predecessor product", () => {
    for (const path of FILES)
      expect({ path, found: /holyclaude/i.test(read(path)) }).toEqual({ path, found: false })
  })
})
