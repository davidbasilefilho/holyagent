import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { Effect } from "effect"

import { parsePatch } from "../../src/pi/codex/apply-patch.ts"
import {
  actionJson,
  classify,
  isSafeCommand,
  patchPaths,
  type PathHost,
  writeTrigger,
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
    expect(writeTrigger(".", ROOT)).toBeUndefined()
    expect(writeTrigger("a/b", ROOT)).toBeUndefined()
    expect(writeTrigger("/work/project-other/a", ROOT)?.kind).toBe("write-outside-root")
  })
})

describe("the path of a write, read as Pi reads it", () => {
  let base: string
  let root: string
  let outside: string

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "auto-review-paths-")))
    root = join(base, "project")
    outside = join(base, "outside")
    mkdirSync(join(root, "src"), { recursive: true })
    mkdirSync(join(root, ".git", "hooks"), { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(root, "link-out"))
    symlinkSync(join(root, ".git"), join(root, "link-git"))
    symlinkSync(join(base, "missing"), join(root, "dangling"))
    symlinkSync(join(root, "loop-b"), join(root, "loop-a"))
    symlinkSync(join(root, "loop-a"), join(root, "loop-b"))
    writeFileSync(join(root, "src", "a.ts"), "x")
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  const write = (path: string) => classify({ toolName: "write", input: { path } }, root)?.kind

  test("a leading @ is dropped, as Pi drops it, before the root check", () => {
    expect(write("@src/a.ts")).toBeUndefined()
    expect(write("@/etc/cron.d/x")).toBe("write-outside-root")
    expect(write("@../outside/x")).toBe("write-outside-root")
    expect(write("@.git/config")).toBe("protected-path")
  })

  test("~ and ~/ are the home folder, which is outside the project", () => {
    expect(write("~")).toBe("write-outside-root")
    expect(write("~/.ssh/authorized_keys")).toBe("write-outside-root")
    expect(write("@~/.ssh/authorized_keys")).toBe("write-outside-root")
    // Pi expands only "~" and "~/", so "~name" is a file of the project named so.
    expect(write("~name/x")).toBeUndefined()
    expect(homedir()).not.toContain(root)
  })

  test("a file:// URL is the path it names", () => {
    expect(write("file:///etc/passwd")).toBe("write-outside-root")
    expect(write(pathToFileURL(join(root, "src", "b.ts")).href)).toBeUndefined()
    expect(write(pathToFileURL(join(root, ".git", "config")).href)).toBe("protected-path")
    expect(write("file://remote-host/share/x")).toBe("write-outside-root")
  })

  test("a link inside the project that leads out is followed, whatever lies below it", () => {
    expect(write("link-out/authorized_keys")).toBe("write-outside-root")
    expect(write("link-out/new/dir/file")).toBe("write-outside-root")
    expect(write("link-git/hooks/pre-commit")).toBe("protected-path")
  })

  test("a link that cannot be resolved, dangling or looping, is reviewed", () => {
    expect(write("dangling")).toBe("write-outside-root")
    expect(write("dangling/x")).toBe("write-outside-root")
    expect(write("loop-a/x")).toBe("write-outside-root")
  })

  test("a path that does not exist yet is judged by its closest existing parent", () => {
    expect(write("src/new/deep/file.ts")).toBeUndefined()
    expect(write("nothing/at/all")).toBeUndefined()
    expect(write("src/../../outside/x")).toBe("write-outside-root")
  })

  test("the folders of git and of the agents are protected inside the root, in any letter case", () => {
    for (const path of [
      ".git/config",
      ".git/hooks/pre-commit",
      ".git",
      ".holyagent/config.json",
      ".pi/settings.json",
      ".codex/config.toml",
      ".claude/settings.json",
      ".agents/skills/x/SKILL.md",
      ".GIT/config",
      ".Claude/x",
      "packages/sub/.git/hooks/x",
      "src/../.git/config",
    ])
      expect([path, write(path)]).toEqual([path, "protected-path"])
    expect(write(".gitignore")).toBeUndefined()
    expect(write(".github/workflows/x.yml")).toBeUndefined()
    expect(write("docs/.holyagentish")).toBeUndefined()
  })

  test("an edit and a patch are judged the same way", () => {
    expect(
      classify({ toolName: "edit", input: { path: "@.git/config", edits: [] } }, root)?.kind,
    ).toBe("protected-path")
    const patch = (...lines: Array<string>) => ({
      toolName: "apply_patch",
      input: { input: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") },
    })
    expect(classify(patch("*** Add File: .git/hooks/post-checkout", "+x"), root)?.kind).toBe(
      "protected-path",
    )
    expect(
      classify(patch("*** Update File: src/a.ts", "*** Move to: .claude/a.ts"), root)?.kind,
    ).toBe("protected-path")
    expect(classify(patch("*** Add File: link-out/x", "+x"), root)?.kind).toBe("write-outside-root")
    // An outside path ahead of a protected one, whatever their order.
    expect(
      classify(patch("*** Add File: .git/x", "+x", "*** Add File: ../outside/y", "+y"), root)?.kind,
    ).toBe("write-outside-root")
    expect(classify(patch("*** Update File: src/a.ts"), root)).toBeUndefined()
  })

  test("a patch header is read as the patch parser reads it, an indented one included", () => {
    const patch = (...lines: Array<string>) => ({
      toolName: "apply_patch",
      input: { input: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") },
    })
    for (const indent of ["  ", "\t", " \t "]) {
      expect(
        classify(patch(`${indent}*** Add File: .git/config`, "+x"), root)?.kind,
        JSON.stringify(indent),
      ).toBe("protected-path")
      expect(
        classify(patch(`${indent}*** Add File: ../outside/x`, "+x"), root)?.kind,
        JSON.stringify(indent),
      ).toBe("write-outside-root")
      expect(
        classify(patch("*** Update File: src/a.ts", `${indent}*** Move to: .claude/a.ts`), root)
          ?.kind,
      ).toBe("protected-path")
      expect(classify(patch(`${indent}*** Delete File: .codex/config.toml`), root)?.kind).toBe(
        "protected-path",
      )
    }
    // Carriage returns and a heredoc around the patch are what the parser tolerates too.
    expect(
      classify(
        {
          toolName: "apply_patch",
          input: { input: "*** Begin Patch\r\n  *** Add File: .git/x\r\n+x\r\n*** End Patch" },
        },
        root,
      )?.kind,
    ).toBe("protected-path")
    expect(
      classify(
        {
          toolName: "apply_patch",
          input: {
            input: "<<'EOF'\n*** Begin Patch\n  *** Add File: .pi/x\n+x\n*** End Patch\nEOF",
          },
        },
        root,
      )?.kind,
    ).toBe("protected-path")
  })

  test("every path the parser takes from a patch is a path the classifier lists", async () => {
    const text = [
      "*** Begin Patch",
      "  *** Add File: a/new.txt",
      "+x",
      "\t*** Update File: a/old.txt",
      " \t*** Move to: b/moved.txt",
      "@@",
      " keep",
      "*** Delete File: c/gone.txt",
      "*** End Patch",
    ].join("\n")
    const operations = await Effect.runPromise(parsePatch(text))
    const parsed = operations.flatMap((operation) =>
      operation.kind === "update" && operation.moveTo !== undefined
        ? [operation.path, operation.moveTo]
        : [operation.path],
    )
    expect(parsed).toEqual(["a/new.txt", "a/old.txt", "b/moved.txt", "c/gone.txt"])
    expect(patchPaths(text)).toEqual(parsed)
  })
})

describe("paths on Windows, read as Pi reads them there", () => {
  const WINDOWS: PathHost = { platform: "win32", home: "C:\\Users\\me" }
  const WIN_ROOT = "C:\\work\\project"
  const win = (path: string) => writeTrigger(path, WIN_ROOT, WINDOWS)?.kind

  test("~\\ is the home folder, as ~/ is", () => {
    expect(win("~\\.ssh\\authorized_keys")).toBe("write-outside-root")
    expect(win("~/.ssh/authorized_keys")).toBe("write-outside-root")
    expect(win("@~\\AppData\\Roaming\\Startup\\x.bat")).toBe("write-outside-root")
    expect(win("~")).toBe("write-outside-root")
    // Other systems read "~\\x" as a file of the project named so, as Pi does.
    expect(
      writeTrigger("~\\x", "/work/project", { platform: "linux", home: "/home/me" }),
    ).toBeUndefined()
  })

  test("a Git Bash, MSYS, Cygwin or WSL drive path is the drive path", () => {
    expect(win("/c/work/project/src/a.ts")).toBeUndefined()
    expect(win("/c/work/project/.git/config")).toBe("protected-path")
    expect(win("/mnt/c/work/project/.claude/settings.json")).toBe("protected-path")
    expect(win("/cygdrive/c/Users/me/.ssh/config")).toBe("write-outside-root")
    expect(win("/d/other/x")).toBe("write-outside-root")
    expect(win("/c")).toBe("write-outside-root")
    // Only a path of Windows is mapped; "//server/share" and a path with a backslash are not.
    expect(win("//server/share/x")).toBe("write-outside-root")
    expect(win("src/a.ts")).toBeUndefined()
    // Another system does not map it: "/c/work/project/x" is its own absolute path.
    expect(
      writeTrigger("/c/work/project/x", "/work/project", { platform: "linux", home: "/h" })?.kind,
    ).toBe("write-outside-root")
  })

  test("a file:// URL is read as a Windows path", () => {
    expect(win("file:///C:/work/project/src/a.ts")).toBeUndefined()
    expect(win("file:///C:/work/project/.git/config")).toBe("protected-path")
    expect(win("file:///C:/Windows/x")).toBe("write-outside-root")
  })

  test("the root check ignores case and separators, and a path on another drive is outside", () => {
    expect(win("c:\\WORK\\Project\\src\\a.ts")).toBeUndefined()
    expect(win("src/sub\\a.ts")).toBeUndefined()
    expect(win("D:\\work\\project\\a.ts")).toBe("write-outside-root")
    expect(win("..\\other\\a.ts")).toBe("write-outside-root")
  })

  test("a protected folder matches under the names Windows gives it", () => {
    for (const path of [
      ".git",
      ".GIT\\config",
      ".git.\\config",
      ".git...\\config",
      ".git \\config",
      "GIT~1\\hooks\\pre-commit",
      "git~2\\config",
      ".git::$INDEX_ALLOCATION\\config",
      "HOLYAG~1\\config.json",
      ".holyagent.\\config.json",
      "CLAUDE~1\\settings.json",
      "CODEX~1\\config.toml",
      "AGENTS~1\\x",
      "PI~1\\settings.json",
      ".pi.\\settings.json",
      "sub\\GIT~1\\x",
    ])
      expect([path, win(path)]).toEqual([path, "protected-path"])
    for (const path of [".gitignore", ".github\\x", "GITHUB~1\\x", "git~\\x", "ABC~1\\x", "pi~x"])
      expect([path, win(path)]).toEqual([path, undefined])
  })

  test("the aliases are Windows names: another system keeps its names exact", () => {
    const linux: PathHost = { platform: "linux", home: "/home/me" }
    expect(writeTrigger(".git./config", "/work/project", linux)).toBeUndefined()
    expect(writeTrigger("GIT~1/config", "/work/project", linux)).toBeUndefined()
    expect(writeTrigger(".git/config", "/work/project", linux)?.kind).toBe("protected-path")
  })

  test("a call is judged on the host it is given", () => {
    const patch = {
      toolName: "apply_patch",
      input: { input: "*** Begin Patch\n  *** Add File: GIT~1\\config\n+x\n*** End Patch" },
    }
    expect(classify(patch, WIN_ROOT, {}, WINDOWS)?.kind).toBe("protected-path")
    expect(
      classify({ toolName: "write", input: { path: "~\\x" } }, WIN_ROOT, {}, WINDOWS)?.kind,
    ).toBe("write-outside-root")
  })
})

describe("commands that run other programs or write files", () => {
  const review = (command: string) => [command, isSafeCommand(command)] as const

  test("brace expansion is reviewed, since it builds flags that the checks never saw", () => {
    for (const command of [
      "rg --p{re,re}=./x.sh foo .",
      "git log --out{put,put}=/tmp/x",
      "ls {a,b}",
      "cat file{1..3}",
      "echo {a,b}",
    ])
      expect(review(command)).toEqual([command, false])
    // Quoted, a brace is an ordinary character.
    expect(isSafeCommand("rg 'a{2}' src")).toBe(true)
    expect(isSafeCommand('echo "{a,b}"')).toBe(true)
  })

  test("a glob is reviewed, since a file named like a flag would join it", () => {
    for (const command of ["rg foo *", "cat ?", "ls [ab]*", "git grep foo -- *.ts"])
      expect(review(command)).toEqual([command, false])
    expect(isSafeCommand("find . -name '*.ts'")).toBe(true)
  })

  test("git grep may not open its matches in a program: -O, glued or clustered, and its long form", () => {
    for (const command of [
      "git grep -O'sh -c id' foo",
      "git grep -Osh foo",
      "git grep -nO foo",
      "git grep -in -Ovim foo",
      "git grep --open-files-in-pager=sh foo",
      "git grep --open-files-in-pager foo",
      "git grep --open-files foo",
      "git grep --open foo",
    ])
      expect(review(command)).toEqual([command, false])
    expect(isSafeCommand("git grep -n -i foo")).toBe(true)
  })

  test("git flags that write or run are unsafe under any unambiguous abbreviation", () => {
    for (const command of [
      "git log --output=/tmp/x",
      "git log --out=/tmp/x",
      "git diff --outp /tmp/x",
      "git diff --ext-d",
      "git show --textc",
      "git cat-file --filters HEAD:a",
      "git log --exe=x",
      "git diff --config-env=a=b",
    ])
      expect(review(command)).toEqual([command, false])
    for (const command of ["git log --oneline", "git diff --stat -- a.ts", "git log --format=%H"])
      expect(review(command)).toEqual([command, true])
  })

  test("uniq may write its second operand, so it is reviewed", () => {
    for (const command of ["uniq in.txt /etc/cron.d/x", "uniq in.txt", "sort a | uniq"])
      expect(review(command)).toEqual([command, false])
  })

  test("ripgrep flags that start a program are unsafe alone or among short flags", () => {
    for (const command of [
      "rg -iz pat",
      "rg -zi pat",
      "rg -uuz pat src",
      "rg -z pat",
      "rg --search-zip pat",
      "rg --pre=./x.sh pat",
      "rg --pre ./x.sh pat",
      "rg --hostname-bin=./x.sh pat",
      "rg --hook=x pat",
    ])
      expect(review(command)).toEqual([command, false])
    for (const command of ["rg -in pat src", "rg -e zebra src", "rg --glob '*.zig' pat"])
      expect(review(command)).toEqual([command, true])
  })

  test("every program of the safe set is read-only whatever its operands", () => {
    for (const command of [
      "cat a b",
      "head -n 5 a",
      "tail -n 5 a",
      "wc -l a",
      "cut -d, -f1 a",
      "nl a",
      "paste a b",
      "rev a",
      "tr a b",
      "stat a",
      "ls -la src",
      "grep -rn foo src",
      "find . -type f -newer a",
      "git rev-parse --show-toplevel",
      "git ls-files",
      "sed -n 3,9p a",
    ])
      expect(review(command)).toEqual([command, true])
    // Safe programs alone, none of them one that writes through an operand.
    for (const command of ["tee out", "sort -o out a", "cp a b", "dd of=out", "truncate -s0 a"])
      expect(review(command)).toEqual([command, false])
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

  test("a tool annotated read-only runs", () => {
    const call = { toolName: "mcp__docs__search", input: {} }
    expect(classify(call, ROOT, { annotations: { readOnlyHint: true } })).toBe(undefined)
  })

  test("a tool that only says it is closed and not destructive is not read-only, so it is reviewed", () => {
    const call = { toolName: "mcp__docs__search", input: {} }
    expect(
      classify(call, ROOT, { annotations: { destructiveHint: false, openWorldHint: false } })?.kind,
    ).toBe("tool-approval")
  })
})

describe("tools that are neither known read-only nor annotated read-only", () => {
  test("Pi's read tools run", () => {
    for (const toolName of ["read", "grep", "find", "ls"])
      expect(classify({ toolName, input: { path: "/etc/hosts" } }, ROOT)).toBe(undefined)
  })

  test("any other tool is reviewed, a process runner and a tool nobody classified included", () => {
    for (const toolName of [
      "process",
      "processes",
      "codemode",
      "subagent",
      "todo",
      "Agent",
      "ask",
      "computer_use_click",
      "unknown_tool",
    ])
      expect([toolName, classify({ toolName, input: { command: "id" } }, ROOT)?.kind]).toEqual([
        toolName,
        "tool-approval",
      ])
  })

  test("a tool of an MCP server that takes a built-in name earns nothing by it", () => {
    expect(classify({ toolName: "read", input: {} }, ROOT, { mcp: true })?.kind).toBe(
      "tool-approval",
    )
    expect(
      classify({ toolName: "read", input: {} }, ROOT, {
        mcp: true,
        annotations: { readOnlyHint: true },
      }),
    ).toBe(undefined)
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
