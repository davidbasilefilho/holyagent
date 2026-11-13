import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"

import { Effect, Option } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { INSTALL_COMMANDS, locateTool } from "../src/setup/search-tools.ts"
import { findCommand } from "../src/setup/shell.ts"

const posix = process.platform !== "win32"

let project: string
let bin: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "holyagent-tools-project-"))
  bin = await mkdtemp(join(tmpdir(), "holyagent-tools-bin-"))
})
afterEach(() =>
  Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(bin, { recursive: true, force: true }),
  ]),
)

/** Runs one command line in-process in the temp project with `bin` as the whole PATH. */
const cli = (argv: ReadonlyArray<string>, path: string = bin) =>
  Effect.runPromise(
    run(argv, {
      cwd: project,
      env: { HOME: project, PATH: path },
      stdin: Effect.fail(new StdinMissing({ reason: "no stdin in this test" })),
    }),
  )

describe("finding a search program", () => {
  /** A lookup that finds the named commands at `/bin/<name>` and records what it was asked. */
  const lookup = (present: ReadonlyArray<string>) => {
    const asked: Array<string> = []
    const which = (command: string) =>
      Effect.sync(() => {
        asked.push(command)
        return present.includes(command) ? Option.some(`/bin/${command}`) : Option.none<string>()
      })
    return { asked, which }
  }
  const find = (tool: "rg" | "fd", present: ReadonlyArray<string>) => {
    const { asked, which } = lookup(present)
    return Effect.runPromise(locateTool(tool, project, which)).then((found) => ({
      found: Option.getOrUndefined(found),
      asked,
    }))
  }

  test("rg is the rg on PATH, and only rg is tried", async () => {
    expect(await find("rg", ["rg", "fd"])).toEqual({ found: "/bin/rg", asked: ["rg"] })
    expect(await find("rg", ["fd", "fdfind"])).toEqual({ found: undefined, asked: ["rg"] })
  })

  test("fd is the fd on PATH, else the fdfind that Debian and Ubuntu install", async () => {
    expect(await find("fd", ["fd", "fdfind"])).toEqual({ found: "/bin/fd", asked: ["fd"] })
    expect(await find("fd", ["fdfind"])).toEqual({
      found: "/bin/fdfind",
      asked: ["fd", "fdfind"],
    })
    expect(await find("fd", ["rg"])).toEqual({ found: undefined, asked: ["fd", "fdfind"] })
  })
})

describe("a search program that is not installed", () => {
  test("rg and fd fail with ToolMissing, naming the program and every install command, and exit 4", async () => {
    for (const tool of ["rg", "fd"] as const) {
      const result = await cli([tool, "needle"])
      expect(result.stdout).toBe("")
      expect(result.code).toBe(4)
      expect(result.stderr).toStartWith(`error: ToolMissing: `)
      expect(result.stderr).toContain(tool === "rg" ? "ripgrep (rg)" : "fd (fd or fdfind)")
      for (const [platform, ...commands] of INSTALL_COMMANDS) {
        expect(result.stderr).toContain(platform)
        for (const command of commands) expect(result.stderr).toContain(command)
      }
      expect(result.stderr).toContain("hint: ")
      expect(result.stderr).toContain("grep")
    }
  })

  test("the install commands are the ones for the five platforms", () => {
    expect(INSTALL_COMMANDS).toEqual([
      ["macOS", "brew install ripgrep fd"],
      ["Debian/Ubuntu", "sudo apt install ripgrep fd-find"],
      ["Fedora", "sudo dnf install ripgrep fd-find"],
      ["Arch", "sudo pacman -S ripgrep fd"],
      ["Windows", "winget install BurntSushi.ripgrep.MSVC", "winget install sharkdp.fd"],
    ])
  })
})

describe.skipIf(!posix)("the command line passes through to the program on PATH", () => {
  /** Puts a script that records its arguments and working directory and exits with `code`. */
  const fake = async (name: string, code: number) => {
    const path = join(bin, name)
    await Bun.write(
      path,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/${name}.args"\npwd > "${bin}/${name}.cwd"\nexit ${code}\n`,
    )
    await chmod(path, 0o755)
  }

  test("hands every argument over untouched, --help and -h included, from the working directory", async () => {
    await fake("rg", 0)
    const argv = ["-n", "--help", "-h", "two words", "a*b", "$HOME", "--", "-x"]
    const result = await cli(["rg", ...argv])
    expect(result).toEqual({ stdout: "", stderr: "", code: 0 })
    expect((await Bun.file(join(bin, "rg.args")).text()).split("\n").slice(0, -1)).toEqual(argv)
    // The project is under a temp folder that may be a symlink, so compare resolved paths.
    expect(await realpath((await Bun.file(join(bin, "rg.cwd")).text()).trim())).toBe(
      await realpath(project),
    )
  })

  test("ends with the program's own exit code, so rg and fd results keep their meaning", async () => {
    await fake("rg", 1)
    await fake("fd", 7)
    expect((await cli(["rg", "nothing"])).code).toBe(1)
    const fd = await cli(["fd", "nothing"])
    expect(fd.code).toBe(7)
    expect(fd.stderr).toBe("")
  })

  test("fd runs fdfind when there is no fd, and prefers fd when both exist", async () => {
    await fake("fdfind", 3)
    expect((await cli(["fd", "x"])).code).toBe(3)
    await fake("fd", 4)
    expect((await cli(["fd", "x"])).code).toBe(4)
  })

  test("a relative or empty PATH entry never runs a program of the working directory", async () => {
    // A relative entry means the process directory to the system, which the CLI runs in.
    const before = process.cwd()
    process.chdir(project)
    try {
      await relativeEntries()
    } finally {
      process.chdir(before)
    }
  })

  const relativeEntries = async () => {
    await fake("rg", 0)
    // The project ships its own rg, in its root and in a folder a relative entry would name.
    for (const planted of [join(project, "rg"), join(project, "inside", "rg")]) {
      await Bun.write(planted, `#!/bin/sh\ntouch "${project}/planted"\nexit 9\n`)
      await chmod(planted, 0o755)
    }
    for (const path of [
      `.${delimiter}${bin}`,
      `${delimiter}${bin}`,
      `${delimiter}${delimiter}${bin}`,
      `inside${delimiter}${bin}`,
      `${project}${delimiter}${bin}`,
    ]) {
      expect((await cli(["rg", "x"], path)).code).toBe(0)
      expect(await Bun.file(join(project, "planted")).exists()).toBe(false)
    }
    for (const path of [".", "", "inside", project]) {
      expect((await cli(["rg", "x"], path)).code).toBe(4)
      expect(await Bun.file(join(project, "planted")).exists()).toBe(false)
    }
  }

  test("rg does not run fd or fdfind, so a machine with only fd still fails for rg", async () => {
    await fake("fd", 0)
    await fake("fdfind", 0)
    expect((await cli(["rg", "x"])).code).toBe(4)
  })
})

describe("the strict lookup of a search program", () => {
  const exe = (path: string) => (_command: string, _options: { readonly PATH: string }) => path

  test("asks only about absolute entries outside the working directory, by the platform's rules", () => {
    const asked: Array<string> = []
    const which = (_command: string, options: { readonly PATH: string }) => {
      asked.push(options.PATH)
      return null
    }
    findCommand({ PATH: "C:\\tools;bin;;.;C:\\proj\\bin;D:\\apps" }, "rg", {
      strict: { cwd: "C:\\proj", platform: "win32", which },
    })
    findCommand({ PATH: "/usr/bin:bin::.:/proj/bin:/opt/rg" }, "rg", {
      strict: { cwd: "/proj", platform: "linux", which },
    })
    expect(asked).toEqual(["C:\\tools;D:\\apps", "/usr/bin:/opt/rg"])
  })

  test("on Windows accepts an .exe and refuses a .cmd or .bat shim, which would go through cmd.exe", () => {
    const find = (path: string) =>
      Option.getOrUndefined(
        findCommand({ PATH: "C:\\tools" }, "rg", {
          strict: { cwd: "C:\\proj", platform: "win32", which: exe(path) },
        }),
      )
    expect(find("C:\\tools\\rg.exe")).toBe("C:\\tools\\rg.exe")
    expect(find("C:\\tools\\RG.EXE")).toBe("C:\\tools\\RG.EXE")
    expect(find("C:\\tools\\rg.cmd")).toBeUndefined()
    expect(find("C:\\tools\\rg.bat")).toBeUndefined()
    expect(find("C:\\tools\\rg")).toBeUndefined()
  })

  test("refuses a result inside the working directory", () => {
    const find = (cwd: string, path: string) =>
      Option.getOrUndefined(
        findCommand({ PATH: "/opt" }, "rg", {
          strict: { cwd, platform: "linux", which: exe(path) },
        }),
      )
    expect(find("/proj", "/opt/rg")).toBe("/opt/rg")
    expect(find("/proj", "/proj/rg")).toBeUndefined()
    expect(find("/proj", "/proj/bin/rg")).toBeUndefined()
    expect(find("/proj", "/proj2/rg")).toBe("/proj2/rg")
  })

  test.skipIf(process.platform !== "win32")(
    "on Windows resolves a real .exe on PATH (bun.exe stands in for rg.exe)",
    () => {
      const found = findCommand({ PATH: dirname(process.execPath) }, "bun", {
        strict: { cwd: project },
      })
      expect(Option.getOrUndefined(found)?.toLowerCase()).toEndWith(".exe")
    },
  )
})

describe("the programs installed on this machine", () => {
  const rg = Bun.which("rg")
  const fd = Bun.which("fd") ?? Bun.which("fdfind")
  const path = process.env.PATH ?? ""

  test.skipIf(rg === null)("rg reports matches by exit code", async () => {
    await Bun.write(join(project, "notes.txt"), "a needle in a haystack\n")
    const exit = async (...argv: Array<string>) => (await cli(argv, path)).code
    expect(await exit("rg", "-q", "needle", "notes.txt")).toBe(0)
    expect(await exit("rg", "-q", "absent", "notes.txt")).toBe(1)
  })

  test.skipIf(fd === null)("fd reports matches by exit code", async () => {
    await Bun.write(join(project, "notes.txt"), "a needle in a haystack\n")
    const exit = async (...argv: Array<string>) => (await cli(argv, path)).code
    expect(await exit("fd", "-q", "notes", ".")).toBe(0)
    expect(await exit("fd", "-q", "absent", ".")).toBe(1)
  })
})

describe("the help", () => {
  test("the top help lists rg and fd", async () => {
    const top = await cli(["--help"])
    expect(top.stdout).toContain("\nrg <ripgrep arguments…>  ")
    expect(top.stdout).toContain("\nfd <fd arguments…>  ")
  })
})
