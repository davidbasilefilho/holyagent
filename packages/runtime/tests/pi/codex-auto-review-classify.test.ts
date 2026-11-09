import { describe, expect, test } from "bun:test"

import {
  actionJson,
  classify,
  isOutsideRoot,
  isSafeCommand,
  patchPaths,
} from "../../src/pi/codex/auto-review/classify.ts"

const ROOT = "/work/project"

const bash = (command: string) => classify({ toolName: "bash", input: { command } }, ROOT)

describe("shell commands", () => {
  test("a read-only safe command runs without review", () => {
    for (const command of [
      "ls -la",
      "cat package.json | head -20",
      "git status && git diff --stat",
      "git log --oneline -5",
      "git branch --show-current",
      "rg TODO src",
      "grep -rn foo . | wc -l",
      "find . -name '*.ts'",
      "sed -n 3,9p src/a.ts",
      "cd src; pwd",
      'echo "hello world"',
    ])
      expect([command, bash(command)]).toEqual([command, undefined])
  })

  test("a command outside the safe set goes to review as a command", () => {
    for (const command of [
      "rm -rf build",
      "bun test",
      "git commit -m x",
      "git branch -D old",
      "git -c core.pager=x log",
      "git diff --output=out.patch",
      "find . -delete",
      "find . -exec rm {} ;",
      "rg --pre cmd foo",
      "sed -i s/a/b/ file",
      "sed -n 1p file -f script",
      "FOO=1 ls",
      "unknown-program",
    ])
      expect([command, bash(command)?.kind]).toEqual([command, "command"])
  })

  test("shell syntax that could do more than a safe command says goes to review", () => {
    for (const command of [
      "ls > out.txt",
      "cat < in.txt",
      "echo $(rm -rf x)",
      "echo `id`",
      "echo $HOME",
      'echo "$HOME"',
      "ls & rm x",
      "ls; rm -rf x",
      "ls && rm x",
      "ls | tee out",
      "(ls)",
      "echo 'unterminated",
      "ls # comment",
      "",
    ])
      expect([command, isSafeCommand(command)]).toEqual([command, false])
  })

  test("a command that uses the network goes to review as network use", () => {
    for (const command of [
      "curl https://example.com",
      "wget http://x.test/a",
      "git push origin main",
      "git clone https://github.com/a/b",
      "npm install left-pad",
      "bun add effect",
      "ssh host ls",
      "gh pr list",
    ])
      expect([command, bash(command)?.kind]).toEqual([command, "network"])
  })

  test("a command that cannot be read goes to review", () => {
    expect(classify({ toolName: "bash", input: {} }, ROOT)?.kind).toBe("command")
    expect(
      classify({ toolName: "powershell", input: { command: "Remove-Item x" } }, ROOT)?.kind,
    ).toBe("command")
  })
})

describe("writes", () => {
  test("a write or edit inside the project root runs", () => {
    expect(classify({ toolName: "write", input: { path: "src/a.ts", content: "x" } }, ROOT)).toBe(
      undefined,
    )
    expect(classify({ toolName: "edit", input: { path: `${ROOT}/a.ts`, edits: [] } }, ROOT)).toBe(
      undefined,
    )
  })

  test("a write or edit outside the project root goes to review", () => {
    for (const path of ["../other/a.ts", "/etc/passwd", "~/.ssh/config", "src/../../x"]) {
      expect(classify({ toolName: "write", input: { path, content: "x" } }, ROOT)).toMatchObject({
        kind: "write-outside-root",
      })
      expect(classify({ toolName: "edit", input: { path, edits: [] } }, ROOT)?.kind).toBe(
        "write-outside-root",
      )
    }
    expect(classify({ toolName: "write", input: { content: "x" } }, ROOT)?.kind).toBe(
      "write-outside-root",
    )
  })

  test("a patch is judged by every path it names, a move target included", () => {
    const inside = "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch"
    const outside =
      "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/a.ts\n*** Move to: ../out/a.ts\n*** End Patch"
    expect(classify({ toolName: "apply_patch", input: { input: inside } }, ROOT)).toBe(undefined)
    expect(classify({ toolName: "apply_patch", input: { input: outside } }, ROOT)).toEqual({
      kind: "write-outside-root",
      reason: "../out/a.ts is outside the project root",
    })
    expect(patchPaths(outside)).toEqual(["src/new.ts", "src/a.ts", "../out/a.ts"])
  })

  test("the root itself and its children are inside; a sibling with the same prefix is not", () => {
    expect(isOutsideRoot(".", ROOT)).toBe(false)
    expect(isOutsideRoot("a/b", ROOT)).toBe(false)
    expect(isOutsideRoot("/work/project-other/a", ROOT)).toBe(true)
  })
})

describe("network use and annotations", () => {
  test("a web tool goes to review as network use", () => {
    for (const toolName of ["web_fetch", "web_search", "moonshot_fetch", "moonshot_search"])
      expect(classify({ toolName, input: { url: "https://x.test" } }, ROOT)?.kind).toBe("network")
  })

  test("a tool whose annotations need approval goes to review", () => {
    const call = { toolName: "mcp__docs__publish", input: {} }
    expect(classify(call, ROOT, { annotations: { destructiveHint: true } })?.kind).toBe(
      "tool-approval",
    )
    expect(
      classify(call, ROOT, { annotations: { destructiveHint: false, openWorldHint: true } })?.kind,
    ).toBe("tool-approval")
    // The MCP defaults: a tool that does not say it is harmless is taken as destructive.
    expect(classify(call, ROOT, { annotations: {} })?.kind).toBe("tool-approval")
    expect(classify(call, ROOT, { mcp: true })?.kind).toBe("tool-approval")
  })

  test("a read-only tool, or one that says it is closed and not destructive, runs", () => {
    const call = { toolName: "mcp__docs__search", input: {} }
    expect(classify(call, ROOT, { annotations: { readOnlyHint: true } })).toBe(undefined)
    expect(
      classify(call, ROOT, { annotations: { destructiveHint: false, openWorldHint: false } }),
    ).toBe(undefined)
  })

  test("every other tool runs", () => {
    for (const toolName of ["read", "grep", "find", "ls", "todo", "Agent", "ask"])
      expect(classify({ toolName, input: { path: "/etc/hosts" } }, ROOT)).toBe(undefined)
  })
})

describe("the action as JSON", () => {
  test("carries the tool, the root, the trigger and the exact input, and cuts a long string", () => {
    const call = { toolName: "bash", input: { command: "rm -rf build" } }
    const trigger = classify(call, ROOT)
    if (trigger === undefined) throw new Error("expected a trigger")
    expect(JSON.parse(actionJson(call, ROOT, trigger))).toEqual({
      tool: "shell",
      cwd: ROOT,
      trigger: "command",
      trigger_reason: "the command is outside the read-only safe set",
      input: { command: "rm -rf build" },
    })
    const long = { toolName: "write", input: { path: "/x", content: "a".repeat(200_000) } }
    const parsed = JSON.parse(
      actionJson(long, ROOT, { kind: "write-outside-root", reason: "r" }),
    ) as { tool: string; input: { content: string } }
    expect(parsed.tool).toBe("write")
    expect(parsed.input.content).toContain('<truncated omitted_approx_tokens="')
    expect(parsed.input.content.length).toBeLessThan(70_000)
  })
})
