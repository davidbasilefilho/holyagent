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
    ["for b in a b; do git push origin $b; done", ["unclear"]],
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
    ["git push --mirror", ["force-push"]],
    ["git push --mirror origin", ["force-push"]],
    ["git push --delete origin old", ["force-push"]],
    ["git push -d origin old", ["force-push"]],
    ["git push origin :old", ["force-push"]],
    ["git push origin --prune 'refs/heads/*:refs/heads/*'", ["force-push"]],
    ["git push --prune origin", ["force-push"]],
    ["git push --force-w origin main", ["force-push"]],
    ["git push --force-with origin main", ["force-push"]],
    ["git push --forc origin main", ["force-push"]],
    ["git push --force-i origin main", ["force-push"]],
    ["git push --mirr origin", ["force-push"]],
    ["git push --del origin old", ["force-push"]],
    ["git push --pru origin", ["force-push"]],
    ["git push -nd origin old", ["force-push"]],
    ["git push origin -- +main", ["force-push"]],
    ["git push origin -- :main", ["force-push"]],
    ["git push -- origin main", []],
    ["git push origin HEAD:refs/heads/x", []],
    ["git push --porcelain origin main", []],
    ["git push --set-upstream origin x", []],
    ["git push --dry-run origin x", []],
    ["git push $'\\x2d\\x2dforce' origin main", ["force-push"]],
    ["git push $'\\055f' origin main", ["force-push"]],
    ["git push $'\\u002df' origin main", ["force-push"]],
    ["git push $'\\x2d\\x2dmirror'", ["force-push"]],
    ["git push origin $'\\x2bmain'", ["force-push"]],
    ["git push origin $'\\qmain'", ["unclear"]],
    ["git push origin $branch", ["unclear"]],
    ['git push -u origin "$(git branch --show-current)"', ["unclear"]],
    ["git push origin {a,b}", ["unclear"]],
    ["git push origin refs/heads/*", ["unclear"]],
    ["git push origin ma?n", ["unclear"]],
    ["git push origin `echo main`", ["unclear"]],
    ["git push --force-with-lease=$(git rev-parse x) origin main", ["force-push"]],
    ['git commit -m "$x"', ["commit"]],
    ["cat <<< x\ngit commit -m y", ["commit"]],
    [": <<< x\ngit push --force", ["force-push"]],
    ["cat <<<x\ngit commit -m y", ["commit"]],
    ["cat <<< 'a b' && git commit -m y", ["commit"]],
    ["echo $((1<<2))\ngit commit -m x", ["commit"]],
    ["echo $(( 1 << 2 ))\ngit push -f", ["force-push"]],
    ["x=$(( 1 << 3 ))\ngit commit -m x", ["commit"]],
    ["(( x = 1 << 2 ))\ngit commit -m x", ["commit"]],
    ["cat <<EOF\nbody\nEOF\ngit commit -m x", ["commit"]],
    ["cat <<-EOF\n\tbody git commit\n\tEOF\ngit commit -m x", ["commit"]],
    ["cat <<EOF\nbody git commit\nEOF", []],
    ["", []],
  ])("%j", (line, expected) => {
    expect(gitWrites(line)).toEqual(expected)
  })

  test("a command nested too deep to read is unclear, never silent and never a throw", () => {
    expect(gitWrites(`${"$(".repeat(200)}git commit -m x${")".repeat(200)}`)).toContain("unclear")
    for (const depth of [1000, 50000])
      expect(() => gitWrites(`${"$(".repeat(depth)}echo${")".repeat(depth)}`)).not.toThrow()
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
