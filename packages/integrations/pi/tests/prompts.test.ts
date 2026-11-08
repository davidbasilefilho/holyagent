import { describe, expect, test } from "bun:test"

import { PROMPT_TEMPLATES } from "../../../runtime/src/prompts/index.ts"
import { DIST_DIRECTORY } from "../src/files.ts"
import { generate, PROMPTS_SOURCE } from "../src/generate.ts"

const generated = await generate()
const promptFiles = generated.filter((file) => file.path.startsWith(`${DIST_DIRECTORY}/prompts/`))

describe("the prompt templates of the package", () => {
  test("are the code-review and security-review templates, one file each", () => {
    expect(promptFiles.map((file) => file.path)).toEqual([
      `${DIST_DIRECTORY}/prompts/code-review.md`,
      `${DIST_DIRECTORY}/prompts/security-review.md`,
    ])
  })

  test("have the frontmatter Pi reads (description, argument-hint) and the generated note naming the runtime source", () => {
    for (const file of promptFiles) {
      const name = file.path.slice(file.path.lastIndexOf("/") + 1)
      const head = /^---\n([\s\S]*?)\n---\n/.exec(file.content)?.[1] ?? ""
      expect({ path: file.path, description: /^description: \S/m.test(head) }).toEqual({
        path: file.path,
        description: true,
      })
      expect(head).toMatch(/^argument-hint: "\[<start>\.\.\.<head>\]"$/m)
      expect(head).toContain(`from ${PROMPTS_SOURCE}/${name}; edit the source and rebuild.`)
    }
  })

  test("are the runtime's templates, body for body", () => {
    expect(promptFiles.map((file) => file.content.split("\n---\n")[1]?.trim())).toEqual(
      PROMPT_TEMPLATES.map((template) => template.body),
    )
  })

  test("take the range from the call's arguments, and fall back to the Assignment", () => {
    for (const file of promptFiles)
      expect(file.content).toContain("${@:-the refs the Assignment below names}")
  })
})
