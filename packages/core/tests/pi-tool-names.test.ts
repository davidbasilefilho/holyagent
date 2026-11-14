import { expect, test } from "bun:test"

import { canonicalPiToolName } from "../src/domain/host.ts"
import { toolMatches } from "../src/pi/tools.ts"

test("unknown Pi tool names preserve their exact strings, including inherited object keys", () => {
  for (const name of [
    "constructor",
    "toString",
    "__proto__",
    "valueOf",
    "hasOwnProperty",
    "unknown",
    "",
  ]) {
    expect(canonicalPiToolName(name)).toBe(name)
    expect(toolMatches(name, name)).toBe(true)
    expect(toolMatches("Agent", name)).toBe(false)
  }
})

test("known names and aliases still match the same permission patterns", () => {
  for (const [original, alias] of [
    ["Agent", "agent"],
    ["SubagentWorkflow", "subagent_workflow"],
    ["fff-multi-grep", "fff_multi_grep"],
  ] as const) {
    expect(canonicalPiToolName(alias)).toBe(original)
    expect(canonicalPiToolName(original)).toBe(original)
    expect(toolMatches(original, alias)).toBe(true)
    expect(toolMatches(alias, original)).toBe(true)
  }
})
