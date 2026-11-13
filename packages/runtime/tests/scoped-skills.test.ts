import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { ROUTES } from "../src/domain/route.ts"
import { FAMILIES } from "../src/instructions/families.ts"
import {
  guidanceRouter,
  OWNED_GUIDANCE,
  skillFiles,
  validateOwnedGuidance,
} from "../src/instructions/skills.ts"

describe("owned guidance routing", () => {
  test.each(FAMILIES)("maps every and only relevant path for each role in %s", async (family) => {
    const files = await Effect.runPromise(skillFiles(family, (source) => source))
    expect(() => validateOwnedGuidance(files)).not.toThrow()
    for (const role of ["root", ...ROUTES.map((route) => route.roleTask)]) {
      const router = guidanceRouter(role, family, "/package")
      if (role !== "root" && OWNED_GUIDANCE.some((entry) => entry.roles.includes(role)))
        expect(router).toContain("Read the relevant guidance when its situation applies.")
      if (role === "root")
        expect(router).not.toContain("Read the relevant guidance when its situation applies.")
      for (const entry of OWNED_GUIDANCE) {
        const path = `/package/guidance/${family}/${entry.name}/SKILL.md`
        expect(router.includes(path)).toBe(entry.roles.includes(role))
        if (entry.roles.includes(role))
          expect(files.some((file) => file.path === `${entry.name}/SKILL.md`)).toBe(true)
      }
    }
    expect(guidanceRouter("root", family, "/package")).toContain(
      "before any visual-task writer, source edit or visual specialist dispatch",
    )
    expect(guidanceRouter("root", family, "/package")).toContain(
      "Delegate library documentation lookup",
    )
  })

  test("rejects an unmapped skill and a missing mapped skill", async () => {
    const files = await Effect.runPromise(skillFiles("claude-5.5", (source) => source))
    expect(() =>
      validateOwnedGuidance([...files, { path: "performance/SKILL.md", content: "" }]),
    ).toThrow("no routing map entry")
    expect(() =>
      validateOwnedGuidance(files.filter((file) => file.path !== "ci-watch/SKILL.md")),
    ).toThrow("is missing")
  })
})
