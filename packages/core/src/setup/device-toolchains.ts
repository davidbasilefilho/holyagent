import { constants } from "node:fs"
import { posix, win32 } from "node:path"

import { Effect, Option, Schema } from "effect"

import { cmdExeArguments } from "../pi/bash/cmd.ts"
import { fileSystem } from "../ports/filesystem.ts"
import { type Env, firstNonEmpty, homeDirectory } from "./environment.ts"
import { localGraphicalHostUnavailable } from "./form.ts"
import { reportSetupActivity } from "./progress.ts"
import { added, hint, present } from "./report.ts"
import { comparableToolPath, Shell, toolPathExclusions } from "./shell.ts"

/** The caller chooses preview before consent, inspect for doctor, or apply for opted-in setup. */
export interface DeviceToolchainOptions {
  readonly mode: "preview" | "inspect" | "apply"
  readonly cwd?: string
  readonly platform?: string
  readonly arch?: string
}

/** An actionable report, with readiness only when an available simulator has been verified. */
export interface DeviceToolchainReport {
  readonly ready: string | undefined
  readonly lines: ReadonlyArray<string>
}

const STUDIO = "https://developer.android.com/studio"
const DEVICES = "https://developer.android.com/studio/run/managing-avds"
const ACCELERATION = "https://developer.android.com/studio/run/emulator-acceleration"
const XCODE = "https://developer.apple.com/xcode/resources/"
const RUNTIMES =
  "https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components"

const RuntimeList = Schema.fromJsonString(
  Schema.Struct({
    runtimes: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    devices: Schema.Record(
      Schema.String,
      Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    ),
  }),
)
const report = (lines: ReadonlyArray<string>, ready?: string): DeviceToolchainReport => ({
  ready,
  lines,
})

const inside = (path: typeof posix, parent: string, full: string): boolean => {
  const relative = path.relative(comparableToolPath(path, parent), comparableToolPath(path, full))
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const request = ["platform-tools", "emulator"] as const

/**
 * Reuse installed toolchains. Applying can add missing Android packages, never licenses or OS
 * components.
 */
export const deviceToolchains = Effect.fn("deviceToolchains")(function* (
  env: Env,
  options: DeviceToolchainOptions,
) {
  const { mode } = options
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const windows = platform === "win32"
  const mac = platform === "darwin"
  const path = windows ? win32 : posix
  const androidSupported =
    windows || platform === "linux" ? arch === "x64" : mac && (arch === "arm64" || arch === "x64")
  const appleSupported = mac && (arch === "arm64" || arch === "x64")
  if (!androidSupported && !appleSupported)
    return report([
      hint(`device simulator: no supported toolchain for ${platform}-${arch}; check ${STUDIO}`),
    ])
  if (mode === "apply" && localGraphicalHostUnavailable(env, platform) !== undefined)
    return report([
      hint(
        "Device Simulator: installation requires a local graphical session outside CI, SSH, WSL and cloud",
      ),
    ])

  const fs = yield* fileSystem
  const shell = yield* Shell
  const cwd = options.cwd ?? process.cwd()
  const home = homeDirectory(env)
  const excluded = toolPathExclusions(path, cwd, { includeCheckout: true, home }, fs)
  if (excluded === undefined)
    return report([
      hint(
        "Device Simulator: could not verify checkout and home paths; no toolchain commands were started",
      ),
    ])
  const absolute = (candidate: string) =>
    path.isAbsolute(comparableToolPath(path, candidate)) &&
    !/\p{Cc}/u.test(candidate) &&
    (!windows || /^[a-z]:[\\/]/i.test(comparableToolPath(path, candidate)))
  const trusted = (candidate: string) =>
    absolute(candidate) && excluded.every((root) => !inside(path, root, candidate))
  const verifiedPath = (candidate: string, root?: string) =>
    trusted(candidate)
      ? Effect.try(() => fs.realpathSync(candidate)).pipe(
          Effect.map((resolved) =>
            trusted(resolved) && (root === undefined || inside(path, root, resolved))
              ? resolved
              : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.succeed(undefined)
  const secure = (candidate: string, root?: string) =>
    Effect.map(verifiedPath(candidate, root), (resolved) => resolved !== undefined)
  const isDirectory = (candidate: string) =>
    Effect.tryPromise(() => fs.stat(candidate)).pipe(
      Effect.map((entry) => entry.isDirectory()),
      Effect.orElseSucceed(() => false),
    )
  // An incomplete package, dangling link or unreadable directory is not absent.
  const absent = (candidate: string) =>
    Effect.tryPromise(() => fs.lstat(candidate)).pipe(
      Effect.match({
        onFailure: ({ cause }) =>
          typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT",
        onSuccess: () => false,
      }),
    )
  const regular = (candidate: string) =>
    Effect.tryPromise(() => fs.stat(candidate)).pipe(
      Effect.map((entry) => entry.isFile() && entry.size > 0),
      Effect.orElseSucceed(() => false),
    )
  const program = (candidate: string, root?: string) =>
    Effect.gen(function* () {
      if (!(yield* secure(candidate, root)) || !(yield* regular(candidate))) return false
      return yield* Effect.try(() =>
        fs.accessSync(candidate, windows ? constants.F_OK : constants.X_OK),
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
    })
  const textFile = (candidate: string, root: string) =>
    Effect.gen(function* () {
      if (!(yield* secure(candidate, root))) return ""
      const size = yield* Effect.tryPromise(() => fs.stat(candidate)).pipe(
        Effect.map((entry) => (entry.isFile() ? entry.size : 0)),
        Effect.orElseSucceed(() => 0),
      )
      return size <= 0 || size > 65_536
        ? ""
        : yield* Effect.tryPromise(() => fs.readFile(candidate, "utf8")).pipe(
            Effect.orElseSucceed(() => ""),
          )
    })
  const standardRepositories = (directory: string) =>
    Effect.gen(function* () {
      if (!trusted(directory)) return false
      const config = path.join(directory, "repositories.cfg")
      return yield* Effect.tryPromise(() => fs.lstat(config)).pipe(
        Effect.matchEffect({
          onFailure: ({ cause }) =>
            Effect.succeed(
              typeof cause === "object" &&
                cause !== null &&
                "code" in cause &&
                cause.code === "ENOENT",
            ),
          onSuccess: (entry) =>
            !entry.isFile() || entry.size > 65_536
              ? Effect.succeed(false)
              : Effect.gen(function* () {
                  if (!(yield* secure(config, directory))) return false
                  return yield* Effect.tryPromise(() => fs.readFile(config, "utf8")).pipe(
                    Effect.map((body) =>
                      body
                        .split(/\r?\n/u)
                        .every((line) => /^(?:\s*|\s*#.*|\s*count\s*=\s*0\s*)$/u.test(line)),
                    ),
                    Effect.orElseSucceed(() => false),
                  )
                }),
        }),
      )
    })
  const run = (binary: string, args: ReadonlyArray<string>, childEnv?: Env, timeout = 10_000) =>
    shell
      .run(binary, args, {
        cwd: home,
        stdin: "closed",
        ...(childEnv === undefined ? {} : { env: childEnv }),
      })
      .pipe(Effect.timeoutOption(timeout))
  const failure = (line: string) => hint(line)
  const lines: Array<string> = []
  let iosReady: string | undefined
  const resultWith = (more: ReadonlyArray<string> = [], androidReady?: string) =>
    report([...lines, ...more], androidReady ?? iosReady)

  if (appleSupported) {
    const selected = firstNonEmpty(env["DEVELOPER_DIR"])
    const active =
      selected === undefined && mode !== "preview"
        ? yield* run("/usr/bin/xcode-select", ["-p"])
        : Option.none()
    const choice =
      selected ??
      (Option.isSome(active) && active.value.exitCode === 0
        ? active.value.stdout.trim()
        : undefined)
    const chosen = choice ?? "/Applications/Xcode.app/Contents/Developer"
    const developer = chosen.endsWith(".app") ? path.join(chosen, "Contents", "Developer") : chosen
    const platformDirectory = path.join(developer, "Platforms", "iPhoneSimulator.platform")
    const xcodebuild = path.join(developer, "usr", "bin", "xcodebuild")
    if (
      (mode !== "preview" && choice === undefined) ||
      !(yield* secure(developer)) ||
      !(yield* program(xcodebuild, developer)) ||
      !(yield* isDirectory(platformDirectory))
    ) {
      const clt =
        path.basename(developer) === "CommandLineTools"
          ? " (Command Line Tools are not full Xcode)"
          : ""
      lines.push(
        failure(
          `iOS: select full Xcode${clt} in Xcode > Settings > Locations; install it from ${XCODE}`,
        ),
      )
    } else if (mode === "preview") {
      lines.push(
        present(`iOS: Xcode found at ${developer}; no runtime probe or download in preview`),
      )
    } else {
      const xcodeEnv = { DEVELOPER_DIR: developer }
      const version = yield* run(xcodebuild, ["-version"], xcodeEnv)
      const firstLaunch =
        Option.isSome(version) &&
        version.value.exitCode === 0 &&
        /^Xcode \d/m.test(version.value.stdout)
          ? yield* run(xcodebuild, ["-checkFirstLaunchStatus"], xcodeEnv)
          : Option.none()
      if (Option.isNone(firstLaunch) || firstLaunch.value.exitCode !== 0) {
        lines.push(
          failure(
            "iOS: open full Xcode, review its license and complete first launch with any requested admin access",
          ),
        )
      } else {
        const runtimes = yield* run("/usr/bin/xcrun", ["simctl", "list", "--json"], xcodeEnv)
        const available =
          Option.isSome(runtimes) && runtimes.value.exitCode === 0
            ? Schema.decodeUnknownOption(RuntimeList)(runtimes.value.stdout)
            : Option.none()
        const ios = Option.isSome(available)
          ? available.value.runtimes.flatMap((runtime) => {
              const id = runtime["identifier"]
              return typeof id === "string" &&
                id.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
                runtime["isAvailable"] === true
                ? [id]
                : []
            })
          : []
        if (
          Option.isSome(available) &&
          ios.some((id) =>
            available.value.devices[id]?.some(
              (device) => device["isAvailable"] === true && typeof device["udid"] === "string",
            ),
          )
        ) {
          iosReady = `Xcode (${developer}) with an available iOS Simulator device and runtime`
          lines.push(present(`device simulator: ${iosReady}`))
        } else if (ios.length > 0) {
          lines.push(
            failure(
              "iOS: runtime installed but no available iOS Simulator device found; add one in Xcode > Window > Devices and Simulators",
            ),
          )
        } else {
          lines.push(
            failure(
              `iOS: no available runtime verified; complete Xcode first launch, then install an iOS runtime in Xcode > Settings > Components (${RUNTIMES})`,
            ),
          )
        }
      }
    }
  }

  if (!androidSupported) return resultWith()
  const defaultSdk = mac
    ? path.join(home, "Library", "Android", "sdk")
    : windows
      ? path.join(
          firstNonEmpty(env["LOCALAPPDATA"]) ?? path.join(home, "AppData", "Local"),
          "Android",
          "Sdk",
        )
      : path.join(home, "Android", "Sdk")
  // ANDROID_HOME is authoritative; don't install into a different SDK while T3 sees this setting.
  const configured = firstNonEmpty(env["ANDROID_HOME"], env["ANDROID_SDK_ROOT"])
  const selected = configured ?? defaultSdk
  const root = yield* verifiedPath(selected)
  if (root === undefined || !(yield* isDirectory(root)))
    return resultWith([
      failure(
        `Android: no existing SDK verified at ${selected}; use the Android Studio setup wizard or install the official command-line tools and set ANDROID_HOME (${STUDIO})`,
      ),
    ])
  const executable = (name: string) => (windows ? `${name}.exe` : name)
  const adb = path.join(root, "platform-tools", executable("adb"))
  const emulator = path.join(root, "emulator", executable("emulator"))
  const installed = Effect.all([program(adb, root), program(emulator, root)])
  const have = yield* installed
  const missing: Array<(typeof request)[number]> = []
  const existing: Array<(typeof request)[number]> = []
  for (const [index, name] of request.entries()) {
    if (!have[index]) ((yield* absent(path.join(root, name))) ? missing : existing).push(name)
  }
  if (existing.length > 0)
    lines.push(
      failure(
        `Android: kept existing but unverified SDK packages ${existing.join(", ")}; inspect or repair them in Android Studio's SDK Manager`,
      ),
    )
  const androidEnv = { ANDROID_HOME: root, ANDROID_SDK_ROOT: root, REPO_OS_OVERRIDE: undefined }

  if (missing.length > 0 && mode !== "inspect") {
    const licensed = yield* textFile(path.join(root, "licenses", "android-sdk-license"), root)
    const writable = yield* Effect.try(() => fs.accessSync(root, constants.W_OK)).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    const userPrefs = firstNonEmpty(env["ANDROID_USER_HOME"])
    const legacyPrefs = firstNonEmpty(env["ANDROID_SDK_HOME"])
    const prefs = new Set([
      path.join(home, ".android"),
      ...(userPrefs === undefined ? [] : [userPrefs]),
      ...(legacyPrefs === undefined ? [] : [path.join(legacyPrefs, ".android")]),
    ])
    if (!/^[0-9a-f]{40}\r?$/im.test(licensed)) {
      lines.push(
        failure(
          "Android: review and accept any required package licenses yourself in Android Studio's SDK Manager or with sdkmanager --licenses",
        ),
      )
    } else if (!writable) {
      lines.push(
        failure(
          "Android: this SDK is not writable; choose a user-writable SDK or ask its administrator to install the missing packages",
        ),
      )
    } else if (!(yield* Effect.forEach(prefs, standardRepositories)).every(Boolean)) {
      lines.push(
        failure(
          "Android: SDK repository settings are customized or unreadable; review them and install the missing packages in Android Studio's SDK Manager",
        ),
      )
    } else {
      const localAndroid = windows
        ? path.join(home, "AppData", "AndroidCLI", "android.exe")
        : path.join(home, ".local", "bin", "android")
      const officialCli =
        (yield* absent(path.join(home, ".androidrc"))) &&
        (yield* program(localAndroid, path.dirname(localAndroid)))
          ? localAndroid
          : undefined
      const toolRoot = path.join(root, "cmdline-tools")
      const versions = yield* Effect.try(() => fs.readdirSync(toolRoot)).pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      )
      const candidates = [
        "latest",
        ...versions
          .filter((entry) => /^\d+(?:\.\d+)*$/.test(entry))
          .sort((a, b) => b.localeCompare(a, "en", { numeric: true })),
      ]
      let sdkmanager: string | undefined
      for (const version of candidates) {
        const folder = path.join(toolRoot, version)
        const script = path.join(folder, "bin", windows ? "sdkmanager.bat" : "sdkmanager")
        if (!(yield* program(script, root))) continue
        const metadata = yield* textFile(path.join(folder, "source.properties"), root)
        const classpath = path.join(folder, "lib", "sdkmanager-classpath.jar")
        if (
          /^Pkg\.Desc\s*=\s*Android SDK Command-line Tools\s*$/im.test(metadata) &&
          /^Pkg\.Revision\s*=\s*\d/m.test(metadata) &&
          (yield* secure(classpath, root)) &&
          (yield* regular(classpath))
        ) {
          sdkmanager = script
          break
        }
      }
      if (mode === "preview") {
        lines.push(
          officialCli !== undefined || sdkmanager !== undefined
            ? added(
                `Android: would request missing SDK packages ${missing.join(", ")} with the installed Google tool; package licenses and runtime are checked on apply`,
              )
            : failure(
                `Android: install Google's Android CLI or SDK Command-line Tools to add ${missing.join(", ")} (${STUDIO})`,
              ),
        )
      } else {
        const verified =
          officialCli === undefined
            ? Option.none()
            : yield* run(officialCli, ["--no-metrics", "-h"])
        let installing = false
        const install = (command: string, args: ReadonlyArray<string>, childEnv: Env) =>
          Effect.gen(function* () {
            if (
              !(yield* Effect.forEach(missing, (name) => absent(path.join(root, name)))).every(
                Boolean,
              )
            ) {
              lines.push(
                failure(
                  "Android: SDK packages changed during setup; kept them unchanged, rerun setup to verify them",
                ),
              )
              return Option.none()
            }
            installing = true
            yield* reportSetupActivity(`Installing Android SDK packages ${missing.join(", ")}`)
            return yield* run(command, args, childEnv, 600_000)
          })
        let result: Option.Option<{
          readonly exitCode: number
          readonly stdout: string
          readonly stderr: string
        }> = Option.none()
        if (
          officialCli !== undefined &&
          Option.isSome(verified) &&
          verified.value.exitCode === 0 &&
          /\bandroid cli\b/i.test(verified.value.stdout + verified.value.stderr)
        ) {
          result = yield* install(
            officialCli,
            ["--no-metrics", `--sdk=${root}`, "sdk", "install", ...missing],
            androidEnv,
          )
        } else if (sdkmanager !== undefined) {
          const javaHome = firstNonEmpty(env["JAVA_HOME"])
          const java =
            javaHome === undefined
              ? yield* shell.which("java", {
                  strict: {
                    cwd,
                    excludeCheckout: true,
                    platform: windows ? "win32" : mac ? "darwin" : "linux",
                  },
                })
              : (yield* program(path.join(javaHome, "bin", executable("java"))))
                ? Option.some(path.join(javaHome, "bin", executable("java")))
                : Option.none()
          const resolvedJava =
            Option.isSome(java) &&
            (yield* program(java.value)) &&
            !(mac && java.value === "/usr/bin/java")
              ? yield* verifiedPath(java.value)
              : undefined
          if (
            resolvedJava === undefined ||
            path.basename(path.dirname(resolvedJava)).toLowerCase() !== "bin"
          ) {
            lines.push(
              failure(
                "Android: sdkmanager needs a compatible JDK; set JAVA_HOME to your JDK or Android Studio JBR",
              ),
            )
          } else {
            const args = [`--sdk_root=${root}`, "--install", ...missing]
            const javaEnv = {
              ...androidEnv,
              JAVA_HOME: path.dirname(path.dirname(resolvedJava)),
              JAVA_TOOL_OPTIONS: undefined,
              _JAVA_OPTIONS: undefined,
              JDK_JAVA_OPTIONS: undefined,
              CLASSPATH: undefined,
            }
            if (windows) {
              const cmd = path.join(
                firstNonEmpty(env["SystemRoot"], env["WINDIR"]) ?? "C:\\Windows",
                "System32",
                "cmd.exe",
              )
              const invocation = cmdExeArguments(sdkmanager, args)
              if (invocation.ok && (yield* program(cmd))) {
                result = yield* install(cmd, invocation.args, javaEnv)
              } else
                lines.push(
                  failure(
                    "Android: the sdkmanager batch command could not be started safely; use Android Studio's SDK Manager",
                  ),
                )
            } else {
              result = yield* install(sdkmanager, args, javaEnv)
            }
          }
        } else {
          lines.push(
            failure(
              `Android: install Google's Android CLI or SDK Command-line Tools to add ${missing.join(", ")} (${STUDIO})`,
            ),
          )
        }
        if (installing && Option.isNone(result))
          lines.push(
            failure(
              "Android: the SDK package manager timed out; finish in Android Studio's SDK Manager or rerun once the network is available",
            ),
          )
        if (Option.isSome(result)) {
          if (result.value.exitCode === 0 && (yield* installed).every(Boolean))
            lines.push(added(`Android: installed ${missing.join(", ")} into ${root}`))
          else {
            const output = result.value.stdout + result.value.stderr
            lines.push(
              /licen[cs]e/i.test(output)
                ? failure(
                    "Android: review the required package licenses yourself in Android Studio's SDK Manager or with sdkmanager --licenses",
                  )
                : /java|jdk|classfile/i.test(output)
                  ? failure(
                      "Android: SDK package manager could not use Java; set JAVA_HOME to a compatible JDK",
                    )
                  : failure(
                      "Android: SDK packages were not verified after installation; check SDK Manager, disk space, network and permissions",
                    ),
            )
          }
        }
      }
    }
  }

  const verified = yield* installed
  if (!verified.every(Boolean))
    return resultWith([
      failure(`Android: SDK at ${root} is missing verified platform-tools or Emulator binaries`),
    ])
  if (mode === "preview")
    return resultWith([
      present(`Android: SDK tools at ${root}; no AVD or acceleration probe in preview`),
    ])
  const avds = yield* run(emulator, ["-list-avds"], androidEnv)
  const avdRoots = [
    firstNonEmpty(env["ANDROID_AVD_HOME"]),
    ...["ANDROID_EMULATOR_HOME", "ANDROID_USER_HOME"].flatMap((key) =>
      env[key] === undefined ? [] : [path.join(env[key], "avd")],
    ),
    path.join(home, ".android", "avd"),
  ].filter((entry): entry is string => entry !== undefined)
  let avdReady = false
  const names =
    Option.isSome(avds) && avds.value.exitCode === 0
      ? avds.value.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^[\w][\w.-]*$/.test(line))
      : []
  for (const name of names) {
    for (const directory of avdRoots) {
      const pointerFile = path.join(directory, `${name}.ini`)
      if (yield* absent(pointerFile)) continue
      const pointer = yield* textFile(pointerFile, directory)
      const avd = /^path\s*=\s*([^\r\n]+)$/m.exec(pointer)?.[1]?.trim()
      if (avd === undefined) break
      const avdPath = yield* verifiedPath(avd)
      if (avdPath === undefined) break
      const config = yield* textFile(path.join(avdPath, "config.ini"), avdPath)
      const imagePath = /^image\.sysdir\.1\s*=\s*([^\r\n]+)$/m.exec(config)?.[1]?.trim()
      if (imagePath === undefined) break
      const image = path.resolve(root, imagePath, "system.img")
      if ((yield* secure(image, root)) && (yield* regular(image))) {
        avdReady = true
      }
      break
    }
    if (avdReady) break
  }
  if (!avdReady)
    return resultWith([
      failure(
        `Android: SDK available at ${root}, but no Android Virtual Device verified; create an AVD with a system image in Android Studio's Device Manager (${DEVICES})`,
      ),
    ])
  const acceleration = yield* run(emulator, ["-accel-check"], androidEnv)
  if (
    Option.isNone(acceleration) ||
    acceleration.value.exitCode !== 0 ||
    !/^accel:\s*\n0(?:\s|$)/m.test(acceleration.value.stdout + "\n" + acceleration.value.stderr)
  )
    return resultWith([
      failure(
        `Android: AVD configured, but hardware acceleration not verified; check ${windows ? "WHPX" : mac ? "Hypervisor.Framework" : "KVM and its permissions"} (${ACCELERATION})`,
      ),
    ])
  const ready = `the Android SDK (${root}) with a configured AVD and hardware acceleration`
  return resultWith([present(`device simulator: ${ready}`)], ready)
})
