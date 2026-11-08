import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"

import { cleanMessage, forbiddenPhrases } from "../src/vcs/message.ts"
import { cleanup, fakeGitHub, initRepo, put, scratch, seed, sh, toon, vcs } from "./vcs-fixtures.ts"

// Tests that run git processes: process creation on Windows is slow enough on the CI runner to pass
// Bun's 5 second default, and a slow test there is not a hung one. Linux and macOS keep the default.
if (process.platform === "win32") setDefaultTimeout(60_000)
afterAll(() => setDefaultTimeout(5_000))

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

  test("human co-authors stay, the agent's are removed whatever its display name", () => {
    const text = [
      "Fix it",
      "",
      "Co-authored-by: Dana Smith <dana@example.com>",
      "Co-authored-by: Claudia Reyes <claudia@example.com>",
      "co-authored-by: Claude Opus 4 <noreply@anthropic.com>",
      "Co-Authored-By: Assistant <bot@anthropic.com>",
    ].join("\n")
    expect(cleanMessage(text)).toBe(
      "Fix it\n\nCo-authored-by: Dana Smith <dana@example.com>\nCo-authored-by: Claudia Reyes <claudia@example.com>",
    )
  })

  test("the generated-with footer goes only when it is a line of its own", () => {
    expect(cleanMessage("Fix it\n\n[Generated with Claude Code]")).toBe("Fix it")
    expect(
      cleanMessage("Fix it\n\n  🤖 Generated with [Claude Code](https://claude.com/claude-code)"),
    ).toBe("Fix it")
    const prose = "Reject output Generated with Claude Code in review"
    expect(cleanMessage(`Fix it\n\n${prose}`)).toBe(`Fix it\n\n${prose}`)
  })

  // Pi adds no commit text itself. Its attribution is the name `pi` and https://pi.dev
  // (PI_ATTRIBUTION in @earendil-works/pi-ai 1.5.0, dist/utils/identity.js), and its /share command
  // links https://pi.dev/session/#<gist> (getShareViewerUrl in @earendil-works/pi-coding-agent
  // 1.5.0, dist/config.js).
  test("pi's generated-with footer, session links and co-author trailers are removed", () => {
    const dirty = [
      "Fix the parser",
      "",
      "Handle nested input.",
      "",
      "🤖 Generated with [pi](https://pi.dev)",
      "[Generated with Pi coding agent]",
      "Generated with pi-coding-agent.",
      "https://pi.dev/session/#0123abcd",
      "Co-authored-by: pi <noreply@pi.dev>",
      "Co-authored-by: Pi Coding Agent <agent@example.com>",
      "Co-Authored-By: Helper <helper@pi.dev>",
    ].join("\n")
    expect(cleanMessage(dirty)).toBe("Fix the parser\n\nHandle nested input.")
  })

  test("a pi session link inside a sentence is cut out and the sentence stays", () => {
    expect(cleanMessage("Fix it, see https://pi.dev/session/#abc for context")).toBe(
      "Fix it, see  for context",
    )
  })

  test("a session link closing a Markdown link leaves the parenthesis and the text after it", () => {
    expect(cleanMessage("fix\n\nSee [session](https://pi.dev/session/#abc) for details")).toBe(
      "fix\n\nSee [session]() for details",
    )
    expect(
      cleanMessage("fix\n\nSee [session](https://claude.ai/code/session_01) for details"),
    ).toBe("fix\n\nSee [session]() for details")
  })

  test("a long run of parentheses after the pi footer is cleaned in linear time", () => {
    const line = `Generated with pi(${")".repeat(50_000)}a`
    const started = performance.now()
    expect(cleanMessage(`Fix it\n\n${line}`)).toBe(`Fix it\n\n${line}`)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("a co-author named Pi stays unless the address is at pi.dev", () => {
    const person = "Co-authored-by: Pi <pi@example.com>"
    expect(cleanMessage(`Fix it\n\n${person}`)).toBe(`Fix it\n\n${person}`)
    expect(cleanMessage("Fix it\n\nCo-authored-by: Pi <pi@pi.dev>")).toBe("Fix it")
    expect(cleanMessage("Fix it\n\nCo-authored-by: Pi Coding Agent <agent@example.com>")).toBe(
      "Fix it",
    )
  })

  test("what only resembles pi's attribution stays", () => {
    const text = [
      "Fix it",
      "",
      "Generated with a lookup table of pi",
      "Generated with pi digits",
      "See https://pi.dev/docs for the setting",
      "Co-authored-by: Pia Lang <pia@example.com>",
      "Co-authored-by: Pi Ng <pi.ng@example.com>",
    ].join("\n")
    expect(cleanMessage(text)).toBe(text)
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
    expect(forbiddenPhrases("Ask Claude Code about it")).toEqual(["Claude Code"])
    expect(forbiddenPhrases("Generated by claude  OPUS 4")).toEqual(["Claude Opus"])
    expect(forbiddenPhrases("spawn a subagent in this session")).toEqual([
      "this session",
      "subagent",
    ])
  })

  test("ordinary words of a project that names Claude or specialists are not refused", () => {
    expect(forbiddenPhrases("Add a Claude plugin manifest and a specialist registry")).toEqual([])
    expect(forbiddenPhrases("Route to the Specialist")).toEqual([])
  })

  test("allowed words are skipped, whatever their case", () => {
    expect(forbiddenPhrases("Ask Claude Code", ["claude code"])).toEqual([])
    expect(forbiddenPhrases("Ask Claude Code and the user", ["CLAUDE CODE"])).toEqual(["the user"])
  })
})

/** A repository with one file to commit, committed to with the user's own git identity. */
const ready = async () => {
  const dir = await initRepo({ name: "Octo", email: "42+octo@users.noreply.github.com" })
  await seed(dir, { "a.txt": "a\n" })
  await put(dir, { "a.txt": "changed\n" })
  const gh = fakeGitHub()
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
      ".holyagent/config.json": JSON.stringify({ vcs: { allowWords: ["subagent"] } }),
    })
    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Route to a subagent", "--", "a.txt"],
      gh.layer,
    )
    expect(toon(result)).toMatchObject({ branch: "main" })
  })

  test("allowWords in the user file of the call's HOLYAGENT_HOME apply, not the real home's", async () => {
    const { dir, gh } = await ready()
    const home = await scratch()
    await put(home, {
      ".holyagent/config.json": JSON.stringify({ vcs: { allowWords: ["subagent"] } }),
    })
    const refused = await vcs(
      dir,
      ["vcs", "commit", "-m", "Route to a subagent", "--", "a.txt"],
      gh.layer,
    )
    expect(refused.code).toBe(3)
    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Route to a subagent", "--", "a.txt"],
      gh.layer,
      undefined,
      { HOLYAGENT_HOME: home },
    )
    expect(toon(result)).toMatchObject({ branch: "main" })
  })

  test("a bad config file in the call's home stops the commit and names that file", async () => {
    const { dir, gh } = await ready()
    const home = await scratch()
    await put(home, { ".holyagent/config.json": '{"nope":1}' })
    const before = (await sh(dir, ["git", "rev-parse", "HEAD"])).trim()
    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Change a", "--", "a.txt"],
      gh.layer,
      undefined,
      {
        HOLYAGENT_HOME: home,
      },
    )
    expect(result.code).toBe(4)
    expect(result.stderr).toContain("error: ConfigInvalid:")
    expect(result.stderr).toContain("docs/pi/configuration.md")
    expect(result.stderr).toContain(join(home, ".holyagent", "config.json"))
    expect((await sh(dir, ["git", "rev-parse", "HEAD"])).trim()).toBe(before)
  })

  test("the commit-msg hook reads the call's home too", async () => {
    const { dir, gh } = await ready()
    const home = await scratch()
    await put(home, {
      ".holyagent/config.json": JSON.stringify({ vcs: { allowWords: ["subagent"] } }),
    })
    await put(dir, { MSG: "Route to a subagent\n" })
    const file = join(dir, "MSG")
    expect((await vcs(dir, ["hook", "commit-msg", file], gh.layer)).code).toBe(3)
    const allowed = await vcs(dir, ["hook", "commit-msg", file], gh.layer, undefined, {
      HOLYAGENT_HOME: home,
    })
    expect(allowed.code).toBe(0)
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
