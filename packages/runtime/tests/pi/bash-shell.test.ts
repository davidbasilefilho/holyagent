import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, parse } from "node:path"

import { Effect } from "effect"

import {
  hostPathValue,
  hostSearchFolders,
  programExtensions,
  programName,
  scanHostPrograms,
} from "../../src/pi/bash/hosts.ts"
import { toHostArgument, toHostPath, toVirtualPath } from "../../src/pi/bash/paths.ts"
import type { ShellFrame } from "../../src/pi/bash/protocol.ts"
import {
  envChanges,
  HOST_PREFIX,
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
    "the host program gets the real PATH, and the shell's own PATH is its two folders",
    async () => {
      const seen = await shell(`${HOST} -e "console.log(process.env.PATH)"`)
      expect(seen.text.split(delimiter)).toContain(HOST_DIR)
      expect((await shell("echo $PATH")).text.trim()).toBe(SHELL_PATH)
      expect((await shell("which git cat")).text).toBe("/usr/bin/git\n/usr/bin/cat\n")
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
