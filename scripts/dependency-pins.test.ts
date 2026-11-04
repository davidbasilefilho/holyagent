import { describe, expect, test } from "bun:test"

import {
  caretRange,
  newestRelease,
  newestTag,
  packageDependencies,
  parseActionUses,
  parseMiseTools,
  parseRelease,
  parseTags,
  parseVendoredVersion,
  releaseOfTag,
  rewriteActionUses,
  rewriteMiseTools,
  rewriteVendoredTool,
  withPackageRanges,
} from "./dependency-pins.ts"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)

describe("parseRelease", () => {
  test.each(["1.2.3", "0.0.1", "2026.10.24"])("%s is a stable release", (text) => {
    expect(parseRelease(text)).toBeDefined()
  })

  test.each([
    "1.2.3-rc.1",
    "1.2.3-0",
    "1.2.3+build",
    "v1.2.3",
    "1.2",
    "01.2.3",
    "1.2.3.4",
    "latest",
  ])("%s is not a stable release", (text) => {
    expect(parseRelease(text)).toBeUndefined()
  })
})

describe("newestRelease", () => {
  test("picks the newest stable release, comparing numbers and not text", () => {
    expect(newestRelease(["1.9.0", "1.10.0", "1.2.0"])).toBe("1.10.0")
  })

  test("moves to the newest major line, and to the newest release inside it", () => {
    expect(newestRelease(["1.4.0", "2.0.0", "2.3.1", "2.3.0"])).toBe("2.3.1")
  })

  test("never picks a prerelease, even when it is newer than every stable release", () => {
    expect(newestRelease(["1.2.0", "2.0.0-rc.1", "2.0.0-beta.3", "1.9.9"])).toBe("1.9.9")
  })

  test("ignores strings that are not versions", () => {
    expect(newestRelease(["next", "canary", "1.0.0"])).toBe("1.0.0")
  })

  test("is undefined when nothing is stable", () => {
    expect(newestRelease(["1.0.0-rc.1", "latest"])).toBeUndefined()
    expect(newestRelease([])).toBeUndefined()
  })
})

describe("caretRange", () => {
  test.each([
    ["4.0.6", "^4.0.0"],
    ["1.0.0", "^1.0.0"],
    ["2026.10.24", "^2026.0.0"],
    ["0.5.3", "^0.5.0"],
    ["0.12.0", "^0.12.0"],
    ["0.0.7", "^0.0.7"],
  ])("%s is the line %s", (release, range) => {
    expect(caretRange(release)).toBe(range)
  })

  test("refuses a prerelease", () => {
    expect(() => caretRange("2.0.0-rc.1")).toThrow()
  })
})

describe("tags", () => {
  const output = [
    `${SHA_A}\trefs/tags/v7`,
    `${SHA_A}\trefs/tags/v7.0.1`,
    `${SHA_B}\trefs/tags/v7.1.0-beta.1`,
    `${SHA_A}\trefs/tags/v6.0.3`,
    `${SHA_B}\trefs/tags/v6.0.3^{}`,
    `${SHA_B}\trefs/tags/wincolor-0.1.6`,
    "not a tag line",
  ].join("\n")

  test("an annotated tag resolves to the commit it points at", () => {
    expect(parseTags(output).find((tag) => tag.name === "v6.0.3")?.sha).toBe(SHA_B)
  })

  test("only X.Y.Z tags with the prefix count: not floating, prerelease or foreign tags", () => {
    expect(newestTag(parseTags(output), "v")).toEqual({
      release: "7.0.1",
      tag: { name: "v7.0.1", sha: SHA_A },
    })
    expect(releaseOfTag("v7", "v")).toBeUndefined()
    expect(releaseOfTag("bun-v1.4.4", "bun-v")).toBe("1.4.4")
    expect(releaseOfTag("15.2.0", "")).toBe("15.2.0")
  })
})

describe("workflow actions", () => {
  const workflow = [
    "steps:",
    `  - uses: actions/checkout@${SHA_A} # v7.0.1`,
    `    uses: jdx/mise-action/sub@${SHA_A} # v5.1.2`,
    "  - uses: ./.github/actions/tag-release",
    "",
  ].join("\n")

  test("reads pinned external actions and skips local ones", () => {
    expect(parseActionUses(workflow)).toEqual([
      { repository: "actions/checkout", sha: SHA_A, version: "v7.0.1" },
      { repository: "jdx/mise-action", sha: SHA_A, version: "v5.1.2" },
    ])
  })

  test("moves the commit and the version comment of the named actions only", () => {
    const result = rewriteActionUses(
      workflow,
      new Map([["jdx/mise-action", { sha: SHA_B, version: "v5.2.6" }]]),
    )
    expect(result).toContain(`uses: jdx/mise-action/sub@${SHA_B} # v5.2.6`)
    expect(result).toContain(`uses: actions/checkout@${SHA_A} # v7.0.1`)
    expect(result).toContain("uses: ./.github/actions/tag-release")
  })
})

describe("mise tools", () => {
  const text = [
    "[tools]",
    "# a comment",
    'node = "lts"',
    'bun = "1.4.4"',
    "",
    "[hooks]",
    'postinstall = "bun scripts/toolchain.ts upgrade"',
    "",
  ].join("\n")

  test("reads only the tools table, channels included", () => {
    expect(parseMiseTools(text)).toEqual([
      { name: "node", version: "lts" },
      { name: "bun", version: "1.4.4" },
    ])
  })

  test("rewrites the named tool and nothing else", () => {
    expect(rewriteMiseTools(text, new Map([["bun", "1.5.0"]]))).toBe(
      text.replace('"1.4.4"', '"1.5.0"'),
    )
  })
})

describe("vendored tools", () => {
  const hash = (letter: string) => letter.repeat(64)
  const source = [
    "/**",
    " * Ripgrep 15.2.0, from https://example.test/releases/tag/15.2.0.",
    " */",
    'const RIPGREP_VERSION = "15.2.0"',
    "",
    "const ripgrep = (id: string) => id",
    "export const ASSETS = [",
    "  ripgrep(",
    '    "linux-x64",',
    '    "x86_64-unknown-linux-musl",',
    '    "tar.gz",',
    `    "${hash("1")}",`,
    `    "${hash("2")}",`,
    "  ),",
    "  fd(",
    '    "linux-x64",',
    '    "x86_64-unknown-linux-musl",',
    '    "tar.gz",',
    `    "${hash("3")}",`,
    `    "${hash("4")}",`,
    "  ),",
    "]",
  ].join("\n")

  test("reads the version of a tool", () => {
    expect(parseVendoredVersion(source, "ripgrep")).toBe("15.2.0")
    expect(parseVendoredVersion(source, "fd")).toBeUndefined()
  })

  test("moves the version, its doc comment and both hashes of the tool, and not the other tool", () => {
    const result = rewriteVendoredTool(
      source,
      "ripgrep",
      "15.3.0",
      new Map([["linux-x64", { archive: hash("a"), binary: hash("b") }]]),
    )
    expect(result).toContain('const RIPGREP_VERSION = "15.3.0"')
    expect(result).toContain("Ripgrep 15.3.0, from https://example.test/releases/tag/15.3.0.")
    expect(result).toContain(`"${hash("a")}",\n    "${hash("b")}",`)
    expect(result).toContain(`"${hash("3")}",\n    "${hash("4")}",`)
    expect(result).not.toContain("15.2.0")
  })

  test("fails when a target has no pin, so a half-moved pin is never written", () => {
    expect(() =>
      rewriteVendoredTool(
        source,
        "ripgrep",
        "15.3.0",
        new Map([["darwin-arm64", { archive: hash("a"), binary: hash("b") }]]),
      ),
    ).toThrow("darwin-arm64")
  })
})

describe("package dependencies", () => {
  const manifest = {
    name: "x",
    dependencies: { effect: "^4.0.0", "@holyagent/runtime": "workspace:*", alias: "npm:other@1" },
    devDependencies: { mise: "2026.10.24" },
    overrides: { acorn: "8.19.0" },
    scripts: { build: "x" },
  }

  test("lists registry ranges of every dependency field, not workspace or aliased ones", () => {
    expect(packageDependencies(manifest)).toEqual([
      { field: "dependencies", name: "effect", range: "^4.0.0" },
      { field: "devDependencies", name: "mise", range: "2026.10.24" },
      { field: "overrides", name: "acorn", range: "8.19.0" },
    ])
  })

  test("sets ranges by field and name and keeps the rest", () => {
    const result = withPackageRanges(manifest, [
      { field: "devDependencies", name: "mise", range: "^2026.0.0" },
    ])
    expect(result["devDependencies"]).toEqual({ mise: "^2026.0.0" })
    expect(result["dependencies"]).toEqual(manifest.dependencies)
    expect(Object.keys(result)).toEqual(Object.keys(manifest))
  })
})
