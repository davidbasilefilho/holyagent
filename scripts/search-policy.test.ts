import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { INSTRUCTIONS_ROOT } from "../packages/runtime/src/instructions/families.ts"

describe.each(["gpt-6", "kimi-k3.1"])("Pi search policy: %s", (family) => {
  const section = (path: string) => Bun.file(join(INSTRUCTIONS_ROOT, family, path)).text()

  test.each([
    ["root/search.md", /shell.*`rg` and `fd`/i],
    ["specialist/working.md", /built-in `find` and `grep` through codemode/i],
  ])("keeps %s usable without FFF and reports unexpected failures", async (path, fallback) => {
    const text = await section(path)
    expect(text).toMatch(/FFF is enabled and available/i)
    expect(text).toMatch(/FFF is disabled or not offered on the host/i)
    expect(text).toMatch(fallback)
    expect(text).toMatch(/Report unexpectedly missing or failing FFF tools as a setup problem/i)
  })
})
