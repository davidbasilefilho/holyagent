import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { selectTarget, TARGETS, toolPath } from "../src/cli/tools.ts"

/** The vendor folder of the built plugin in this checkout. */
const BUILT = join(import.meta.dir, "../../integrations/claude/dist/scripts/vendor")

const here = TARGETS.find(
  (target) => target.platform === process.platform && target.arch === process.arch,
)
const supported = here !== undefined
const posix = supported && process.platform !== "win32"
const built = here !== undefined && (await Bun.file(toolPath(BUILT, "rg", here)).exists())

let project: string
let tools: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "holyagent-tools-project-"))
  tools = await mkdtemp(join(tmpdir(), "holyagent-tools-vendor-"))
})
afterEach(() =>
  Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(tools, { recursive: true, force: true }),
  ]),
)

/** Runs one command line in-process in the temp project against a folder of tools. */
const cli = (argv: ReadonlyArray<string>, folder: string) =>
  Effect.runPromise(
    run(argv, {
      cwd: project,
      env: { HOME: project },
      stdin: Effect.fail(new StdinMissing({ reason: "no stdin in this test" })),
      tools: folder,
    }),
  )

describe("target selection", () => {
  const select = (platform: string, arch: string) =>
    Effect.runPromise(Effect.result(selectTarget(platform, arch)))

  test("maps each supported platform to its target folder and executable suffix", async () => {
    const picked = await Promise.all(
      [
        ["darwin", "arm64"],
        ["linux", "x64"],
        ["win32", "x64"],
      ].map(async ([platform = "", arch = ""]) => {
        const result = await select(platform, arch)
        return result._tag === "Success" ? [result.success.id, result.success.suffix] : result
      }),
    )
    expect(picked).toEqual([
      ["darwin-arm64", ""],
      ["linux-x64", ""],
      ["windows-x64", ".exe"],
    ])
  })

  test("refuses a platform with no bundled tools, naming it", async () => {
    for (const [platform, arch] of [
      ["linux", "arm64"],
      ["darwin", "x64"],
      ["win32", "arm64"],
      ["freebsd", "x64"],
    ] as const) {
      const result = await select(platform, arch)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("UnsupportedPlatform")
        expect(result.failure.message).toContain(`${platform} ${arch}`)
      }
    }
  })

  test("the program sits in its target's folder, with .exe on Windows", () => {
    const [darwin, linux, windows] = TARGETS
    if (darwin === undefined || linux === undefined || windows === undefined)
      throw new Error("expected three targets")
    expect(toolPath("v", "rg", linux)).toBe(join("v", "linux-x64", "rg"))
    expect(toolPath("v", "fd", darwin)).toBe(join("v", "darwin-arm64", "fd"))
    expect(toolPath("v", "fd", windows)).toBe(join("v", "windows-x64", "fd.exe"))
  })
})

describe.skipIf(!supported)("a bundled program that is missing", () => {
  test("rg and fd fail with ToolMissing, naming the path, and exit 4", async () => {
    for (const tool of ["rg", "fd"] as const) {
      const result = await cli([tool, "needle"], tools)
      expect(result.stdout).toBe("")
      expect(result.code).toBe(4)
      expect(result.stderr).toStartWith(`error: ToolMissing: The bundled ${tool} is missing: `)
      expect(result.stderr).toContain(toolPath(tools, tool, here ?? TARGETS[0]!))
      expect(result.stderr).toContain("hint: ")
    }
  })
})

describe.skipIf(!posix)("the command line passes through to the program", () => {
  /** Puts a script that records its arguments and working directory and exits with `code`. */
  const fake = async (tool: string, code: number) => {
    const folder = join(tools, here?.id ?? "")
    await mkdir(folder, { recursive: true })
    const path = join(folder, tool)
    await Bun.write(
      path,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${tools}/${tool}.args"\npwd > "${tools}/${tool}.cwd"\nexit ${code}\n`,
    )
    await chmod(path, 0o755)
  }

  test("hands every argument over untouched, --help and -h included, from the working directory", async () => {
    await fake("rg", 0)
    const argv = ["-n", "--help", "-h", "two words", "a*b", "$HOME", "--", "-x"]
    const result = await cli(["rg", ...argv], tools)
    expect(result).toEqual({ stdout: "", stderr: "", code: 0 })
    expect((await Bun.file(join(tools, "rg.args")).text()).split("\n").slice(0, -1)).toEqual(argv)
    // The project is under a temp folder that may be a symlink, so compare resolved paths.
    expect(await Bun.file(join(tools, "rg.cwd")).text()).toContain(
      (await Bun.$`realpath ${project}`.text()).trim(),
    )
  })

  test("ends with the program's own exit code, so rg and fd results keep their meaning", async () => {
    await fake("rg", 1)
    await fake("fd", 7)
    expect((await cli(["rg", "nothing"], tools)).code).toBe(1)
    expect((await cli(["fd", "nothing"], tools)).code).toBe(7)
    expect((await cli(["fd", "nothing"], tools)).stderr).toBe("")
  })
})

describe.skipIf(!built)("the vendored programs", () => {
  test("rg and fd run from the built plugin and report matches by exit code", async () => {
    await Bun.write(join(project, "notes.txt"), "a needle in a haystack\n")
    const exit = async (...argv: Array<string>) => (await cli(argv, BUILT)).code
    expect(await exit("rg", "-q", "needle", "notes.txt")).toBe(0)
    expect(await exit("rg", "-q", "absent", "notes.txt")).toBe(1)
    expect(await exit("fd", "-q", "notes", ".")).toBe(0)
    expect(await exit("fd", "-q", "absent", ".")).toBe(1)
  })
})

describe("the help", () => {
  test("the top help lists rg and fd", async () => {
    const top = await cli(["--help"], tools)
    expect(top.stdout).toContain("\nrg <ripgrep arguments…>  ")
    expect(top.stdout).toContain("\nfd <fd arguments…>  ")
  })
})
