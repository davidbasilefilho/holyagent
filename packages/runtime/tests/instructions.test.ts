import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { Effect } from "effect"

import { ROUTES } from "../src/domain/route.ts"
import { FAMILIES, type Family } from "../src/instructions/families.ts"
import { skillFiles } from "../src/instructions/skills.ts"

const INSTRUCTIONS = join(import.meta.dir, "../src/instructions")

/** The frontmatter keys claude.ai accepts in a skill. */
const SKILL_KEYS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"]

/** Every instruction file under the family and requirements folders, guides included. */
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

/** The placeholder through which the Kimi text names the HolyAgent CLI; the Pi extension fills it. */
const PI_CLI = "${HOLYAGENT_PI_ROOT}/scripts/holyagent"

/**
 * The checks of how a family's text starts the bundled CLI, given the family's files. Each family
 * names the CLI in one form only, so a project's `.env` and `bunfig.toml` stay out of it.
 */
const CLI_CHECKS: Record<Family, (files: ReadonlyArray<string>) => void> = {
  "claude-5.5": (files) => {
    const invocations = files.flatMap((path) =>
      [...read(path).matchAll(/\bbun\b([^`\n]*?)\s"[^"\n]*holyagent\.js"/g)].map((match) => ({
        path,
        flags: match[1] ?? "",
      })),
    )
    expect(invocations.length).toBeGreaterThanOrEqual(2)
    for (const { path, flags } of invocations) {
      expect({ path, noEnvFile: flags.includes("--no-env-file") }).toEqual({
        path,
        noEnvFile: true,
      })
      expect({
        path,
        config: /--config="\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/empty-bunfig\.toml"/.test(flags),
      }).toEqual({
        path,
        config: true,
      })
    }
    // Every mention of the script is one of the invocations checked above.
    for (const path of files)
      expect({ path, mentions: read(path).match(/holyagent\.js/g)?.length ?? 0 }).toEqual({
        path,
        mentions: invocations.filter((invocation) => invocation.path === path).length,
      })
  },
  "kimi-k3.1": (files) => {
    // The wrapper sets the flags, so the text only has to reach it through the one placeholder.
    const mentions = files.flatMap((path) =>
      [...read(path).matchAll(/\S*scripts\/holyagent\S*/g)].map((match) => ({
        path,
        form: match[0].replace(/^["'`(]+|[`"').,;:]+$/g, ""),
      })),
    )
    expect(mentions.length).toBeGreaterThanOrEqual(3)
    for (const { path, form } of mentions) expect({ path, form }).toEqual({ path, form: PI_CLI })
    // Skills are shipped as written and nothing fills a placeholder in them; the wrapper's own
    // flags and Claude's path variable have no place in this text.
    for (const path of files) {
      const text = read(path)
      expect({
        path,
        found: /holyagent\.js|--no-env-file|CLAUDE_PLUGIN_ROOT/.exec(text)?.[0],
      }).toEqual({
        path,
        found: undefined,
      })
      if (path.includes("/skills/"))
        expect({ path, placeholder: text.includes("HOLYAGENT_PI_ROOT") }).toEqual({
          path,
          placeholder: false,
        })
    }
  },
  "gpt-6": (files) => {
    // The host that runs this family is not wired yet, so the text names the CLI as a bare
    // `holyagent <command>` and carries no wrapper path, flag or placeholder of another host.
    const invoking = files.filter((path) =>
      /`holyagent (?:rg|fd|vcs|assignment)\b/.test(read(path)),
    )
    expect(invoking.length).toBeGreaterThanOrEqual(3)
    for (const path of files)
      expect({
        path,
        found:
          /scripts\/holyagent|holyagent\.js|--no-env-file|CLAUDE_PLUGIN_ROOT|HOLYAGENT_PI_ROOT/.exec(
            read(path),
          )?.[0],
      }).toEqual({ path, found: undefined })
  },
}

describe.each(FAMILIES)("instruction sources of family %s", (family) => {
  const FAMILY = join(INSTRUCTIONS, family)

  test("hold the root, the specialist conduct, a role per route, skills and requirements", () => {
    expect(FILES.length).toBeGreaterThan(0)
    for (const folder of ["root", "specialist"])
      expect(readdirSync(join(FAMILY, folder)).length).toBeGreaterThan(0)
    for (const folder of ["root", "specialist", "roles", "skills"])
      expect(readdirSync(join(INSTRUCTIONS, "requirements", folder)).length).toBeGreaterThan(0)
  })

  test("have one role file for each route and no other", () => {
    const roles = readdirSync(join(FAMILY, "roles")).toSorted()
    expect(roles).toEqual(ROUTES.map((route) => route.agent).toSorted())
    for (const role of roles)
      for (const section of readdirSync(join(FAMILY, "roles", role)))
        expect(read(join(FAMILY, "roles", role, section)).trim()).not.toBe("")
  })

  test("give each skill a folder named after it and only the frontmatter keys claude.ai accepts", () => {
    const skills = readdirSync(join(FAMILY, "skills"))
    expect(skills.toSorted()).toEqual([
      "ci-watch",
      "desktop-design",
      "dev-server",
      "documentation-lookup",
      "evidence-judging",
      "instruction-writing",
      "mobile-design",
      "performance-iteration",
      "state-mode",
      "tui-design",
      "user-busy",
      "visual-judging",
      "web-design",
    ])
    for (const skill of skills) {
      const text = read(join(FAMILY, "skills", skill, "SKILL.md"))
      const keys = frontmatterKeys(text)
      expect(keys).toBeDefined()
      for (const key of keys ?? []) expect(SKILL_KEYS).toContain(key)
      expect(keys).toContain("name")
      expect(keys).toContain("description")
      expect(text).toContain(`name: ${skill}\n`)
    }
  })

  test("assembles iteration guidance for the shared harness skill pipeline", async () => {
    const skills = await Effect.runPromise(skillFiles(family, () => "test source"))
    expect(read(join(FAMILY, "root/delegating.md"))).toContain("load `performance-iteration`")
    expect(read(join(FAMILY, "root/delegating.md"))).toContain(
      "accept the collected baseline before any task source-writing dispatch",
    )
    const routing = read(join(FAMILY, "root/skills.md"))
    expect(routing).toContain("load it at visual task start")
    expect(routing).toContain(
      "complete and accept baseline collection before dispatching any task source-writing Assignment",
    )
    expect(routing).toContain("the baseline collector may be dispatched first")
    const performance = skills.find((skill) => skill.path === "performance-iteration/SKILL.md")
    expect(performance?.content).toContain("immediately previous commit")
    expect(performance?.content).toContain("Before any task source edits")
    expect(performance?.content).toContain("After the root creates each source commit")
    expect(performance?.content).toContain("before independent review, acceptance or push")
    expect(performance?.content).toContain("outside the source commit")
    const visual = skills.find((skill) => skill.path === "visual-judging/SKILL.md")
    expect(visual?.content).toContain("Before any task source edits")
    expect(visual?.content).toContain("After the root creates each source commit")
    expect(visual?.content).toContain("before independent review, acceptance or push")
    expect(visual?.content).toContain("outside the source commit")
    const design = skills.find((skill) => skill.path === "web-design/SKILL.md")
    expect(design?.content).toContain("fluid component and route animation")
  })

  test("start the bundled CLI only in the form the family documents", () => {
    CLI_CHECKS[family](instructionFiles(FAMILY))
  })
})

describe("instruction sources", () => {
  test("refer to no skill that has been folded into the root rules or the CLI help", () => {
    for (const path of FILES)
      expect({
        path,
        found:
          /\b(grill-me|continue-work|stacks-and-ci)\b|`assignments` skill|`(merge-ready|interface-inspection)` skill/.exec(
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
