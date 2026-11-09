import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, parse } from "node:path"

import { Effect } from "effect"

import { cmdExeArguments } from "../../src/pi/bash/cmd.ts"
import { withNullDevice } from "../../src/pi/bash/devices.ts"
import {
  hostPathValue,
  hostSearchFolders,
  pathFor,
  programExtensions,
  programName,
  scanHostPrograms,
} from "../../src/pi/bash/hosts.ts"
import { toHostArgument, toHostPath, toVirtualPath } from "../../src/pi/bash/paths.ts"
import {
  interpreterOf,
  programKind,
  RUNNER_PATH,
  trampoline,
  withProgramLaunch,
} from "../../src/pi/bash/programs.ts"
import type { ShellFrame } from "../../src/pi/bash/protocol.ts"
import {
  emittedOrder,
  endState,
  envChanges,
  HOST_PREFIX,
  hostLaunch,
  planCommands,
  runShell,
  SHELL_PATH,
} from "../../src/pi/bash/shell.ts"
import { typeScriptFirst } from "../../src/pi/bash/typescript.ts"
import { PROCESS_TIMEOUT_MS } from "../fixtures.ts"

const WINDOWS = process.platform === "win32"
// A host program that exists on every system the tests run on: the Bun that runs them.
const HOST_DIR = dirname(process.execPath)
const HOST = parse(process.execPath).name

let work: string

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "holyagent-bash-"))
})

afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

interface Outcome {
  readonly output: Buffer
  readonly text: string
  readonly exitCode: number
  readonly cwd: string
  readonly changes: { readonly set: Record<string, string>; readonly unset: ReadonlyArray<string> }
  readonly frames: ReadonlyArray<ShellFrame>
}

/** Runs one command in the shell, in this process, and gathers what it wrote. */
const shell = async (
  command: string,
  options: { cwd?: string; path?: string; env?: Record<string, string> } = {},
): Promise<Outcome> => {
  const frames: Array<ShellFrame> = []
  await Effect.runPromise(
    runShell(
      {
        command,
        cwd: options.cwd ?? work,
        env: { PATH: options.path ?? HOST_DIR, HOME: work, ...options.env },
      },
      { emit: (frame) => void frames.push(frame) },
    ),
  )
  const output = Buffer.concat(
    frames.flatMap((frame) => (frame.type === "data" ? [Buffer.from(frame.data, "base64")] : [])),
  )
  const end = frames.find((frame) => frame.type === "end")
  if (end === undefined || end.type !== "end") throw new Error("the run wrote no end frame")
  return {
    output,
    text: output.toString("utf8"),
    exitCode: end.exitCode,
    cwd: end.cwd,
    changes: end.changes,
    frames,
  }
}

describe("which command runs: just-bash's built-in, or the host's program", () => {
  const hosts = new Map([
    ["git", "/h/git"],
    ["rg", "/h/rg"],
    ["cat", "/h/cat"],
    ["node", "/h/node"],
    ["sqlite3", "/h/sqlite3"],
  ])
  const builtins = ["rg", "cat", "grep", "node", "js-exec", "sqlite3"]

  test("a command just-bash implements runs its own, and the host's program of that name is not registered", () => {
    const plan = planCommands(hosts, builtins)
    expect(plan.passthrough.has("rg")).toBe(false)
    expect(plan.passthrough.has("cat")).toBe(false)
    expect(plan.builtins.has("rg")).toBe(true)
    expect(plan.builtins.has("cat")).toBe(true)
  })

  test("a command just-bash lacks runs the host's program", () => {
    const plan = planCommands(hosts, builtins)
    expect(plan.passthrough.get("git")).toBe("/h/git")
    expect(plan.builtins.has("git")).toBe(false)
  })

  test("a shadowed host program stays reachable as host-<name>", () => {
    const plan = planCommands(hosts, builtins)
    expect(plan.aliases.get(`${HOST_PREFIX}rg`)).toBe("/h/rg")
    expect(plan.aliases.get(`${HOST_PREFIX}cat`)).toBe("/h/cat")
    expect(plan.aliases.has(`${HOST_PREFIX}git`)).toBe(false)
  })

  test("node, which only prints a refusal, and sqlite3, which cannot run in the bundle, give way to the host", () => {
    const plan = planCommands(hosts, builtins)
    expect(plan.passthrough.get("node")).toBe("/h/node")
    expect(plan.passthrough.get("sqlite3")).toBe("/h/sqlite3")
    expect(plan.builtins.has("node")).toBe(false)
    const without = planCommands(new Map(), builtins)
    expect(without.builtins.has("node")).toBe(true)
    expect(without.builtins.has("sqlite3")).toBe(false)
  })
})

describe("the state a run leaves", () => {
  test("lists what changed in the exported environment, and ignores what the shell keeps for itself", () => {
    const before = { A: "1", B: "2", C: "3", PATH: "/usr/bin:/bin", PWD: "/a" }
    const after = { A: "1", B: "changed", D: "4", PATH: "/x", PWD: "/b", SHELLOPTS: "x", "?": "0" }
    expect(envChanges(before, after)).toEqual({ set: { B: "changed", D: "4" }, unset: ["C"] })
  })
})

describe("where host programs are looked for", () => {
  test("the call's PATH first, then the places a launcher's PATH may leave out, each once", () => {
    const folders = hostSearchFolders(
      { PATH: ["/a", "/usr/local/bin", "relative", "", "/b"].join(":"), HOME: "/home/me" },
      "linux",
    )
    expect(folders.slice(0, 3)).toEqual(["/a", "/usr/local/bin", "/b"])
    expect(folders).toContain("/home/me/.bun/bin")
    expect(folders).toContain("/home/me/.local/bin")
    expect(folders).toContain("/home/me/.local/share/mise/shims")
    expect(folders).toContain("/opt/homebrew/bin")
    expect(folders.filter((folder) => folder === "/usr/local/bin")).toHaveLength(1)
    expect(folders).not.toContain("relative")
  })

  test("BUN_INSTALL and MISE_DATA_DIR move Bun's and mise's folders", () => {
    const folders = hostSearchFolders(
      { PATH: "/a", HOME: "/h", BUN_INSTALL: "/bun", MISE_DATA_DIR: "/mise" },
      "linux",
    )
    expect(folders).toContain("/bun/bin")
    expect(folders).toContain("/mise/shims")
  })

  test("the folders follow the platform they are asked for, not the host's path rules", () => {
    expect(pathFor("win32").delimiter).toBe(";")
    expect(pathFor("linux").delimiter).toBe(":")
    expect(pathFor("darwin").join("/h", ".bun", "bin")).toBe("/h/.bun/bin")
    const posix = hostSearchFolders(
      { PATH: "/a:/b/c", HOME: "/h", BUN_INSTALL: "/bun", MISE_DATA_DIR: "/mise" },
      "linux",
    )
    expect(posix.slice(0, 2)).toEqual(["/a", "/b/c"])
    expect(posix).toContain("/bun/bin")
    expect(posix).toContain("/mise/shims")
    expect(posix.some((folder) => folder.includes("\\"))).toBe(false)
    expect(
      hostPathValue({ PATH: "/a:relative:/b", HOME: "/h" }, "linux").startsWith("/a:/b:"),
    ).toBe(true)
    // A POSIX path is not rooted for Windows, nor a drive path for POSIX.
    expect(hostSearchFolders({ Path: "/a;C:\\a" }, "win32")[0]).toBe("C:\\a")
    expect(hostSearchFolders({ PATH: "C:\\a:/b" }, "linux").slice(0, 1)).toEqual(["/b"])
  })

  test("the extra folders are rooted too: a relative HOME or BUN_INSTALL names no folder", () => {
    const folders = hostSearchFolders(
      { PATH: "/a", HOME: "home", BUN_INSTALL: ".", MISE_DATA_DIR: "mise" },
      "linux",
    )
    expect(folders.filter((folder) => !folder.startsWith("/"))).toEqual([])
    expect(folders).not.toContain("bin")
    expect(folders).toContain("/usr/local/bin")
    const windows = hostSearchFolders(
      { Path: "C:\\a", USERPROFILE: "profile", LOCALAPPDATA: "local", APPDATA: ".\\roaming" },
      "win32",
    )
    expect(windows).toEqual(["C:\\a"])
  })

  test("Windows reads Path without regard to case, keeps drive folders only and adds its own places", () => {
    const folders = hostSearchFolders(
      {
        Path: 'C:\\Tools;"C:\\Quoted Tools";relative;\\\\server\\share',
        USERPROFILE: "C:\\Users\\me",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
        SystemRoot: "C:\\Windows",
      },
      "win32",
    )
    expect(folders.slice(0, 3)).toEqual(["C:\\Tools", "C:\\Quoted Tools", "\\\\server\\share"])
    expect(folders).toContain("C:\\Users\\me\\.bun\\bin")
    expect(folders).toContain("C:\\Users\\me\\AppData\\Local\\mise\\shims")
    expect(folders).toContain("C:\\Windows\\System32")
    expect(hostPathValue({ Path: "C:\\Tools", SystemRoot: "C:\\Windows" }, "win32")).toBe(
      "C:\\Tools;C:\\Windows\\System32;C:\\Windows",
    )
  })

  test("Windows finds Git for Windows in its machine-wide and per-user folders when Path lacks them", () => {
    const folders = hostSearchFolders(
      {
        Path: "C:\\Tools",
        ProgramFiles: "C:\\Program Files",
        ProgramW6432: "C:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      },
      "win32",
    )
    expect(folders).toContain("C:\\Program Files\\Git\\cmd")
    expect(folders).toContain("C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd")
    expect(folders.filter((folder) => folder === "C:\\Program Files\\Git\\cmd")).toHaveLength(1)
    // Without the variables there is no folder to name, and nothing relative is made up.
    expect(hostSearchFolders({ Path: "C:\\Tools" }, "win32")).toEqual(["C:\\Tools"])
  })

  test("a Windows program is a file with a PATHEXT extension, named without it, the first extension preferred", () => {
    const extensions = programExtensions({ PATHEXT: ".COM;.EXE;.BAT;.CMD" })
    expect(extensions).toEqual([".com", ".exe", ".bat", ".cmd"])
    expect(programName("Git.EXE", "win32", extensions)).toEqual({ name: "git", rank: 1 })
    expect(programName("mise.cmd", "win32", extensions)).toEqual({ name: "mise", rank: 3 })
    expect(programName("notes.txt", "win32", extensions)).toBeUndefined()
    expect(programName("git", "win32", extensions)).toBeUndefined()
    expect(programName("git", "linux", [])).toEqual({ name: "git", rank: 0 })
    expect(programName("has space", "linux", [])).toBeUndefined()
    expect(programExtensions({})).toEqual([".com", ".exe", ".bat", ".cmd"])
  })

  test.skipIf(WINDOWS)(
    "finds executable files, skips the others, and the first folder keeps a name",
    async () => {
      const first = join(work, "scan-first")
      const second = join(work, "scan-second")
      await mkdir(first, { recursive: true })
      await mkdir(second, { recursive: true })
      for (const [folder, name, mode] of [
        [first, "tool", 0o755],
        [first, "plain", 0o644],
        [second, "tool", 0o755],
        [second, "other", 0o755],
      ] as const) {
        await writeFile(join(folder, name), "#!/bin/sh\n")
        await chmod(join(folder, name), mode)
      }
      const found = await Effect.runPromise(scanHostPrograms([first, second, join(work, "no")]))
      expect(found.get("tool")).toBe(join(first, "tool"))
      expect(found.get("other")).toBe(join(second, "other"))
      expect(found.has("plain")).toBe(false)
    },
  )
})

describe("paths on Windows, where each drive is a folder of the shell", () => {
  const drives = new Set(["c", "d"])

  test("a host path becomes the shell's, and back", () => {
    expect(toVirtualPath("C:\\proj\\src", "win32")).toBe("/c/proj/src")
    expect(toVirtualPath("D:\\", "win32")).toBe("/d")
    expect(toHostPath("/c/proj/src", drives, "win32")).toBe("C:\\proj\\src")
    expect(toHostPath("/d", drives, "win32")).toBe("D:\\")
    expect(toHostPath("/usr/bin", drives, "win32")).toBe("/usr/bin")
    expect(toHostPath("/e/other", drives, "win32")).toBe("/e/other")
  })

  test("an argument for a host program below a drive is mapped; a bare /c is a switch, not a drive", () => {
    expect(toHostArgument("/c/proj/x.ts", drives, "win32")).toBe("C:\\proj\\x.ts")
    expect(toHostArgument("/c", drives, "win32")).toBe("/c")
    expect(toHostArgument("--flag", drives, "win32")).toBe("--flag")
  })

  test("every path is its own on another system", () => {
    expect(toVirtualPath("/home/me", "linux")).toBe("/home/me")
    expect(toHostPath("/c/proj", drives, "darwin")).toBe("/c/proj")
    expect(toHostArgument("/c/proj/x", drives, "linux")).toBe("/c/proj/x")
  })
})

describe("TypeScript first, JavaScript as the fallback", () => {
  test("reads code as TypeScript and removes the types", async () => {
    const prepared = await Effect.runPromise(typeScriptFirst("const n: number = 2; console.log(n)"))
    expect(prepared.language).toBe("typescript")
    expect(prepared.code).not.toContain(": number")
  })

  test("compiles what only TypeScript has, an enum", async () => {
    const prepared = await Effect.runPromise(typeScriptFirst("enum E { A, B }; console.log(E.B)"))
    expect(prepared.language).toBe("typescript")
    expect(prepared.code).not.toContain("enum E")
  })

  test("runs JavaScript that TypeScript's grammar refuses as written", async () => {
    const code = "function f(a, a) { return a }; console.log(f(1, 2))"
    const prepared = await Effect.runPromise(typeScriptFirst(code))
    expect(prepared).toEqual({ code, language: "javascript" })
  })
})

describe("the state a run leaves, on Windows", () => {
  const drives = new Set(["c", "d"])
  const start = `${SHELL_PATH}:/c/tools:/d/bin`

  test("the folder goes back to Pi as a Windows path, and maps back to the shell's for the next call", () => {
    const ended = endState({
      before: { PATH: start },
      after: { PATH: start },
      cwd: "/c/Users/me/proj",
      startPath: start,
      pathKey: "Path",
      drives,
      platform: "win32",
    })
    expect(ended.cwd).toBe("C:\\Users\\me\\proj")
    expect(toVirtualPath(ended.cwd, "win32")).toBe("/c/Users/me/proj")
    const root = endState({
      before: {},
      after: {},
      cwd: "/d",
      startPath: start,
      pathKey: undefined,
      drives,
      platform: "win32",
    })
    expect(root.cwd).toBe("D:\\")
    // Outside the mounted drives the shell's own path stays, as does any path elsewhere.
    for (const [cwd, kept] of [
      ["/usr/bin", "/usr/bin"],
      ["/e/other", "/e/other"],
    ] as const)
      expect(
        endState({
          before: {},
          after: {},
          cwd,
          startPath: start,
          pathKey: undefined,
          drives,
          platform: "win32",
        }).cwd,
      ).toBe(kept)
  })

  test("a PATH the run changed is reported in the machine's spelling, under the name the request used", () => {
    const after = { PATH: `${start}:/c/new tools:relative:/usr/bin:/c/tools` }
    const ended = endState({
      before: { PATH: start },
      after,
      cwd: "/c",
      startPath: start,
      pathKey: "Path",
      drives,
      platform: "win32",
    })
    expect(ended.changes.set).toEqual({ Path: "C:\\tools;D:\\bin;C:\\new tools" })
    expect(ended.changes.unset).toEqual([])
  })

  test("a PATH left as it started is not reported, and on another system paths pass unchanged", () => {
    const same = endState({
      before: { PATH: start, A: "1" },
      after: { PATH: start, A: "2" },
      cwd: "/c/x",
      startPath: start,
      pathKey: "Path",
      drives,
      platform: "linux",
    })
    expect(same).toEqual({ cwd: "/c/x", changes: { set: { A: "2" }, unset: [] } })
    const moved = endState({
      before: { PATH: "/usr/bin:/bin:/a" },
      after: { PATH: "/usr/bin:/bin:/a:/b:rel" },
      cwd: "/h",
      startPath: "/usr/bin:/bin:/a",
      pathKey: undefined,
      drives: new Set(),
      platform: "linux",
    })
    expect(moved.changes.set).toEqual({ PATH: "/a:/b" })
  })
})

describe("the shell runs commands", () => {
  test(
    "a command just-bash lacks runs the host's program, with its exit code and output",
    async () => {
      const version = await shell(`${HOST} --version`)
      expect(version.text.trim()).toBe(Bun.version)
      expect(version.exitCode).toBe(0)
      const failing = await shell(`${HOST} -e "process.exit(7)"`)
      expect(failing.exitCode).toBe(7)
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "a host program sits in a pipeline with the built-ins, in both directions",
    async () => {
      const out = await shell(`${HOST} --version | tr -d '\\n' | wc -c`)
      expect(out.text.trim()).toBe(String(Bun.version.length))
      const input = await shell(
        `echo piped | ${HOST} -e "console.log((await Bun.stdin.text()).trim().toUpperCase())"`,
      )
      expect(input.text.trim()).toBe("PIPED")
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "the host program gets the real PATH, and the shell's own PATH is its two folders and then the call's",
    async () => {
      const seen = await shell(`${HOST} -e "console.log(process.env.PATH)"`)
      expect(seen.text.split(delimiter)).toContain(HOST_DIR)
      expect(seen.text.trim().startsWith(SHELL_PATH)).toBe(false)
      // Inside the shell every path is the shell's: `C:\\bun` is `/c/bun` on Windows.
      expect((await shell("echo $PATH")).text.trim()).toBe(
        `${SHELL_PATH}:${toVirtualPath(HOST_DIR)}`,
      )
      // The call's env is only PATH and HOME, so the one host program certain to be found is the
      // Bun that runs the tests, which sits in the call's PATH; `git` is not (on Windows it is
      // found through `ProgramFiles`, which this env does not have).
      expect((await shell(`which ${HOST.toLowerCase()} cat`)).text).toBe(
        `/usr/bin/${HOST.toLowerCase()}\n/usr/bin/cat\n`,
      )
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "binary output of a host program reaches Pi byte for byte",
    async () => {
      const out = await shell(
        `${HOST} -e "process.stdout.write(Buffer.from([0, 255, 128, 10, 13]))"`,
      )
      expect([...out.output]).toEqual([0, 255, 128, 10, 13])
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "a host program's output is sent as it arrives when the command is that program alone",
    async () => {
      const alone = await shell(`${HOST} -e "console.log('a'); console.log('b')"`)
      expect(alone.text).toBe("a\nb\n")
      expect(alone.frames.at(-1)?.type).toBe("end")
      const piped = await shell(`${HOST} -e "console.log('a')" | cat`)
      expect(piped.text).toBe("a\n")
    },
    PROCESS_TIMEOUT_MS,
  )

  test("a built-in command wins over a program of the same name on the machine", async () => {
    const out = await shell("echo from-the-shell | cat")
    expect(out.text).toBe("from-the-shell\n")
  })

  test.skipIf(WINDOWS)(
    "a program the built-ins shadow is the shell's own, and host-<name> runs the machine's",
    async () => {
      const bin = join(work, "shadow-bin")
      await mkdir(bin, { recursive: true })
      for (const [name, text] of [
        ["cat", "HOST-CAT"],
        ["node", "HOST-NODE"],
      ] as const) {
        await writeFile(join(bin, name), `#!/bin/sh\necho ${text}\n`)
        await chmod(join(bin, name), 0o755)
      }
      const path = [bin, HOST_DIR].join(delimiter)
      expect((await shell("echo shell | cat", { path })).text).toBe("shell\n")
      expect((await shell("host-cat", { path })).text).toBe("HOST-CAT\n")
      // `node` is not implemented by just-bash, so the machine's program runs.
      expect((await shell("node", { path })).text).toBe("HOST-NODE\n")
    },
    PROCESS_TIMEOUT_MS,
  )

  test.skipIf(WINDOWS)("a program found through a symlink in PATH runs", async () => {
    const bin = join(work, "link-bin")
    await mkdir(bin, { recursive: true })
    await symlink(process.execPath, join(bin, "linked-bun"))
    const out = await shell("linked-bun --version", { path: bin })
    expect(out.text.trim()).toBe(Bun.version)
  })

  test("js-exec runs TypeScript: inline, on standard input and from a .ts file", async () => {
    expect((await shell("js-exec -c 'const n: number = 2; console.log(n * 21)'")).text).toBe("42\n")
    expect((await shell("echo 'enum E { A, B }; console.log(E.B as number)' | js-exec")).text).toBe(
      "1\n",
    )
    await writeFile(join(work, "typed.ts"), "const who: string = 'ts'\nconsole.log(who)\n")
    expect((await shell("js-exec typed.ts")).text).toBe("ts\n")
  })

  test("js-exec falls back to JavaScript for code TypeScript's grammar refuses", async () => {
    const out = await shell("js-exec -c 'function f(a, a) { return a }; console.log(f(1, 2))'")
    expect(out.text).toBe("2\n")
    expect(out.exitCode).toBe(0)
  })

  test("a file of the host is the same file in the shell, read and written", async () => {
    await writeFile(join(work, "in.txt"), "line\n")
    const out = await shell("cat in.txt > out.txt && echo more >> out.txt && cat out.txt")
    expect(out.text).toBe("line\nmore\n")
    expect(await Bun.file(join(work, "out.txt")).text()).toBe("line\nmore\n")
  })

  test("the folder and the exported variables a call leaves are reported, also after a failure", async () => {
    await mkdir(join(work, "sub"), { recursive: true })
    const out = await shell("cd sub && export KEPT=1 && false")
    expect(out.exitCode).toBe(1)
    expect(out.cwd).toBe(join(work, "sub"))
    expect(out.changes.set).toEqual({ KEPT: "1" })
    const removed = await shell("unset REMOVED", { env: { REMOVED: "x" } })
    expect(removed.changes.unset).toEqual(["REMOVED"])
  })

  test("the exit code of exit is the call's", async () => {
    expect((await shell("exit 3")).exitCode).toBe(3)
  })
})

describe("what the shell can read as a script and what only the machine can run", () => {
  test("names the interpreter of a #! line, through env too", () => {
    expect(interpreterOf(Buffer.from("#!/bin/bash\n"))).toBe("bash")
    expect(interpreterOf(Buffer.from("#!/usr/bin/env node\n"))).toBe("node")
    expect(interpreterOf(Buffer.from("#!/usr/bin/env -S bash -e\n"))).toBe("bash")
    expect(interpreterOf(Buffer.from("#! /bin/sh -e\n"))).toBe("sh")
    expect(interpreterOf(Buffer.from("echo hi\n"))).toBeUndefined()
  })

  test.skipIf(WINDOWS)(
    "a shell script is the shell's, a binary and a script for another interpreter are the machine's",
    async () => {
      const files: ReadonlyArray<
        readonly [string, Uint8Array | string, number, "native" | "script" | undefined]
      > = [
        ["kind-sh", "#!/bin/sh\necho hi\n", 0o755, "script"],
        ["kind-bash", "#!/usr/bin/env bash\necho hi\n", 0o755, "script"],
        ["kind-bare", "echo hi\n", 0o755, "script"],
        ["kind-node", "#!/usr/bin/env node\nconsole.log(1)\n", 0o755, "native"],
        ["kind-zsh", "#!/bin/zsh\necho hi\n", 0o755, "native"],
        ["kind-elf", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 0o755, "native"],
        ["kind-plain", "#!/usr/bin/env node\n", 0o644, undefined],
      ]
      for (const [name, content, mode, kind] of files) {
        await writeFile(join(work, name), content)
        await chmod(join(work, name), mode)
        expect(programKind(join(work, name), "linux", [])).toBe(kind)
      }
      expect(programKind(join(work, "kind-missing"), "linux", [])).toBeUndefined()
      expect(programKind(work, "linux", [])).toBeUndefined()
    },
  )

  test("on Windows a file with a PATHEXT extension is the machine's whatever it holds", async () => {
    await writeFile(join(work, "kind.cmd"), "@echo off\n")
    await writeFile(join(work, "kind.txt"), "text\n")
    const extensions = programExtensions({})
    expect(programKind(join(work, "kind.cmd"), "win32", extensions)).toBe("native")
    expect(programKind(join(work, "kind.txt"), "win32", extensions)).toBe("script")
  })
})

describe("the file system that points a program given by path at the machine", () => {
  const fake = (files: Record<string, string>) => {
    const calls: Array<string> = []
    const fs = {
      exists: (path: string) => {
        calls.push(`exists ${path}`)
        return Effect.runPromise(Effect.succeed(path in files))
      },
      stat: (path: string) => {
        calls.push(`stat ${path}`)
        return Effect.runPromise(
          Effect.succeed({ isFile: true, isDirectory: false, mode: 0o644, size: 1 }),
        )
      },
      readFile: (path: string) => {
        calls.push(`readFile ${path}`)
        return Effect.runPromise(Effect.succeed(files[path] ?? ""))
      },
    }
    return { fs: fs as never, calls }
  }
  const options = { toHost: (path: string) => path, platform: process.platform, extensions: [] }

  test.skipIf(WINDOWS)(
    "reads a native file as the one-line script when the shell asks the way it runs a script, and any other read as the file",
    async () => {
      const native = join(work, "launch-native")
      const script = join(work, "launch-script")
      await writeFile(native, "#!/usr/bin/env node\nthe bytes\n")
      await writeFile(script, "#!/bin/sh\necho hi\n")
      await chmod(native, 0o755)
      await chmod(script, 0o755)
      const { fs } = fake({ [native]: "the bytes", [script]: "echo hi" })
      const wrapped = withProgramLaunch(fs, options)
      // `cat` and `grep` read without the `exists` before the `stat`.
      expect(await wrapped.readFile(native)).toBe("the bytes")
      await wrapped.stat(native)
      expect(await wrapped.readFile(native)).toBe("the bytes")
      // The way the shell resolves a command and then reads it as a script.
      await wrapped.exists(native)
      await wrapped.stat(native)
      expect(await wrapped.readFile(native)).toBe(trampoline(native))
      expect(trampoline(native)).toContain(`${RUNNER_PATH} '${native}' "$@"`)
      // A shell script, and a read of another file after the two calls, stay as they are.
      await wrapped.exists(script)
      await wrapped.stat(script)
      expect(await wrapped.readFile(script)).toBe("echo hi")
      await wrapped.exists(native)
      await wrapped.stat(native)
      expect(await wrapped.readFile(script)).toBe("echo hi")
    },
  )

  test("a path with a quote in it is quoted for the script", () => {
    expect(trampoline("/a/it's")).toContain(`'/a/it'\\''s'`)
  })

  test("on Windows stat reports the execute bit of a file with a program extension, as just-bash requires", async () => {
    const { fs } = fake({})
    const wrapped = withProgramLaunch(fs, {
      toHost: (path) => path,
      platform: "win32",
      extensions: [".exe", ".cmd"],
    })
    expect((await wrapped.stat("/c/tools/git.exe")).mode & 0o111).toBe(0o111)
    expect((await wrapped.stat("/c/tools/notes.txt")).mode & 0o111).toBe(0)
  })
})

describe("how a host program is started", () => {
  test("a program is started as it is, with its arguments", () => {
    expect(hostLaunch("/bin/git", ["status", "a b"], "linux")).toEqual({
      ok: true,
      cmd: ["/bin/git", "status", "a b"],
    })
    expect(hostLaunch("C:\\tools\\git.exe", ["status"], "win32")).toEqual({
      ok: true,
      cmd: ["C:\\tools\\git.exe", "status"],
    })
    // A .cmd file on another system is a file like any other.
    expect(hostLaunch("/x/run.cmd", ["a"], "linux")).toEqual({ ok: true, cmd: ["/x/run.cmd", "a"] })
  })

  test("a .cmd or .bat file on Windows goes through cmd.exe with the arguments quoted by the shim rules", () => {
    for (const file of ["C:\\npm\\tsc.cmd", "C:\\npm\\RUN.BAT"])
      expect(
        hostLaunch(file, ["--project", "C:\\a b\\x"], "win32", "C:\\Windows\\system32\\cmd.exe"),
      ).toEqual({
        ok: true,
        cmd: [
          "C:\\Windows\\system32\\cmd.exe",
          "/d",
          "/s",
          "/c",
          "call",
          file,
          "--project",
          "C:\\a b\\x",
        ],
      })
    expect(hostLaunch("C:\\npm\\tsc.cmd", [], "win32")).toMatchObject({ ok: true })
  })

  test("a word cmd.exe would read as syntax is refused, and nothing is started", () => {
    const shim = "C:\\npm\\tsc.cmd"
    for (const word of ['a"b', "50%", "a^b", "a!b", "a\nb", "a b%PATH%", 'x y" & calc & "z']) {
      expect(cmdExeArguments(shim, ["--project", word]).ok).toBe(false)
      expect(hostLaunch(shim, ["--project", word], "win32").ok).toBe(false)
    }
    expect(cmdExeArguments("C:\\a&b\\tsc.cmd", []).ok).toBe(false)
    for (const word of ["C:\\a&b", "C:\\a|b", "C:\\a<b", "C:\\a>b", "C:\\(x86)"])
      expect(cmdExeArguments(shim, [word]).ok).toBe(false)
    // In quotes, which Node adds to a word with a space, the same characters are literal.
    expect(cmdExeArguments(shim, ["C:\\Program Files (x86)\\a&b"])).toEqual({
      ok: true,
      args: ["/d", "/s", "/c", "call", shim, "C:\\Program Files (x86)\\a&b"],
    })
  })
})

describe("a host program's output keeps the order it arrived in", () => {
  const chunk = (stream: "out" | "err", text: string) => ({
    stream,
    bytes: Buffer.from(text),
  })
  const log = [chunk("out", "a\n"), chunk("err", "b\n"), chunk("out", "c\n")]
  const text = (chunks: ReadonlyArray<Uint8Array> | undefined) =>
    chunks === undefined ? undefined : Buffer.concat(chunks).toString()

  test("is the log's order when the result is exactly that output, split or merged by 2>&1", () => {
    expect(text(emittedOrder(log, Buffer.from("a\nc\n"), Buffer.from("b\n")))).toBe("a\nb\nc\n")
    expect(text(emittedOrder(log, Buffer.from("a\nc\nb\n"), Buffer.from("")))).toBe("a\nb\nc\n")
  })

  test("is left to the caller when the result holds anything else", () => {
    expect(emittedOrder(log, Buffer.from("a\nc\nmore\n"), Buffer.from("b\n"))).toBeUndefined()
    expect(emittedOrder(log, Buffer.from("c\n"), Buffer.from("b\n"))).toBeUndefined()
    expect(emittedOrder([], Buffer.from(""), Buffer.from(""))).toBeUndefined()
  })
})

describe("the shell runs a program given by path on the machine", () => {
  // A program the machine's Bun runs: its #! line names Bun by its full path, as the kernel needs.
  const program = async (path: string, code: string) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `#!${process.execPath}\n${code}\n`)
    await chmod(path, 0o755)
  }
  const ARGS = "console.log('prog:' + process.argv.slice(2).join(','))"

  test.skipIf(WINDOWS)(
    "a relative path, an absolute path and a symlink in a .bin folder, with arguments and the exit code",
    async () => {
      await program(join(work, "path-prog"), `${ARGS}; process.exit(4)`)
      const relative = await shell("./path-prog a 'b c'")
      expect(relative.text).toBe("prog:a,b c\n")
      expect(relative.exitCode).toBe(4)
      expect((await shell(`${join(work, "path-prog")} x`)).text).toBe("prog:x\n")

      await program(join(work, "path-lib", "tsc.js"), ARGS)
      await mkdir(join(work, "path-modules", ".bin"), { recursive: true })
      await symlink("../../path-lib/tsc.js", join(work, "path-modules", ".bin", "tsc"))
      const linked = await shell("path-modules/.bin/tsc --version")
      expect(linked.text).toBe("prog:--version\n")
      expect(linked.exitCode).toBe(0)
    },
    PROCESS_TIMEOUT_MS,
  )

  test.skipIf(WINDOWS)(
    "a binary runs, standard input reaches the program, and it sits in a pipeline",
    async () => {
      await symlink(process.execPath, join(work, "path-native")).catch(() => undefined)
      expect((await shell("./path-native --version")).text.trim()).toBe(Bun.version)
      await program(
        join(work, "path-upper"),
        "console.log((await Bun.stdin.text()).trim().toUpperCase())",
      )
      expect((await shell("echo piped | ./path-upper | tr a-z A-Z")).text).toBe("PIPED\n")
    },
    PROCESS_TIMEOUT_MS,
  )

  test.skipIf(WINDOWS)(
    "a shell script given by path still runs in the shell, and reading a program shows its text",
    async () => {
      await writeFile(join(work, "path-script"), '#!/bin/sh\necho "script:$1"\n')
      await chmod(join(work, "path-script"), 0o755)
      expect((await shell("./path-script z")).text).toBe("script:z\n")
      await program(join(work, "path-readable"), ARGS)
      const read = await shell("head -1 ./path-readable; grep -c prog: ./path-readable")
      expect(read.text).toBe(`#!${process.execPath}\n1\n`)
    },
    PROCESS_TIMEOUT_MS,
  )

  test.skipIf(WINDOWS)(
    "a binary given by path reads as its bytes, also after a file test, and still runs on the machine",
    async () => {
      const path = join(work, "path-bytes")
      await program(path, "console.log('ran')")
      const bytes = await Bun.file(path).text()
      for (const command of [
        "cat ./path-bytes",
        "[ -x ./path-bytes ] && cat ./path-bytes",
        "[ -e ./path-bytes ] && [ -x ./path-bytes ] && cat ./path-bytes",
        "[[ -x ./path-bytes ]] && sed -n p ./path-bytes",
      ])
        expect(await shell(command)).toMatchObject({ exitCode: 0, text: bytes })
      expect((await shell("test -x ./path-bytes && grep -c ran ./path-bytes")).text).toBe("1\n")
      const diff = await shell("[ -x ./path-bytes ] && diff ./path-bytes ./path-bytes")
      expect(diff).toMatchObject({ exitCode: 0, text: "" })
      expect(
        (await shell("cat ./path-bytes >/dev/null; [ -x ./path-bytes ] && ./path-bytes")).text,
      ).toBe("ran\n")
    },
    PROCESS_TIMEOUT_MS,
  )

  test.skipIf(WINDOWS)(
    "a folder added to PATH in the call is searched, and the program gets it in its PATH",
    async () => {
      const bin = join(work, "path-added")
      await program(
        join(bin, "added-tool"),
        "console.log(process.env.PATH.split(':')[0] + ' ' + process.argv.slice(2))",
      )
      const out = await shell(`export PATH=${bin}:$PATH; added-tool q; echo $PATH`)
      expect(out.text.split("\n")[0]).toBe(`${bin} q`)
      expect(out.text.split("\n")[1]?.startsWith(`${bin}:${SHELL_PATH}`)).toBe(true)
      // Reported as the machine's PATH, without the shell's own folders, so the next call can use it.
      expect(out.changes.set["PATH"]).toBe(`${bin}${delimiter}${HOST_DIR}`)
      const next = await shell("added-tool again", { path: out.changes.set["PATH"] ?? "" })
      expect(next.text).toBe(`${bin} again\n`)
      expect((await shell("added-tool nope")).exitCode).toBe(127)
    },
    PROCESS_TIMEOUT_MS,
  )

  test.skipIf(WINDOWS)(
    "a program given by path is the whole command, and a PATH the call left alone is not reported",
    async () => {
      await program(join(work, "path-stream"), ARGS)
      const out = await shell("./path-stream s")
      expect(out.text).toBe("prog:s\n")
      expect(out.changes.set["PATH"]).toBeUndefined()
    },
    PROCESS_TIMEOUT_MS,
  )
})

describe("exit keeps the state the run had", () => {
  test("the folder, the variables and the exit code", async () => {
    await mkdir(join(work, "exit-sub"), { recursive: true })
    const out = await shell("cd exit-sub; export B=2; unset A; exit 3", { env: { A: "1" } })
    expect(out.exitCode).toBe(3)
    expect(out.cwd).toBe(join(work, "exit-sub"))
    expect(out.changes).toEqual({ set: { B: "2" }, unset: ["A"] })
  })

  test("a bare exit keeps the status of the last command, also from a function and a condition", async () => {
    await mkdir(join(work, "exit-fn"), { recursive: true })
    expect((await shell("false; exit")).exitCode).toBe(1)
    const inFunction = await shell("f() { cd exit-fn; X=1; exit 6; }; f; echo not reached")
    expect(inFunction).toMatchObject({ exitCode: 6, text: "" })
    expect(inFunction.cwd).toBe(join(work, "exit-fn"))
    expect(inFunction.changes.set).toEqual({ X: "1" })
    const guarded = await shell("cd exit-fn && true || exit 9; test -d nope && exit 8; Y=2")
    expect(guarded.exitCode).toBe(0)
    expect(guarded.changes.set).toEqual({ Y: "2" })
    expect((await shell("true && cd exit-fn && exit")).cwd).toBe(join(work, "exit-fn"))
  })

  test("an exit in a subshell ends the subshell only, and a script that ends by itself reports as before", async () => {
    const out = await shell("(cd /usr; exit 5); echo after; export Z=1")
    expect(out).toMatchObject({ exitCode: 0, text: "after\n", cwd: work })
    expect(out.changes.set).toEqual({ Z: "1" })
    // `bash -c` is another script: its exit is its own, and this script's state still reports.
    const nested = await shell("bash -c 'exit 3'; echo \"rc=$?\"; export N=1")
    expect(nested.text).toBe("rc=3\n")
    expect(nested.changes.set).toEqual({ N: "1" })
  })

  test("an exit in a subshell or a command substitution leaves the state of the shell around it alone", async () => {
    // The script ends by `set -e`, not by an `exit` of its own, so only what the shell had counts.
    const sub = await shell("export A=1; set -e; (cd /usr; export B=2; exit 3); echo not reached")
    expect(sub).toMatchObject({ exitCode: 3, text: "", cwd: work })
    expect(sub.changes).toEqual({ set: { A: "1" }, unset: [] })
    const substitution = await shell(
      "set -e; export A=1; V=$(export B=2; exit 4); echo not reached",
    )
    expect(substitution.exitCode).toBe(4)
    expect(substitution.changes.set).not.toHaveProperty("B")
    expect(substitution.changes.set).toMatchObject({ A: "1" })
    // A subshell's exit does not stop the exit of the shell itself from recording its state.
    const both = await shell("export A=1; (export B=2; exit 3); export C=3; exit 4")
    expect(both.exitCode).toBe(4)
    expect(both.changes.set).toEqual({ A: "1", C: "3" })
  })

  test("declare outside a function is session state when exit runs, local inside one is not", async () => {
    const out = await shell("declare D=1; typeset T=2; f() { local L=1; declare M=2; exit 2; }; f")
    expect(out.exitCode).toBe(2)
    expect(out.changes).toEqual({ set: { D: "1", T: "2" }, unset: [] })
  })

  test("the local variables of the function that calls exit are not session state", async () => {
    const out = await shell("f() { local L=1 M; G=2; exit 3; }; f", { env: { M: "keep" } })
    expect(out.exitCode).toBe(3)
    expect(out.changes).toEqual({ set: { G: "2" }, unset: [] })
    const nested = await shell(
      "f() { local L=1; g() { local K=2; exit 4; }; g; }; f; echo not reached",
    )
    expect(nested.changes).toEqual({ set: {}, unset: [] })
  })
})

describe("redirects to /dev/null", () => {
  // What only just-bash's own commands do, so it holds on every system, Windows included.
  test("discard what a builtin writes, and /dev/null reads as empty", async () => {
    expect(await shell("echo hidden >/dev/null; echo shown")).toMatchObject({
      exitCode: 0,
      text: "shown\n",
    })
    expect((await shell("echo hidden > /dev/null; echo more >> /dev/null; echo shown")).text).toBe(
      "shown\n",
    )
    expect((await shell("ls /nope-missing 2>/dev/null; echo rc=$?")).text).toBe("rc=2\n")
    expect((await shell("{ echo out; echo err >&2; } &>/dev/null; echo shown")).text).toBe(
      "shown\n",
    )
    expect((await shell("{ echo out; echo err >&2; } >/dev/null 2>&1; echo shown")).text).toBe(
      "shown\n",
    )
    expect(
      (await shell('cat </dev/null; echo -n "[$(cat /dev/null)]"; wc -c </dev/null')).text,
    ).toMatch(/^\[\]\s*0\n?$/)
    expect((await shell("echo a >/dev/null; cat /dev/null | wc -c")).text.trim()).toBe("0")
  })

  test.skipIf(WINDOWS)(
    "discard what a host program writes",
    async () => {
      const noisy = `${HOST} -e "console.log('out'); console.error('err')"`
      expect((await shell(`${noisy} >/dev/null`)).text).toBe("err\n")
      expect((await shell(`${noisy} 2>/dev/null`)).text).toBe("out\n")
      expect((await shell(`${noisy} &>/dev/null; echo done`)).text).toBe("done\n")
      expect((await shell(`${noisy} >/dev/null 2>&1; echo done`)).text).toBe("done\n")
    },
    PROCESS_TIMEOUT_MS,
  )

  test("no file system call on the device reaches the disk, whatever the call or the spelling", async () => {
    const seen: Array<string> = []
    const methods = [
      "readFile",
      "readFileBytes",
      "readFileBuffer",
      "writeFile",
      "appendFile",
      "exists",
      "stat",
      "lstat",
      "mkdir",
      "readdir",
      "rm",
      "cp",
      "mv",
      "chmod",
      "symlink",
      "link",
      "readlink",
      "realpath",
      "utimes",
    ]
    const disk = Object.fromEntries(
      methods.map((name) => [
        name,
        (...args: Array<unknown>) => {
          seen.push(`${name} ${String(args[0])}`)
          // The guard asks for real paths and for what a copy reads; neither changes the disk.
          return Effect.runPromise(
            Effect.succeed(
              name === "realpath" ? args[0] : name === "stat" ? { isDirectory: false } : undefined,
            ),
          )
        },
      ]),
    )
    const fs = withNullDevice(disk as never) as unknown as Record<
      string,
      (...args: Array<unknown>) => Promise<unknown>
    >
    const settled = async (name: string, ...args: Array<unknown>) =>
      (fs[name] as (...args: Array<unknown>) => Promise<unknown>)(...args).then(
        () => "ok",
        (error: Error) => error.message,
      )
    for (const device of [
      "/dev/null",
      "/dev//null",
      "/dev/./null",
      "/dev/../dev/null",
      "/dev/null/",
    ]) {
      for (const name of methods.filter(
        (method) => !["cp", "mv", "symlink", "link"].includes(method),
      ))
        await settled(name, device, 0o600, new Date(0))
      await settled("cp", device, "/dev/null", { recursive: true })
      await settled("cp", "/tmp/x", device)
      await settled("cp", device, "/tmp/copy")
      await settled("mv", device, "/tmp/y")
      await settled("mv", "/tmp/y", device)
      await settled("symlink", device, "/tmp/link")
      await settled("symlink", "/tmp/target", device)
      await settled("link", device, "/tmp/link")
      await settled("link", "/tmp/target", device)
    }
    // A copy from the device makes an empty file at the destination, which is the only call through.
    expect([...new Set(seen)].filter((call) => !/^(realpath|stat) /.test(call))).toEqual([
      "writeFile /tmp/copy",
    ])
  })

  test("rm, mv, mkdir, ln and the other calls that would change the device are refused, copies to it vanish, and chmod does nothing", async () => {
    await writeFile(join(work, "null-source"), "kept\n")
    for (const command of [
      "rm /dev/null",
      "mv /dev/null null-moved",
      "mv null-source /dev/null",
      "mv -f null-source /dev/null",
      "mkdir /dev/null",
      "mkdir -p /dev/null",
      "ln /dev/null null-hard",
      "ln -s /dev/null null-soft",
      "ln -sf null-source /dev/null",
      "readlink /dev/null",
    ]) {
      const out = await shell(`${command} 2>/dev/null; echo rc=$?`)
      expect(`${command}: ${out.text.trim()}`).toMatch(/: rc=[1-9]\d*$/)
    }
    // `rm -f` hides the refusal, as it hides any other failure, and the device is still there.
    expect(
      (await shell("rm -f /dev/null; rm -rf /dev/null; test -e /dev/null && echo there")).text,
    ).toBe("there\n")
    // The source of a refused move or link is still there, and nothing was made.
    expect(
      (await shell("cat null-source; ls null-moved null-hard null-soft 2>&1 | wc -l")).text,
    ).toMatch(/^kept\n\s*3\n?$/)
    expect(
      (await shell("cp null-source /dev/null; echo rc=$?; cat /dev/null | wc -c")).text,
    ).toMatch(/^rc=0\n\s*0\n?$/)
    expect(
      (await shell("chmod 000 /dev/null; echo rc=$?; echo ok >/dev/null; echo still")).text,
    ).toBe("rc=0\nstill\n")
    expect(
      (await shell("cp /dev/null null-empty; wc -c < null-empty; ls -l /dev/null | wc -l")).text,
    ).toMatch(/^\s*0\n\s*1\n?$/)
    expect((await shell("cd /dev; rm null; echo rc=$?")).text).toMatch(/^rc=[1-9]/)
    if (!WINDOWS) {
      // The disk's device is what it was.
      const device = await stat("/dev/null")
      expect(device.isCharacterDevice()).toBe(true)
      expect(device.mode & 0o666).toBe(0o666)
    }
  })

  test.skipIf(WINDOWS)("discard what a program given by path writes", async () => {
    await mkdir(join(work, "null-bin"), { recursive: true })
    const path = join(work, "null-bin", "prog")
    await writeFile(path, `#!${process.execPath}\nconsole.log('o'); console.error('e')\n`)
    await chmod(path, 0o755)
    expect((await shell("./null-bin/prog >/dev/null")).text).toBe("e\n")
    expect((await shell("./null-bin/prog 2>/dev/null")).text).toBe("o\n")
    expect((await shell("./null-bin/prog &>/dev/null; echo done")).text).toBe("done\n")
  })
})

describe("a host program's output keeps its order in a run that is not streamed", () => {
  test.skipIf(WINDOWS)(
    "standard output and standard error come back as they were written, also with 2>&1 in a pipe",
    async () => {
      await writeFile(
        join(work, "order.ts"),
        [
          "process.stdout.write('a\\n')",
          "await Bun.sleep(120)",
          "process.stderr.write('b\\n')",
          "await Bun.sleep(120)",
          "process.stdout.write('c\\n')",
        ].join("\n"),
      )
      expect((await shell(`${HOST} order.ts; true`)).text).toBe("a\nb\nc\n")
      expect((await shell(`${HOST} order.ts 2>&1 | cat`)).text).toBe("a\nb\nc\n")
      // With anything else in the output the order of just-bash's own result stands.
      expect((await shell(`echo first; ${HOST} order.ts | cat`)).text).toBe("first\na\nc\nb\n")
    },
    PROCESS_TIMEOUT_MS,
  )
})
