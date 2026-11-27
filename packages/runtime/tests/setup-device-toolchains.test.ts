import { expect, test } from "bun:test"
import { constants, type Stats } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix, win32 } from "node:path"

import { Effect, Layer, Option } from "effect"

import { FileSystem, nodeFileSystem } from "../../core/src/ports/filesystem.ts"
import {
  deviceToolchains,
  type DeviceToolchainOptions,
} from "../../core/src/setup/device-toolchains.ts"
import type { Env } from "../src/setup/environment.ts"
import { comparableToolPath, Shell, type ShellResult, shellLive } from "../src/setup/shell.ts"

const ok = (stdout = ""): ShellResult => ({ exitCode: 0, stdout, stderr: "" })
const bad = (stderr = ""): ShellResult => ({ exitCode: 1, stdout: "", stderr })

type Options = {
  readonly platform?: "linux" | "win32" | "darwin"
  readonly arch?: string
  readonly respond?: (binary: string, args: ReadonlyArray<string>) => ShellResult | undefined
}

const fixture = (options: Options = {}) => {
  const platform = options.platform ?? "linux"
  const windows = platform === "win32"
  const path = windows ? win32 : posix
  const home = windows ? "C:\\Users\\Test Person" : "/test-home"
  const project = windows ? "D:\\Project" : "/example-project"
  const root =
    platform === "darwin"
      ? path.join(home, "Library", "Android", "sdk")
      : windows
        ? path.join(home, "AppData", "Local", "Android", "Sdk")
        : path.join(home, "Android", "Sdk")
  const javaHome = path.join(home, "test-jdk")
  const executable = (name: string) => (windows ? `${name}.exe` : name)
  const adb = path.join(root, "platform-tools", executable("adb"))
  const emulator = path.join(root, "emulator", executable("emulator"))
  const tool = path.join(
    root,
    "cmdline-tools",
    "latest",
    "bin",
    windows ? "sdkmanager.bat" : "sdkmanager",
  )
  const cli = windows
    ? path.join(home, "AppData", "AndroidCLI", "android.exe")
    : path.join(home, ".local", "bin", "android")
  const cmd = "C:\\Windows\\System32\\cmd.exe"
  const avds = path.join(home, ".android", "avd")
  const pixel = path.join(avds, "Pixel.avd")
  const image = path.join(
    "system-images",
    "android-35",
    "google_apis",
    platform === "darwin" ? "arm64-v8a" : "x86_64",
  )
  const files = new Map<string, string | null>()
  const denied = new Set<string>()
  const calls: Array<{
    program: string
    args: ReadonlyArray<string>
    cwd: string
    env: Env | undefined
    stdin: "closed" | undefined
  }> = []
  const write = (target: string, content: string | null = "fixture") => {
    files.set(path.normalize(target), content)
    for (let up = path.dirname(target); !files.has(up); up = path.dirname(up)) {
      files.set(up, null)
      if (up === path.dirname(up)) break
    }
  }
  const status = (name: string): Stats => {
    const normalized = path.normalize(name)
    const file = normalized === project || normalized === home ? null : files.get(normalized)
    if (file === undefined) throw Object.assign(new Error("fixture not found"), { code: "ENOENT" })
    return {
      isDirectory: () => file === null,
      isFile: () => file !== null,
      size: file?.length ?? 0,
    } as Stats
  }
  const fs = Layer.succeed(
    FileSystem,
    FileSystem.of({
      ...nodeFileSystem,
      lstatSync: ((file: string) => status(file)) as typeof nodeFileSystem.lstatSync,
      realpathSync: ((file: string) => {
        status(file)
        return path.normalize(file)
      }) as typeof nodeFileSystem.realpathSync,
      stat: (async (file: string) => status(file)) as typeof nodeFileSystem.stat,
      lstat: (async (file: string) => status(file)) as typeof nodeFileSystem.lstat,
      realpath: (async (file: string) => {
        status(file)
        return path.normalize(file)
      }) as typeof nodeFileSystem.realpath,
      readFile: (async (file: string) => {
        status(file)
        return files.get(path.normalize(file)) ?? ""
      }) as unknown as typeof nodeFileSystem.readFile,
      readdirSync: ((folder: string) =>
        [...files.keys()]
          .filter((file) => path.dirname(file) === folder)
          .map((file) => path.basename(file))) as typeof nodeFileSystem.readdirSync,
      accessSync: (file, mode) => {
        const name = String(file)
        status(name)
        if (mode === constants.W_OK && denied.has(name))
          throw new Error("fixture permission denied")
      },
    }),
  )
  const prepared = () => {
    write(adb)
    write(emulator)
    write(path.join(avds, "Pixel.ini"), `path=${pixel}\n`)
    write(path.join(pixel, "config.ini"), `image.sysdir.1=${image}\n`)
    write(path.join(root, image, "system.img"))
  }
  const license = () =>
    write(path.join(root, "licenses", "android-sdk-license"), `${"0".repeat(40)}\n`)
  const sdkmanager = () => {
    write(tool)
    write(
      path.join(path.dirname(path.dirname(tool)), "source.properties"),
      "Pkg.Desc=Android SDK Command-line Tools\nPkg.Revision=18.0\n",
    )
    write(path.join(path.dirname(path.dirname(tool)), "lib", "sdkmanager-classpath.jar"))
    write(path.join(javaHome, "bin", executable("java")))
    if (windows) write(cmd)
  }
  const shell = Layer.succeed(
    Shell,
    Shell.of({
      which: () => Effect.succeed(Option.none()),
      run: (program, args, runOptions) =>
        Effect.sync(() => {
          calls.push({
            program,
            args,
            cwd: runOptions.cwd,
            env: runOptions.env,
            stdin: runOptions.stdin,
          })
          return (
            options.respond?.(program, args) ??
            (program === emulator && args[0] === "-list-avds"
              ? ok("Pixel\n")
              : program === emulator && args[0] === "-accel-check"
                ? ok("accel:\n0\nusable\naccel\n")
                : program === cli && args.includes("-h")
                  ? ok("Android CLI")
                  : bad("unexpected command"))
          )
        }),
    }),
  )
  const run = (mode: DeviceToolchainOptions["mode"], env: Env = {}) =>
    Effect.runPromise(
      deviceToolchains(
        {
          ...(windows ? { USERPROFILE: home } : { HOME: home }),
          DISPLAY: ":0",
          JAVA_HOME: javaHome,
          ...env,
        },
        { mode, platform, cwd: project, arch: options.arch ?? "x64" },
      ).pipe(Effect.provide(Layer.merge(shell, fs))),
    )
  return {
    home,
    root,
    adb,
    emulator,
    tool,
    cli,
    cmd,
    image,
    files,
    denied,
    calls,
    write,
    prepared,
    license,
    sdkmanager,
    run,
    path,
  }
}

test("unsupported hosts and new machines do not start any installer or request elevation", async () => {
  const unsupported = fixture({ platform: "win32", arch: "arm64" })
  expect((await unsupported.run("apply")).lines.join(" ")).toContain("no supported toolchain")
  expect(unsupported.calls).toEqual([])
  const fresh = fixture()
  expect((await fresh.run("apply")).lines.join(" ")).toContain("Android Studio setup wizard")
  expect(fresh.calls).toEqual([])
  expect(fresh.files.size).toBe(0)
})

test("preview reports the narrow Google package request without executing anything or touching disk", async () => {
  const local = fixture()
  local.license()
  local.sdkmanager()
  const before = [...local.files]
  const result = await local.run("preview")
  expect(result.ready).toBeUndefined()
  expect(result.lines.join(" ")).toContain(
    "would request missing SDK packages platform-tools, emulator",
  )
  expect(local.calls).toEqual([])
  expect([...local.files]).toEqual(before)
})

test("new Android CLI installs only missing packages without switching SDK or updating on the second run", async () => {
  const local = fixture({
    respond: (tool, args) => {
      if (tool === local.cli && args.includes("install")) {
        local.prepared()
        return ok()
      }
    },
  })
  local.license()
  local.write(local.adb)
  local.write(local.cli)
  const first = await local.run("apply")
  expect(first.ready).toContain("configured AVD and hardware acceleration")
  expect(first.lines.join(" ")).toContain("installed emulator")
  expect(local.calls[1]).toMatchObject({
    program: local.cli,
    args: ["--no-metrics", `--sdk=${local.root}`, "sdk", "install", "emulator"],
    cwd: local.home,
    env: { ANDROID_HOME: local.root, ANDROID_SDK_ROOT: local.root, REPO_OS_OVERRIDE: undefined },
    stdin: "closed",
  })
  const second = await local.run("apply")
  expect(second.ready).toBe(first.ready)
  expect(local.calls.filter(({ args }) => args.includes("install"))).toHaveLength(1)
})

test("the public CLI adapter gives toolchain subprocesses EOF and preserves literal arguments", async () => {
  const result = await Effect.runPromise(
    Effect.flatMap(Shell, (shell) =>
      shell.run(
        process.execPath,
        [
          "--no-env-file",
          "-e",
          "await Bun.stdin.text(); console.log(JSON.stringify(Bun.argv.slice(1)))",
          "--",
          "sdk with spaces",
          "--install",
        ],
        { cwd: process.cwd(), stdin: "closed" },
      ),
    ).pipe(Effect.provide(shellLive(process.env)), Effect.timeout(5_000)),
  )
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(["sdk with spaces", "--install"])
})

test("Windows drives the verified SDK's batch launcher with literal, fixed arguments", async () => {
  const local = fixture({
    platform: "win32",
    respond: (program, args) => {
      if (program === "C:\\Windows\\System32\\cmd.exe" && args.includes("--install")) {
        local.prepared()
        return ok()
      }
    },
  })
  local.license()
  local.sdkmanager()
  const result = await local.run("apply")
  expect(result.ready).toContain("configured AVD")
  expect(local.calls[0]).toMatchObject({
    program: local.cmd,
    args: [
      "/d",
      "/s",
      "/c",
      "call",
      local.tool,
      `--sdk_root=${local.root}`,
      "--install",
      "platform-tools",
      "emulator",
    ],
    cwd: local.home,
    env: { REPO_OS_OVERRIDE: undefined, JAVA_TOOL_OPTIONS: undefined },
  })
})

test("license and SDK permissions prevent starts; a Java prerequisite is actionable", async () => {
  const local = fixture()
  local.sdkmanager()
  expect((await local.run("apply")).lines.join(" ")).toContain("review and accept")
  expect(local.calls).toEqual([])
  local.license()
  local.denied.add(local.root)
  expect((await local.run("apply")).lines.join(" ")).toContain("not writable")
  expect(local.calls).toEqual([])
  local.denied.clear()
  expect((await local.run("apply", { JAVA_HOME: "/missing-jdk" })).lines.join(" ")).toContain(
    "compatible JDK",
  )
  expect(local.calls).toEqual([])
})

test("trusted SDK manager refusal, including licenses, does not proceed to another installer", async () => {
  const local = fixture({
    respond: (_, args) => (args.includes("install") ? bad("SDK license not accepted") : undefined),
  })
  local.license()
  local.sdkmanager()
  local.write(local.cli)
  const result = await local.run("apply")
  expect(result.ready).toBeUndefined()
  expect(result.lines.join(" ")).toContain("review the required package licenses yourself")
  expect(local.calls.map(({ program }) => program)).toEqual([local.cli, local.cli])
})

test("custom repository sources never trigger an automatic package install", async () => {
  const local = fixture()
  local.license()
  local.sdkmanager()
  const prefs = local.path.join(local.home, "sdk-settings")
  local.write(
    local.path.join(prefs, "repositories.cfg"),
    "count=1\n0=https://repo.example/sdk.xml\n",
  )
  const result = await local.run("apply", { ANDROID_USER_HOME: prefs })
  expect(result.ready).toBeUndefined()
  expect(result.lines.join(" ")).toContain("SDK repository settings are customized or unreadable")
  expect(local.calls).toEqual([])
})

test("Core will not execute setup toolchain commands in CI, SSH, WSL, cloud or headless Linux", async () => {
  const local = fixture()
  local.license()
  local.sdkmanager()
  for (const environment of [
    { CI: "true" },
    { SSH_CONNECTION: "fixture" },
    { WSL_DISTRO_NAME: "fixture" },
    { CODEX_CAAS_SESSION_ID: "fixture" },
    { DISPLAY: "" },
    { DISPLAY: "remote:0" },
  ])
    expect((await local.run("apply", environment)).lines.join(" ")).toContain(
      "local graphical session",
    )
  expect(local.calls).toEqual([])
})

test("an incomplete existing SDK package is not sent to the installer for an update", async () => {
  const local = fixture()
  local.license()
  local.sdkmanager()
  local.write(posix.join(local.root, "emulator", "vendor-build.xml"))
  local.write(local.adb)
  expect((await local.run("apply")).lines.join(" ")).toContain(
    "kept existing but unverified SDK packages emulator",
  )
  expect(local.calls).toEqual([])
})

test("a package appearing during the official CLI probe is preserved without running install", async () => {
  const local = fixture({
    respond: (tool, args) => {
      if (tool === local.cli && args.includes("-h"))
        local.write(posix.join(local.root, "emulator", "already-present.xml"))
      return undefined
    },
  })
  local.license()
  local.write(local.adb)
  local.write(local.cli)
  expect((await local.run("apply")).lines.join(" ")).toContain("SDK packages changed during setup")
  expect(local.calls.map(({ args }) => args)).toEqual([["--no-metrics", "-h"]])
})

test("Windows checkout containment compares extended DOS and UNC spellings to their plain roots", () => {
  const drive = (value: string) => comparableToolPath(win32, value)
  expect(win32.relative(drive("\\\\?\\C:\\Checkout"), drive("c:\\checkout\\sdk"))).toBe("sdk")
  expect(
    win32.relative(
      drive("\\\\?\\UNC\\host\\Share\\Checkout"),
      drive("\\\\host\\share\\checkout\\sdk"),
    ),
  ).toBe("sdk")
  expect(drive("\\\\.\\C:\\Checkout")).not.toBe(drive("C:\\Checkout"))
})

test.skipIf(!["linux", "win32"].includes(process.platform) || process.arch !== "x64")(
  "a project's SDK is not trusted from subdirectories, junctions or aliases",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "holyagent-device-checkout-"))
    try {
      const home = join(root, "profile")
      const checkout = join(root, "checkout")
      const gitDir = join(checkout, ".git")
      const sdk = join(checkout, "toolchains", "android-sdk")
      const nested = join(checkout, "frontend", "src")
      for (const directory of [gitDir, sdk, nested, home])
        await mkdir(directory, { recursive: true })
      await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/dev\n")
      const cwdAlias = join(root, "checkout-link")
      const sdkAlias = join(root, "sdk-link")
      await symlink(checkout, cwdAlias, "junction")
      await symlink(sdk, sdkAlias, "junction")
      const calls: Array<string> = []
      const shell = Shell.of({
        which: () => Effect.succeed(Option.none()),
        run: (program) =>
          Effect.sync(() => {
            calls.push(program)
            return bad()
          }),
      })
      for (const marker of ["directory", "worktree file"] as const) {
        if (marker === "worktree file") {
          await rm(gitDir, { recursive: true })
          await writeFile(gitDir, "gitdir: ../worktree-metadata\n")
        }
        for (const [sample, cwd, configured, profile] of [
          ["nested cwd", nested, sdk, home],
          ["cwd junction", join(cwdAlias, "frontend", "src"), sdk, home],
          ["SDK junction", nested, sdkAlias, home],
          ["nested cwd, HOME checkout", nested, sdk, checkout],
          ["root cwd, HOME checkout", checkout, sdk, checkout],
        ] as const) {
          const result = await Effect.runPromise(
            deviceToolchains(
              { HOME: profile, USERPROFILE: profile, ANDROID_HOME: configured, DISPLAY: ":0" },
              { mode: "apply", cwd },
            ).pipe(Effect.provideService(Shell, shell)),
          )
          expect({ case: `${marker}: ${sample}`, output: result.lines.join(" ") }).toEqual({
            case: `${marker}: ${sample}`,
            output: expect.stringContaining("no existing SDK verified"),
          })
        }
      }
      expect(calls).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test("a named but incomplete AVD and a numeric acceleration failure are not ready", async () => {
  const local = fixture({
    respond: (_, args) =>
      args[0] === "-accel-check" ? ok("accel:\n2\nKVM cannot be opened\naccel\n") : undefined,
  })
  local.prepared()
  const disk = posix.join(local.root, local.image, "system.img")
  local.files.delete(disk)
  const missing = await local.run("inspect")
  expect(missing.ready).toBeUndefined()
  expect(missing.lines.join(" ")).toContain("no Android Virtual Device verified")
  expect(local.calls).toHaveLength(1)
  local.write(disk)
  const higherAvdDirectory = posix.join(local.home, "another-avd-directory")
  local.write(posix.join(higherAvdDirectory, "Pixel.ini"), "corrupt descriptor")
  expect(
    (await local.run("apply", { ANDROID_AVD_HOME: higherAvdDirectory })).lines.join(" "),
  ).toContain("no Android Virtual Device verified")
  const unavailable = await local.run("apply")
  expect(unavailable.ready).toBeUndefined()
  expect(unavailable.lines.join(" ")).toContain("KVM and its permissions")
})

test("macOS distinguishes full selected Xcode, first launch and an available iOS runtime", async () => {
  const developer = "/Applications/Apple Xcode.app/Contents/Developer"
  let firstLaunch = false
  let runtime = "com.apple.CoreSimulator.SimRuntime.watchOS-26-0"
  let device = false
  const local = fixture({
    platform: "darwin",
    arch: "arm64",
    respond: (_, args) => {
      if (args[0] === "-version") return ok("Xcode 26.3\n")
      if (args[0] === "-checkFirstLaunchStatus") return firstLaunch ? ok() : bad()
      if (args[0] === "simctl")
        return ok(
          JSON.stringify({
            runtimes: [{ identifier: runtime, isAvailable: true }],
            devices: device ? { [runtime]: [{ udid: "fixture", isAvailable: true }] } : {},
            devicetypes: [],
          }),
        )
    },
  })
  const clt = await local.run("apply", { DEVELOPER_DIR: "/Library/Developer/CommandLineTools" })
  expect(clt.lines.join(" ")).toContain("Command Line Tools are not full Xcode")
  expect(local.calls).toEqual([])
  local.write(posix.join(developer, "Platforms", "iPhoneSimulator.platform"), null)
  local.write(posix.join(developer, "usr", "bin", "xcodebuild"))
  const env = { DEVELOPER_DIR: "/Applications/Apple Xcode.app" }
  expect((await local.run("inspect", env)).lines.join(" ")).toContain("complete first launch")
  firstLaunch = true
  expect((await local.run("apply", env)).ready).toBeUndefined()
  expect((await local.run("apply", env)).lines.join(" ")).toContain("install an iOS runtime")
  runtime = "com.apple.CoreSimulator.SimRuntime.iOS-26-0"
  expect((await local.run("inspect", env)).lines.join(" ")).toContain(
    "no available iOS Simulator device",
  )
  device = true
  const done = await local.run("inspect", env)
  expect(done.ready).toContain("available iOS Simulator device and runtime")
  expect(done.lines.join(" ")).toContain("Android: no existing SDK verified")
  expect(
    local.calls.every(
      ({ args }) =>
        !args.some(
          (arg) => arg === "-runFirstLaunch" || arg === "-downloadPlatform" || arg === "-license",
        ),
    ),
  ).toBe(true)
})
