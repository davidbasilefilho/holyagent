import { describe, expect, test } from "bun:test"

import { type GitWrite, gitWrites } from "../src/cli/shell.ts"

describe("gitWrites", () => {
  test.each<readonly [string, ReadonlyArray<GitWrite>]>([
    ["git commit -m x", ["commit"]],
    ["git push", []],
    ["git push -u origin feature", []],
    ["git push --force", ["force-push"]],
    ["git push -f origin main", ["force-push"]],
    ["git push origin main -f", ["force-push"]],
    ["git push -fu origin main", ["force-push"]],
    ["git push --force-with-lease", ["force-push"]],
    ["git push --force-with-lease=main:abc origin main", ["force-push"]],
    ["git push --force-if-includes", ["force-push"]],
    ["git push origin +main", ["force-push"]],
    ["git push origin +HEAD:main", ["force-push"]],
    ["git push --no-force origin main", []],
    ["git push --follow-tags", []],
    ["git -C repo push origin +x", ["force-push"]],
    ["cd a && git commit -m x && git push -f", ["commit", "force-push"]],
    ["for b in a b; do git commit -m x; done", ["commit"]],
    ["for b in a b; do git push origin $b; done", []],
    ["for w in git commit push; do echo $w; done", []],
    ["cat <<EOF\ngit commit -m x\nEOF", []],
    ["cat <<EOF\ntext\nEOF\ngit commit -m x", ["commit"]],
    ["rm -rf build dist", []],
    ["rm -rf build && git commit -m x", ["commit"]],
    ['echo "Git is nice; commit often"', []],
    ["gh pr create --body 'git commit and git push --force are for the root'", []],
    ["bash -c 'git push --force'", ["force-push"]],
    ["git log --grep='git commit'", []],
    ["echo $((1 + 2)); git commit -m x", ["commit"]],
    ["f() { git commit -m x; }; f", ["commit"]],
    ["case $x in a) git push -f ;; esac", ["force-push"]],
    ["echo $'it\\'s git commit'; git commit -m x", ["commit"]],
    ["echo $'a\\'b' && git push -f", ["force-push"]],
    ["", []],
  ])("%j", (line, expected) => {
    expect(gitWrites(line)).toEqual(expected)
  })

  test("never throws, whatever the text", () => {
    const pieces = [
      "git",
      "commit",
      "push",
      "-f",
      "$(",
      ")",
      "`",
      "'",
      '"',
      "<<",
      "EOF",
      "\n",
      ";",
      "&&",
      "|",
      "\\",
      "#",
      "(",
      "{",
      "}",
    ]
    let seed = 7
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed
    }
    for (let round = 0; round < 3000; round += 1) {
      const line = Array.from(
        { length: 1 + (next() % 16) },
        () => pieces[next() % pieces.length] ?? "",
      ).join(next() % 2 === 0 ? " " : "")
      expect(() => gitWrites(line)).not.toThrow()
    }
  })
})
