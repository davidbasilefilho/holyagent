import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Option } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { INSTALL_COMMANDS, locateTool } from "../src/setup/search-tools.ts"

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
    return Effect.runPromise(locateTool(tool, which)).then((found) => ({
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
      for (const [platform, command] of INSTALL_COMMANDS) {
        expect(result.stderr).toContain(platform)
        expect(result.stderr).toContain(command)
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
      ["Windows", "winget install BurntSushi.ripgrep.MSVC sharkdp.fd"],
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
    expect(await Bun.file(join(bin, "rg.cwd")).text()).toContain(
      (await Bun.$`realpath ${project}`.text()).trim(),
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

  test("rg does not run fd or fdfind, so a machine with only fd still fails for rg", async () => {
    await fake("fd", 0)
    await fake("fdfind", 0)
    expect((await cli(["rg", "x"])).code).toBe(4)
  })
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
