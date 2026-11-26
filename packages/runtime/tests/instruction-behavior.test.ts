import { expect, test } from "bun:test"
import { join } from "node:path"

import { PI_ROOT_PROMPTS } from "../src/pi/root-prompt.ts"
import { CODEX_STARTUP_GUIDANCE, codexMarketplaceFiles } from "../src/setup/codex/assets.ts"

const claude = join(import.meta.dir, "../../integrations/claude/dist/agents/holyagent.md")
const workflow = codexMarketplaceFiles().find(({ path }) =>
  path.endsWith("holyagent-workflow/SKILL.md"),
)

test("each root receives one recovery rule without giving it additional authority", async () => {
  const prompts = [
    await Bun.file(claude).text(),
    ...Object.values(PI_ROOT_PROMPTS),
    CODEX_STARTUP_GUIDANCE,
  ]
  for (const text of prompts) {
    expect(text.match(/^## Recover existing work$/gm)).toHaveLength(1)
    expect(text).toMatch(/accessible prior|existing, accessible|accessible past/i)
    expect(text).toContain("authorized destination")
    expect(text).toContain("Keep access, approval and sandbox boundaries")
  }
})

test("effective root guidance keeps independent work moving while rejecting overlapping authority", async () => {
  const prompts = [await Bun.file(claude).text(), ...Object.values(PI_ROOT_PROMPTS)]
  for (const text of prompts) {
    expect(text).toContain("Keep simultaneous edits on disjoint paths")
    expect(text).toContain("stop that dispatch")
    expect(text).toContain("Proceed with authorized direct or independent work")
    expect(text).toContain("Use native steering for a material correction or handoff")
    expect(text).not.toContain("no polling, steering")
    expect(text).toContain("Recheck head, approvals and checks before merging")
  }
  expect(workflow?.content).toContain("resolves ownership conflicts")
  expect(workflow?.content).toContain("Stop work whose authorization was withdrawn")
  expect(workflow?.content).toContain(
    "a missing required check or an unresolved review is not merge-ready",
  )
})
