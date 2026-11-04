import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { INSTRUCTIONS_DIRECTORY } from "../src/files.ts"
import {
  DESIGN_CORE_FILE,
  DESIGN_CORE_MARKER,
  DESIGN_SKILLS,
  generate,
  skillBody,
} from "../src/generate.ts"
import { ROOT } from "./built.ts"

const read = (path: string) => readFileSync(join(ROOT, path), "utf8")
const generated = await generate()
const core = read(DESIGN_CORE_FILE).trim()
const skill = (name: string) =>
  generated.find((file) => file.path.endsWith(`skills/${name}/SKILL.md`))?.content ?? ""

/**
 * Frameworks, libraries, component kits and APIs that a stack-agnostic design skill never names,
 * matched as whole words and case-sensitively. OS, platform and design-system names stay allowed.
 */
const BANNED = [
  "React",
  "Next\\.js",
  "Vue",
  "Svelte",
  "Angular",
  "Tailwind",
  "Bootstrap",
  "shadcn",
  "Radix",
  "Electron",
  "Tauri",
  "SwiftUI",
  "UIKit",
  "AppKit",
  "Cocoa",
  "Jetpack",
  "Compose",
  "Flutter",
  "Kotlin",
  "Xamarin",
  "MAUI",
  "WinUI",
  "WPF",
  "WinForms",
  "GTK",
  "libadwaita",
  "Qt",
  "Bubble Tea",
  "Lip Gloss",
  "Ratatui",
  "Textual",
  "ncurses",
  "Blessed",
  "Dynamic Type",
  "SF Symbols",
]
const BANNED_PATTERN = new RegExp(`\\b(?:${BANNED.join("|")})\\b`)

describe("the platform design skills", () => {
  test("are four generated skills that open with the situation", () => {
    expect(DESIGN_SKILLS.toSorted()).toEqual([
      "desktop-design",
      "mobile-design",
      "tui-design",
      "web-design",
    ])
    for (const name of DESIGN_SKILLS) {
      const text = skill(name)
      expect({ name, named: text.includes(`\nname: ${name}\n`) }).toEqual({ name, named: true })
      expect({ name, opens: /^description: Use when /m.test(text) }).toEqual({ name, opens: true })
    }
  })

  test("each generated skill is self-contained at about 80 to 140 lines and carries the current shared core", () => {
    for (const name of DESIGN_SKILLS) {
      const text = skill(name)
      expect({ name, core: text.includes(core) }).toEqual({ name, core: true })
      expect({ name, marker: text.includes(DESIGN_CORE_MARKER) }).toEqual({ name, marker: false })
      const lines = text.trimEnd().split("\n").length
      expect({ name, fits: lines >= 80 && lines <= 140, lines }).toEqual({
        name,
        fits: true,
        lines,
      })
      for (const part of [
        "## Refuse list",
        "## Capture checklist",
        "Report only checks actually run",
      ])
        expect({ name, part, found: text.includes(part) }).toEqual({ name, part, found: true })
    }
  })

  test("take the shared core from its one source file, which no skill source repeats", () => {
    for (const name of DESIGN_SKILLS) {
      const source = read(`${INSTRUCTIONS_DIRECTORY}/skills/${name}/SKILL.md`)
      const markers = source.split("\n").filter((line) => line === DESIGN_CORE_MARKER)
      expect({ name, markers }).toEqual({ name, markers: [DESIGN_CORE_MARKER] })
      expect({ name, repeats: source.includes("### Spend boldness in one place") }).toEqual({
        name,
        repeats: false,
      })
    }
    const holders = generated
      .filter((file) => file.content.includes("### Spend boldness in one place"))
      .map((file) => file.path.split("/").at(-2) ?? "")
    expect(holders.toSorted()).toEqual([...DESIGN_SKILLS].toSorted())
  })

  test("fail the build when a skill outside the design list holds the core marker", () => {
    const text = `---\nname: other\n---\n${DESIGN_CORE_MARKER}\n`
    expect(() => skillBody("other/SKILL.md", text, core, "other")).toThrow("DESIGN_SKILLS")
    expect(skillBody("other/SKILL.md", "---\nname: other\n---\nbody\n", core, "other")).toContain(
      "body",
    )
    expect(skillBody("web-design/SKILL.md", text, core, "web")).toContain("### Spend boldness")
  })

  test("name no framework, library, component kit or API", () => {
    const texts: ReadonlyArray<readonly [string, string]> = [
      ["core", core],
      ...DESIGN_SKILLS.map((name) => [name, skill(name)] as const),
    ]
    for (const [name, text] of texts)
      expect({ name, found: BANNED_PATTERN.exec(text)?.[0] }).toEqual({ name, found: undefined })
  })

  test("the banned-term check catches a framework name and spares platform names", () => {
    for (const sample of ["built with React", "use SwiftUI", "a Bubble Tea model", "Qt widgets"])
      expect({ sample, caught: BANNED_PATTERN.test(sample) }).toEqual({ sample, caught: true })
    expect(BANNED_PATTERN.test("Android, iOS, Windows, GNOME, Material, Liquid Glass, Mica")).toBe(
      false,
    )
  })
})
