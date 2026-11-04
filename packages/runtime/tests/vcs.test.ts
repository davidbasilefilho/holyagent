import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"

import { looksLikeAgent } from "../src/vcs/identity.ts"
import { cleanup, fakeGitHub, initRepo, put, seed, sh, toon, vcs } from "./vcs-fixtures.ts"

// Tests that run git processes: process creation on Windows is slow enough on the CI runner to pass
// Bun's 5 second default, and a slow test there is not a hung one. Linux and macOS keep the default.
if (process.platform === "win32") setDefaultTimeout(60_000)
afterAll(() => setDefaultTimeout(5_000))

afterEach(cleanup)

const commitA = (dir: string, extra: ReadonlyArray<string> = ["-m", "Change a"]) =>
  vcs(dir, ["vcs", "commit", ...extra, "--", "a.txt"], fakeGitHub().layer)

describe("which identity is an agent's", () => {
  test.each<readonly [string, string, string, boolean]>([
    ["the agent's email", "Octo", "noreply@anthropic.com", true],
    ["the agent's email in capitals", "Octo", " NoReply@Anthropic.com ", true],
    ["the name Claude", "Claude", "octo@example.com", true],
    ["the name Claude Code", "Claude Code", "octo@example.com", true],
    ["the name Claude in lower case", " claude ", "octo@example.com", true],
    ["a person whose name starts with Claude", "Claude Dupont", "claude@dupont.example", false],
    ["a person named Claudette", "Claudette Colvin", "octo@example.com", false],
    ["another anthropic.com address", "Octo", "octo@anthropic.com", false],
  ])("%s", (_label, name, email, agent) => {
    expect(looksLikeAgent({ name, email })).toBe(agent)
  })
})

describe("vcs commit with a person who is named Claude", () => {
  test("commits as Claude Dupont, who is not the agent", async () => {
    const dir = await initRepo({ name: "Claude Dupont", email: "claude@dupont.example" })
    await seed(dir, { "a.txt": "a\n" })
    await put(dir, { "a.txt": "a2\n" })

    const done = toon(await commitA(dir))

    expect(done).toMatchObject({ files: 1 })
    expect((await sh(dir, ["git", "log", "-1", "--format=%an <%ae>"])).trim()).toBe(
      "Claude Dupont <claude@dupont.example>",
    )
  })

  test("still refuses the name Claude Code", async () => {
    const dir = await initRepo({ name: "Claude Code", email: "octo@example.com" })
    await seed(dir, { "a.txt": "a\n" })
    await put(dir, { "a.txt": "a2\n" })

    const result = await commitA(dir)

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: AgentIdentity")
  })

  test("keeps the co-author Claude Monet and drops the agent's trailer", async () => {
    const dir = await initRepo({ name: "Octo", email: "octo@example.com" })
    await seed(dir, { "a.txt": "a\n" })
    await put(dir, { "a.txt": "a2\n" })

    toon(
      await commitA(dir, [
        "-m",
        "Change a",
        "-m",
        "Co-authored-by: Claude Monet <monet@example.com>\nCo-authored-by: Claude Code <noreply@anthropic.com>",
      ]),
    )

    expect((await sh(dir, ["git", "log", "-1", "--format=%B"])).trim()).toBe(
      "Change a\n\nCo-authored-by: Claude Monet <monet@example.com>",
    )
  })
})

describe("vcs commit with a message that starts with dashes", () => {
  test("-m takes no value that starts with --, and --message=<text> passes one on purpose", async () => {
    const dir = await initRepo({ name: "Octo", email: "octo@example.com" })
    await seed(dir, { "a.txt": "a\n" })
    await put(dir, { "a.txt": "a2\n" })
    const before = (await sh(dir, ["git", "rev-parse", "HEAD"])).trim()

    const refused = await commitA(dir, ["-m", "--- headline"])

    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain("Flag -m needs a value")
    expect((await sh(dir, ["git", "rev-parse", "HEAD"])).trim()).toBe(before)

    toon(await commitA(dir, ["--message=--- headline"]))
    expect((await sh(dir, ["git", "log", "-1", "--format=%s"])).trim()).toBe("--- headline")
  })
})
