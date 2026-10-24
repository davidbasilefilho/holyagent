import { afterEach, describe, expect, test } from "bun:test"

import { cleanMessage, forbiddenPhrases } from "../src/vcs/message.ts"
import { cleanup, fakeGitHub, initRepo, put, seed, sh, toon, user, vcs } from "./vcs-fixtures.ts"

afterEach(cleanup)

describe("cleaning", () => {
  test("attribution trailers, generated-with lines and session links are removed", () => {
    const dirty = [
      "Fix the parser",
      "",
      "Handle nested input.",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "",
      "https://claude.ai/code/session_01ABC",
      "Co-Authored-By: Claude Sonnet <noreply@anthropic.com>",
      "Claude-Session: https://claude.ai/code/session_01ABC",
    ].join("\n")
    expect(cleanMessage(dirty)).toBe("Fix the parser\n\nHandle nested input.")
  })

  test("a link inside a sentence is cut out and the sentence stays", () => {
    expect(cleanMessage("Fix it, see https://claude.ai/code/x for context")).toBe(
      "Fix it, see  for context",
    )
  })

  test("ordinary trailers survive", () => {
    expect(cleanMessage("Fix it\n\nSigned-off-by: A <a@b.c>")).toContain("Signed-off-by")
  })
})

describe("the check", () => {
  test("whole words only, case-insensitive, with the phrase reported as the check names it", () => {
    expect(forbiddenPhrases("Do what The  User wants")).toEqual(["the user"])
    expect(forbiddenPhrases("As requested, rename it")).toEqual(["as requested"])
    expect(forbiddenPhrases("Add the claudette module and a specialization")).toEqual([])
    expect(forbiddenPhrases("Ask Claude")).toEqual(["Claude"])
    expect(forbiddenPhrases("spawn a subagent in this session")).toEqual([
      "this session",
      "subagent",
    ])
  })

  test("allowed words are skipped, whatever their case", () => {
    expect(forbiddenPhrases("Route to the Specialist", ["specialist"])).toEqual([])
    expect(forbiddenPhrases("Route to the Specialist and the user", ["SPECIALIST"])).toEqual([
      "the user",
    ])
  })
})

/** A repository with one file to commit and a GitHub where the git identity is the owner's. */
const ready = async () => {
  const dir = await initRepo({ name: "Octo", email: "42+octo@users.noreply.github.com" })
  await seed(dir, { "a.txt": "a\n" })
  await put(dir, { "a.txt": "changed\n" })
  const gh = fakeGitHub({ rest: (request) => (request.path === "user" ? user() : undefined) })
  return { dir, gh }
}

describe("vcs commit messages", () => {
  test("a message about the user or the agent is refused with exit 3 naming the phrase", async () => {
    const { dir, gh } = await ready()
    const before = (await sh(dir, ["git", "rev-parse", "HEAD"])).trim()
    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Change a as the user asked", "--", "a.txt"],
      gh.layer,
    )
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: MessageRefused")
    expect(result.stderr).toContain('"the user"')
    expect(result.stderr).toContain('"user asked"')
    expect((await sh(dir, ["git", "rev-parse", "HEAD"])).trim()).toBe(before)
  })

  test("allowWords in the project config lets a domain keep its vocabulary", async () => {
    const { dir, gh } = await ready()
    await put(dir, {
      ".holyagent/config.json": JSON.stringify({ vcs: { allowWords: ["specialist"] } }),
    })
    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Route to a specialist", "--", "a.txt"],
      gh.layer,
    )
    expect(toon(result)).toMatchObject({ path: "git" })
  })

  test("attribution is cleaned off before the check and before git sees the message", async () => {
    const { dir, gh } = await ready()
    const result = await vcs(
      dir,
      [
        "vcs",
        "commit",
        "-m",
        "Change a",
        "-m",
        "Why it matters.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/s",
        "--",
        "a.txt",
      ],
      gh.layer,
    )
    toon(result)
    expect((await sh(dir, ["git", "log", "-1", "--format=%B"])).trim()).toBe(
      "Change a\n\nWhy it matters.",
    )
  })

  test("a missing message or path is a usage error", async () => {
    const { dir, gh } = await ready()
    expect((await vcs(dir, ["vcs", "commit", "--", "a.txt"], gh.layer)).code).toBe(2)
    expect((await vcs(dir, ["vcs", "commit", "-m", "x"], gh.layer)).code).toBe(2)
  })
})
