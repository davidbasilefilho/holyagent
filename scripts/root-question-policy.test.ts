import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { FAMILIES, INSTRUCTIONS_ROOT } from "../packages/runtime/src/instructions/families.ts"

const sets = ["requirements", ...FAMILIES]

describe.each(sets)("root question policy: %s", (set) => {
  const section = (name: string) =>
    Bun.file(join(INSTRUCTIONS_ROOT, set, "root", `${name}.md`)).text()

  test("incorporates settled free-form answers and asks only for actionable remainder", async () => {
    const text = await section("asking")
    expect(text).toMatch(/free-form/i)
    expect(text).toMatch(/settled intent and authorization/i)
    expect(text).toMatch(/material remainder/i)
    expect(text).not.toMatch(
      /without choosing an option is not a choice|as many times as it takes/i,
    )
  })

  test("delegates investigation and preserves unknown worker status", async () => {
    const text = await section("asking")
    expect(text).toMatch(
      /before escalating a question that depends on worker or repository state, delegate investigation of worker status, ownership, heartbeats and repository status/i,
    )
    expect(text).toMatch(/Unknown proves neither active nor inactive/i)
    expect(text).toMatch(/information the user can actually provide/i)
  })

  test("uses a structured tool for every question", async () => {
    const text = await section("asking")
    expect(text).toMatch(
      /(?:AskUserQuestion|structured question tool|ask_user_question)[^.]*every type of question/i,
    )
  })

  test("carries scoped approval context without claiming trusted inheritance", async () => {
    const text = await section("delegating")
    expect(text).toMatch(/approval context, its exact scope and provenance/i)
    expect(text).toMatch(/unverified runtime inheritance/i)
    expect(text).toMatch(/unresolved host boundary/i)
  })

  test("distinguishes user denial from automated rejection without bypass", async () => {
    const text = await section("identity")
    expect(text).toMatch(/explicit user denial/i)
    expect(text).toMatch(/automatic tool rejection/i)
    expect(text).toMatch(/exact blocked effect and existing authorization/i)
    expect(text).toMatch(/fresh scoped approval when it can resolve the block/i)
    expect(text).toMatch(/required approval is obtained and any host restriction is resolved/i)
    expect(text).toMatch(
      /never work around an unresolved denial through another tool, script, or link/i,
    )
    expect(text).toMatch(/host rejects a retry, stop and report the exact tool payload and reason/i)
  })
})
