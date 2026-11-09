import { describe, expect, test } from "bun:test"

import { ROUTES } from "../src/domain/route.ts"
import { firstPassPrompt, PROMPT_TEMPLATES } from "../src/prompts/index.ts"

const text = (name: string) => PROMPT_TEMPLATES.find((t) => t.name === name)?.body ?? ""

describe("the first-pass prompt templates", () => {
  test("are the code-review and security-review templates, each with the frontmatter Pi reads", () => {
    expect(PROMPT_TEMPLATES.map((template) => template.name)).toEqual([
      "code-review",
      "security-review",
    ])
    for (const template of PROMPT_TEMPLATES) {
      const head = template.head.join("\n")
      expect({ name: template.name, head: /^description: \S/m.test(head) }).toEqual({
        name: template.name,
        head: true,
      })
      expect(head).toMatch(/^argument-hint: /m)
    }
  })

  test("are read-only first passes that name the template they are", () => {
    expect(text("code-review")).toStartWith("First pass: code-review.")
    expect(text("security-review")).toStartWith("First pass: security-review.")
    for (const name of ["code-review", "security-review"])
      expect(text(name)).toContain("change no file, branch or index")
    expect(text("security-review")).toContain("validated")
    expect(text("security-review")).toContain("suspected")
  })

  test("call their findings working input to the next step and the result when run alone", () => {
    for (const name of ["code-review", "security-review"]) {
      expect(text(name)).toContain("working input to the next step, not a final report")
      expect(text(name)).toContain("When you run it alone, the list is the result.")
    }
  })

  test("label findings with the blocker and optional classes of the reviewer roles", () => {
    expect(text("code-review")).toMatch(/- blocker: /)
    expect(text("code-review")).toMatch(/- optional: /)
    expect(text("security-review")).toContain(
      "A validated finding the range introduced or worsened is a blocker; a suspected one is optional.",
    )
  })

  test("ask for a range when run alone with none, and hold no placeholder for the person to copy", () => {
    for (const name of ["code-review", "security-review"]) {
      expect(text(name)).toContain("If no Assignment follows and the range names no refs, ask")
      expect(text(name)).toContain("such as `main...my-branch`")
      expect(text(name)).not.toMatch(/`git diff <start>/)
    }
  })

  test("show one example entry each", () => {
    for (const name of ["code-review", "security-review"])
      expect(text(name).match(/^Example entry:$/gm)).toHaveLength(1)
  })
})

describe("firstPassPrompt", () => {
  test("is the code-review template for Reviewer.code and security-review for Reviewer.security, arguments at their defaults", () => {
    expect(firstPassPrompt("Reviewer.code")).toStartWith("First pass: code-review.")
    expect(firstPassPrompt("Reviewer.security")).toStartWith("First pass: security-review.")
    for (const roleTask of ["Reviewer.code", "Reviewer.security"] as const) {
      const prompt = firstPassPrompt(roleTask) ?? ""
      expect(prompt).toContain("Range: the refs the Assignment below names. A range is")
      expect(prompt).not.toContain("${")
    }
  })

  test("is nothing for every other role", () => {
    const others = ROUTES.filter(
      (route) => route.roleTask !== "Reviewer.code" && route.roleTask !== "Reviewer.security",
    )
    expect(others).toHaveLength(ROUTES.length - 2)
    for (const route of others)
      expect({ roleTask: route.roleTask, prompt: firstPassPrompt(route.roleTask) }).toEqual({
        roleTask: route.roleTask,
        prompt: undefined,
      })
  })
})

describe("the dependency direction", () => {
  test("no runtime source imports an integration package", async () => {
    const importers: Array<string> = []
    for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: `${import.meta.dir}/../src` }))
      if (
        /from "(\.\.\/)+integrations\//.test(
          await Bun.file(`${import.meta.dir}/../src/${path}`).text(),
        )
      )
        importers.push(path)
    expect(importers).toEqual([])
  })
})
