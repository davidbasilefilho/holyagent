import { describe, expect, test } from "bun:test"

import { stripCitations } from "../../src/instructions/skills.ts"

/** Each case in LF and in CRLF, because sources may carry either. */
const bothEndings = (cases: ReadonlyArray<readonly [string, string]>) => {
  for (const [input, expected] of cases) {
    expect(stripCitations(input)).toBe(expected)
    expect(stripCitations(input.replaceAll("\n", "\r\n"))).toBe(expected.replaceAll("\n", "\r\n"))
  }
}

describe("stripCitations edge cases", () => {
  test("a stray backtick does not pair code spans across list items", () => {
    bothEndings([
      ["- a ` stray <!-- K1 -->\n- b `\n", "- a ` stray\n- b `\n"],
      ["1. a ` stray <!-- K1 -->\n2. b `\n", "1. a ` stray\n2. b `\n"],
      ["* a ` stray\n  <!-- K1 -->\n  * b `\n", "* a ` stray\n  * b `\n"],
    ])
  })

  test("a code span still holds a comment across a soft line break that is not a list item", () => {
    const text = "a `x\n<!-- keep -->` b\n"
    expect(stripCitations(text)).toBe(text)
  })

  test("a fence indented four spaces is not a fence", () => {
    bothEndings([
      ["para\n\n    ```\n<!-- K1 -->\n    ```\n", "para\n\n    ```\n    ```\n"],
      ["para\n\n    ~~~\n\ntext <!-- K1 -->\n", "para\n\n    ~~~\n\ntext\n"],
    ])
  })

  test("an indented code block with a blank line is left as written", () => {
    const block = "    <!-- keep -->\n\n    more <!-- keep too -->\n"
    bothEndings([
      [`para\n\n${block}\nend <!-- K1 -->\n`, `para\n\n${block}\nend\n`],
      [`${block}\nend <!-- K1 -->\n`, `${block}\nend\n`],
      [
        "para\n\n\t<!-- keep -->\n\n\tcode\n\nend <!-- K1 -->\n",
        "para\n\n\t<!-- keep -->\n\n\tcode\n\nend\n",
      ],
    ])
  })

  test("indentation of a paragraph continuation is not a code block", () => {
    expect(stripCitations("para\n    continues <!-- K1 -->\n")).toBe("para\n    continues\n")
  })

  test("a citation comment on the final line keeps the preceding newline", () => {
    bothEndings([
      ["one\n<!-- K1 -->", "one\n"],
      ["one\n\n<!-- K1 -->", "one\n\n"],
      ["one\n<!-- K1 -->\n<!-- K2 -->", "one\n"],
      ["<!-- K1 -->", ""],
      ["one\ntwo <!-- K1 -->", "one\ntwo"],
    ])
  })
})
