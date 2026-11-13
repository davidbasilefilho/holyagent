import { describe, expect, test } from "bun:test"

import { agentFiles } from "../packages/integrations/pi/src/agents.ts"
import { PI_ROOT_PROMPTS } from "../packages/runtime/src/pi/root-prompt.ts"

const guidance = "For human-facing prose, write directly and specifically"
const clauses = [
  guidance,
  "prefer active voice, vary sentence rhythm and cut filler and formulaic phrasing",
  "answers, messages, UI copy, documentation, PRs, reviews and reports",
  "Preserve exact evidence and error strings, machine formats, code and API semantics, and repository conventions",
  "https://github.com/hardikpandya/stop-slop",
]

describe("GPT human-facing prose guidance", () => {
  test("the root and every composed specialist receive it, without changing Kimi", async () => {
    for (const clause of clauses) expect(PI_ROOT_PROMPTS["gpt-6"]).toContain(clause)
    expect(PI_ROOT_PROMPTS["kimi-k3.1"]).not.toContain(guidance)
    const gpt = await agentFiles("gpt-6")
    expect(gpt.length).toBeGreaterThan(0)
    for (const agent of gpt) {
      for (const clause of clauses) expect(agent.content, agent.path).toContain(clause)
    }
    // The other families remain unchanged by this GPT-only requirement.
    for (const family of ["kimi-k3.1", "claude-5.5"] as const) {
      for (const agent of await agentFiles(family)) {
        expect(agent.content, agent.path).not.toContain(guidance)
      }
    }
  })
})
