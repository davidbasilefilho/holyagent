import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { ROOT_SECTIONS } from "../../../integrations/claude/src/agents.ts"
import { PI_ROOT_CORE, PI_ROOT_PLACEHOLDER } from "../../src/hooks/pi-context.ts"
import { INSTRUCTIONS_PATH } from "../../src/instructions/skills.ts"
import { PI_ROOT_PROMPT, PI_ROOT_PROMPTS, PI_ROOT_SECTIONS } from "../../src/pi/root-prompt.ts"

const ROOT_FOLDER = join(import.meta.dir, "../../..", "..", INSTRUCTIONS_PATH, "kimi-k3.1", "root")

describe("the Pi root prompt", () => {
  test("has the sections of the Claude root agent, in its order", () => {
    expect(PI_ROOT_SECTIONS).toEqual(ROOT_SECTIONS)
  })

  test("names every file of the Kimi root folder, so none is left out of the prompt", async () => {
    const own = PI_ROOT_SECTIONS.filter((file) => !file.startsWith("../"))
    expect([...own].toSorted()).toEqual((await readdir(ROOT_FOLDER)).toSorted())
  })

  test("opens with the core of the root rules and holds the placeholder for the package folder", () => {
    expect(PI_ROOT_PROMPT.startsWith(PI_ROOT_CORE)).toBe(true)
    expect(PI_ROOT_PROMPT).toContain(PI_ROOT_PLACEHOLDER)
  })

  test("the assembled prompt offers bounded direct work and material independent review in every Pi family", () => {
    for (const prompt of Object.values(PI_ROOT_PROMPTS)) {
      expect(prompt).toContain("Handle small, low-risk work directly")
      expect(prompt).toContain("Use an independent reviewer when task complexity, material risk")
      expect(prompt).toContain(
        "Address optional changes only when materially useful and within scope",
      )
      expect(prompt).toContain("exact paths for authorized direct edits or accepted Assignments")
      expect(prompt).toContain("A validated vulnerability introduced or worsened")
      expect(prompt).not.toMatch(
        /Workflows run all new work|one-entry workflow|Run no gates|one more repair round|paid for on each call|cap it at|run all work through an Intent|leave implementation to specialists/i,
      )
    }
  })

  test("has no maintainers' notes and the history rules continue the version-control bullets", () => {
    expect(PI_ROOT_PROMPT).not.toContain("<!--")
    expect(PI_ROOT_PROMPT).toMatch(/\n- Never bypass hooks or signing/)
    expect(PI_ROOT_PROMPT).not.toMatch(/\n\n- Never bypass hooks or signing/)
  })
})
