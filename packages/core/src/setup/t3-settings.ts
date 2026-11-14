import { join } from "node:path"

import { Effect, Equal } from "effect"

import type { Config } from "../config/schema.ts"
import { fileSystem } from "../ports/filesystem.ts"
import { type Env, firstNonEmpty, homeDirectory } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import {
  applyDefaults,
  decodeJsonObject,
  type Default,
  isJsonObject,
  type JsonObject,
  type JsonSnapshot,
  readJsonObjectSnapshot,
  readJsonText,
  removeFileIfUnchanged,
  writeJsonObject,
  writeJsonObjectIfUnchanged,
} from "./json-file.ts"
import { loadPiConfig, piInUse } from "./pi-check.ts"
import { addRecorded, clearRecorded, readRecorded, type Recorded } from "./record.ts"
import { hint, pass, show, skipped } from "./report.ts"
import { take } from "./settings.ts"

/**
 * How many days T3 Code keeps what its storage cleanup may remove, the values setup writes. They
 * are HolyAgent's choice, since T3 turns every one of them off (`null`). T3 removes a worktree only
 * when it has no uncommitted changes (its `worktreeKeepWhen` default `uncommitted-changes`), so
 * unfinished work stays whatever these say.
 *
 * - `logsAfterDays`: a month of logs is enough to look into a failure.
 * - `browserArtifactsAfterDays`: screenshots and recordings of the visual specialists are evidence
 *   for the piece of work they belong to, which is over within two weeks.
 * - `worktreeSettledAfterDays`: a worktree whose thread has settled (merged or closed) is removed two
 *   weeks later, long enough to look back at it.
 */
export const T3_STORAGE_CLEANUP = {
  logsAfterDays: 30,
  browserArtifactsAfterDays: 14,
  worktreeSettledAfterDays: 14,
} as const

/** The instructions setup gives T3's commit and pull request writer, next to Conventional Commits. */
export const T3_WRITING_INSTRUCTIONS =
  "Write as the author, in the first person or a neutral voice, about what the change does and why. " +
  "Keep AI agents, assistants, sessions and tools out of commit messages and pull request text, and " +
  "add no attribution trailers (no Co-authored-by or Generated-by lines)."

/**
 * The instructions setup gives T3's branch name generator under the `custom` naming mode: the
 * repository's own convention wins, and T3's usual `t3/` prefix style is the fallback. One rule for
 * every project, since T3's project ids are random and setup cannot key a repository before T3
 * opens it.
 */
export const T3_BRANCH_INSTRUCTIONS =
  "Name each branch by the repository's own branch naming convention, as its AGENTS.md, CONTRIBUTING " +
  "guide or existing branch names show it. When the repository states none, use a short, lowercase, " +
  "hyphenated name under the `t3/` prefix."

/** How a setting is placed in `settings.json`, with the value T3 Code uses while it is absent. */
interface Wanted extends Default {
  /** T3's default; a key whose wanted value equals it is left out. */
  readonly default: unknown
}

/**
 * A group of keys written together. With `whole` set, the group is written only while the file has
 * no such top-level key, since its keys mean something together (a setting profile, a writing
 * style) and a part of the user's own object must not be completed with ours.
 */
interface Unit {
  readonly name: string
  /** The setup choice that switches the unit, for the units a person decides on. */
  readonly choice?: T3Choice
  readonly keys: ReadonlyArray<Wanted>
  readonly whole?: string
  /** Why the unit must not be written into this file, or `undefined`. */
  readonly refuse?: (existing: JsonObject) => string | undefined
}

/** The T3 setup choices a person decides on; every other unit is always applied. */
export type T3Choice = "pi" | "deviceAccess" | "worktrees"

/** The options of the T3 settings step. */
export interface T3SettingsOptions {
  /** Whether nothing is written: the report says what would be. */
  readonly dryRun: boolean
  /** Whether new threads start in worktrees (a later setup choice); `true` when absent. */
  readonly worktrees?: boolean
  /** Whether agents may use devices (a later setup choice); `true` when absent. */
  readonly deviceAccess?: boolean
  /** The operating system, `process.platform` when absent; only Xcode detection reads it. */
  readonly platform?: string
  /**
   * The user's HolyAgent config when the caller has loaded it already ({@link loadPiConfig} at
   * scope `user`), so the step does not load it again; loaded here when absent.
   */
  readonly config?: Config
  /**
   * Writes the file; {@link writeSettings} when absent. `unchangedSince` is the text the file must
   * still have (`undefined` for a file that did not exist), and a write that finds another text
   * fails and leaves the file as it is. A seam for tests of the races and the read-back.
   */
  readonly write?: (
    path: string,
    value: JsonObject,
    unchangedSince?: string,
  ) => Effect.Effect<void, SetupFailure>
  /**
   * Puts the file back to `previous` (removes it when `undefined`) only while it still has the text
   * `unchangedSince`, and returns whether it did; {@link restoreSettings} when absent. A seam for
   * tests of the restore.
   */
  readonly restore?: (
    path: string,
    previous: JsonObject | undefined,
    unchangedSince: string | undefined,
  ) => Effect.Effect<boolean, SetupFailure>
}

const label = "t3 settings"

/**
 * Puts T3's settings file back to `previous`, or removes it when there was none, only while it
 * still has the text `unchangedSince`; returns whether it did. A file that changed since stays as
 * it is.
 */
export const restoreSettings = (
  path: string,
  previous: JsonObject | undefined,
  unchangedSince: string | undefined,
) =>
  previous === undefined
    ? removeFileIfUnchanged(path, unchangedSince)
    : unchangedSince === undefined
      ? Effect.succeed(false)
      : writeSettings(path, previous, unchangedSince).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )

/**
 * Writes T3's settings file. With `unchangedSince` (the text the step read), it writes only while
 * the file still has that text, so a save by T3 Code in between is never overwritten; otherwise it
 * fails naming the file and writes nothing. Without it (the file did not exist) it writes plainly.
 */
export const writeSettings = (path: string, value: JsonObject, unchangedSince?: string) =>
  unchangedSince === undefined
    ? writeJsonObject(path, value)
    : writeJsonObjectIfUnchanged(path, value, unchangedSince).pipe(
        Effect.flatMap((wrote) =>
          wrote
            ? Effect.void
            : Effect.fail(
                new SetupFailure({
                  message: `${path} changed while setup was working on it, so nothing was written. Close T3 Code and run setup again`,
                }),
              ),
        ),
      )

/** T3 Code's home: `T3CODE_HOME`, else `.t3` in the home directory. */
export const t3Home = (env: Env) =>
  firstNonEmpty(env["T3CODE_HOME"]) ?? join(homeDirectory(env), ".t3")

/** The file T3 Code's server settings live in: `userdata/settings.json` under its home. */
export const t3SettingsFile = (env: Env) => join(t3Home(env), "userdata", "settings.json")

const isDirectory = (path: string) =>
  fileSystem.pipe(
    Effect.flatMap((fs) => Effect.tryPromise(() => fs.stat(path))),
    Effect.map((info) => info.isDirectory()),
    Effect.orElseSucceed(() => false),
  )

/**
 * What lets agents use devices on this machine, or `undefined` when nothing does: Xcode's iOS
 * simulator platform on macOS (under `DEVELOPER_DIR`, else `/Applications/Xcode.app`), or an
 * Android SDK folder (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, else the folder Android Studio installs
 * to). It reads folders only, runs no process.
 */
export const deviceHost = Effect.fn("t3DeviceHost")(function* (env: Env, platform: string) {
  const home = homeDirectory(env)
  if (platform === "darwin") {
    const developer =
      firstNonEmpty(env["DEVELOPER_DIR"]) ?? "/Applications/Xcode.app/Contents/Developer"
    const simulator = join(developer, "Platforms", "iPhoneSimulator.platform")
    if (yield* isDirectory(simulator)) return `Xcode (${developer})`
  }
  const sdkFolders = [
    firstNonEmpty(env["ANDROID_HOME"]),
    firstNonEmpty(env["ANDROID_SDK_ROOT"]),
    platform === "darwin"
      ? join(home, "Library", "Android", "sdk")
      : platform === "win32"
        ? join(
            firstNonEmpty(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local"),
            "Android",
            "Sdk",
          )
        : join(home, "Android", "Sdk"),
  ]
  for (const folder of sdkFolders) {
    if (folder !== undefined && (yield* isDirectory(folder))) return `the Android SDK (${folder})`
  }
  return undefined
})

/** The balanced profile's values, which the background activity overrides are measured against. */
const BALANCED = {
  pauseWhenHostLocked: true,
  pauseWhenHostLowPower: true,
  pauseWhenClientLowPower: true,
  pauseWhenOnBattery: false,
} as const

/**
 * The units setup writes, from the config switches and the device answer. Each key carries T3's
 * default, and {@link wantedKeys} leaves one out when its value equals it. Source: T3 Code's
 * `packages/contracts/src/settings.ts` and `packages/shared/src/backgroundActivitySettings.ts`
 * (`main`, read 2026-11-08; see docs/pi/t3-code.md).
 *
 * - `providerInstances.pi`: the Pi driver is off until an instance enables it.
 * - `backgroundActivity`: T3 applies `overrides` only under the `custom` profile, on a base profile;
 *   the balanced base pauses background work while the host is locked or in low power mode, which
 *   would stall unattended specialists, so those pauses are overridden off. `pauseWhenOnBattery` is
 *   already off in that profile and is not written.
 * - `sourceControlWritingStyle`: its custom instructions apply in every mode, Conventional Commits
 *   included.
 * - `branchNamingMode` and `branchNameInstructions`: the environment-wide rule, each key on its own
 *   (T3's `pullRequestMergeMethod` is left at its default, the method last chosen on the device).
 */
const units = (devices: boolean, worktrees: boolean): ReadonlyArray<Unit> => [
  {
    name: "Pi provider",
    choice: "pi",
    keys: [
      { path: ["providerInstances", "pi", "driver"], value: "pi", default: undefined },
      { path: ["providerInstances", "pi", "enabled"], value: true, default: undefined },
    ],
    refuse: (existing) => {
      const instance = isJsonObject(existing["providerInstances"])
        ? existing["providerInstances"]["pi"]
        : undefined
      if (!isJsonObject(instance)) return undefined
      if (instance["driver"] !== undefined && instance["driver"] !== "pi")
        return "providerInstances.pi is another driver's instance"
      const config = instance["config"]
      return isJsonObject(config) && config["enabled"] === false
        ? "providerInstances.pi.config.enabled is false"
        : undefined
    },
  },
  ...(devices
    ? [
        {
          name: "device access",
          choice: "deviceAccess",
          keys: [
            { path: ["enableDeviceSupport"], value: true, default: false },
            { path: ["enableAgentDeviceAccess"], value: true, default: false },
          ],
        } satisfies Unit,
      ]
    : []),
  ...(worktrees
    ? [
        {
          name: "worktrees",
          choice: "worktrees",
          keys: [{ path: ["defaultThreadEnvMode"], value: "worktree", default: null }],
        } satisfies Unit,
      ]
    : []),
  {
    name: "background activity",
    whole: "backgroundActivity",
    keys: [
      { path: ["backgroundActivity", "schemaVersion"], value: 1, default: undefined },
      { path: ["backgroundActivity", "profile"], value: "custom", default: "balanced" },
      { path: ["backgroundActivity", "baseProfile"], value: "balanced", default: undefined },
      ...(
        [
          "pauseWhenHostLocked",
          "pauseWhenHostLowPower",
          "pauseWhenClientLowPower",
          "pauseWhenOnBattery",
        ] as const
      ).map((name) => ({
        path: ["backgroundActivity", "overrides", name] as const,
        value: false,
        default: BALANCED[name],
      })),
    ],
  },
  {
    name: "source control writing",
    whole: "sourceControlWritingStyle",
    keys: [
      {
        path: ["sourceControlWritingStyle", "mode"],
        value: "conventional_commits",
        default: "repo_conventions",
      },
      {
        path: ["sourceControlWritingStyle", "customInstructions"],
        value: T3_WRITING_INSTRUCTIONS,
        default: "",
      },
    ],
  },
  {
    name: "threads and git",
    keys: [
      { path: ["removeAgentCreditsOnMerge"], value: true, default: false },
      { path: ["autoResumeLimitedThreads"], value: true, default: false },
      { path: ["snoozeLimitedThreads"], value: true, default: false },
      { path: ["defaultAutoPull"], value: true, default: false },
    ],
  },
  {
    name: "branch naming",
    keys: [
      { path: ["branchNamingMode"], value: "custom", default: "static" },
      { path: ["branchNameInstructions"], value: T3_BRANCH_INSTRUCTIONS, default: "" },
    ],
  },
  {
    name: "storage cleanup",
    keys: [
      { path: ["storageCleanup", "worktreeOnMerge"], value: true, default: false },
      ...(Object.entries(T3_STORAGE_CLEANUP) as Array<[string, number]>).map(([name, days]) => ({
        path: ["storageCleanup", name] as const,
        value: days,
        default: null,
      })),
    ],
  },
]

/** What the step does with one unit in a file as it is. */
type UnitOutcome =
  | { readonly status: "own" }
  | { readonly status: "left"; readonly reason: string }
  | { readonly status: "keys"; readonly keys: ReadonlyArray<Default> }

/**
 * What a unit adds to a file as it is: nothing when the setup `recorded` wrote its whole group
 * earlier (`own`), nothing when the file's own group or a refusal keeps it out (`left`, with the
 * reason), else the keys whose value differs from T3's default.
 */
const unitOutcome = (
  existing: JsonObject,
  unit: Unit,
  recorded: ReadonlyArray<Recorded>,
): UnitOutcome => {
  if (
    unit.whole !== undefined &&
    existing[unit.whole] !== undefined &&
    recorded.some(({ path }) => path[0] === unit.whole)
  )
    return { status: "own" }
  const reason =
    unit.whole !== undefined && existing[unit.whole] !== undefined
      ? `${unit.whole} is set`
      : unit.refuse?.(existing)
  return reason !== undefined
    ? { status: "left", reason }
    : { status: "keys", keys: unit.keys.filter((key) => !Equal.equals(key.value, key.default)) }
}

/**
 * The keys to write into a file as it is: those of every unit that is not refused, whose value
 * differs from T3's default. Returns them with a note for each unit left out whole, and the names
 * of the whole units that are in the file because the setup `recorded` wrote them: those are not
 * left out, they are already written.
 */
const wantedKeys = (
  existing: JsonObject,
  all: ReadonlyArray<Unit>,
  recorded: ReadonlyArray<Recorded> = [],
): {
  readonly keys: ReadonlyArray<Default>
  readonly left: ReadonlyArray<string>
  readonly own: ReadonlyArray<string>
} => {
  const keys: Array<Default> = []
  const left: Array<string> = []
  const own: Array<string> = []
  for (const unit of all) {
    const outcome = unitOutcome(existing, unit, recorded)
    if (outcome.status === "own") own.push(unit.name)
    else if (outcome.status === "left") left.push(`${unit.name} (${outcome.reason})`)
    else keys.push(...outcome.keys)
  }
  return { keys, left, own }
}

/** What the step needs of a machine: the T3 file to work on, and the units wanted there. */
interface Target {
  readonly file: string
  readonly units: ReadonlyArray<Unit>
  /** Why device access is left out, when it is wanted but not possible. */
  readonly deviceNote: string | undefined
  /** What lets agents use devices here (see {@link deviceHost}), whatever the choice is. */
  readonly device: string | undefined
  /** Whether the config lets setup write the worktree choice at all. */
  readonly worktreesAllowed: boolean
}

/** Why the step does nothing on this machine: a report line, or `undefined` when it has work. */
type Outcome = { readonly line: string } | { readonly target: Target }

/**
 * Decides what the step does on a machine. It reads the HolyAgent config of the user alone (T3's
 * file is the user's, so a repository's `.holyagent/config.json` must not steer it): with
 * `pi.enable` off, or a config that cannot be loaded (the Pi checks report that), there is no line;
 * T3 Code is installed when its home folder exists. A `project` T3 scope is not built yet and
 * writes nothing.
 */
const decide = Effect.fn("t3SettingsDecide")(function* (
  env: Env,
  cwd: string,
  options: Pick<T3SettingsOptions, "worktrees" | "deviceAccess" | "platform" | "config">,
) {
  const config =
    options.config ??
    (yield* loadPiConfig(env, cwd, "user").pipe(Effect.orElseSucceed(() => undefined)))
  if (config === undefined || !config.pi.enable) return undefined
  const home = t3Home(env)
  if (!(yield* isDirectory(home)))
    return {
      line: skipped(`${label}: T3 Code is not installed (no ${home}); nothing written`),
    } satisfies Outcome
  if (config.pi.t3.scope === "project")
    return {
      line: skipped(
        `${label}: pi.t3.scope is "project", whose per-project overrides setup does not write yet; nothing written`,
      ),
    } satisfies Outcome
  const host = config.pi.t3.deviceAccess
    ? yield* deviceHost(env, options.platform ?? process.platform)
    : undefined
  const wantsDevices = (options.deviceAccess ?? true) && config.pi.t3.deviceAccess
  const deviceNote =
    wantsDevices && host === undefined
      ? "device access left out: no Xcode or Android SDK found"
      : undefined
  return {
    target: {
      file: t3SettingsFile(env),
      units: units(
        wantsDevices && host !== undefined,
        (options.worktrees ?? true) && config.pi.t3.worktrees,
      ),
      deviceNote,
      device: host,
      worktreesAllowed: config.pi.t3.worktrees,
    },
  } satisfies Outcome
})

/**
 * Writes a settings object only while the file still has the text `before` read ({@link
 * writeSettings}), reads the file again and compares. When the file does not decode or differs from
 * what was written (T3 Code writes its own file too, and a client save close to ours can overwrite
 * it), it puts the previous content back, or removes the file when there was none, and fails naming
 * the file. That is done only while the file still has the text the read-back saw, so a save that
 * came after the read-back is never overwritten or deleted; then the file is left as it is.
 */
const writeVerified = Effect.fn("t3SettingsWriteVerified")(function* (
  file: string,
  value: JsonObject,
  before: JsonSnapshot,
  options: Pick<T3SettingsOptions, "write" | "restore">,
) {
  const write = options.write ?? writeSettings
  const restore = options.restore ?? restoreSettings
  yield* write(file, value, before.text)
  const back = yield* readJsonText(file).pipe(
    Effect.flatMap((text) =>
      decodeJsonObject(file, text ?? "").pipe(
        Effect.match({
          onFailure: (error) => ({ text, error: error.message }) as const,
          onSuccess: (decoded) => ({ text, decoded }) as const,
        }),
      ),
    ),
    Effect.catch((error) => Effect.succeed({ text: undefined, error: error.message } as const)),
  )
  if ("decoded" in back && JSON.stringify(back.decoded) === JSON.stringify(value)) return
  const problem =
    "error" in back ? `does not decode afterwards: ${back.error}` : "differs from what was written"
  const restored = yield* restore(
    file,
    before.text === undefined ? undefined : before.value,
    back.text,
  ).pipe(Effect.orElseSucceed(() => false))
  return yield* new SetupFailure({
    message: `${file} ${problem}; ${restored ? "its previous content was put back" : "it changed again, so it was left as it is"}. Close T3 Code and run setup again`,
  })
})

const names = (paths: ReadonlyArray<{ readonly path: string }>) =>
  paths.map((entry) => entry.path).join(", ")

/**
 * The T3 Code settings step of `holyagent setup`: merges the server settings HolyAgent wants into
 * T3's `userdata/settings.json` under `T3CODE_HOME` (else `~/.t3`) and returns the report lines.
 *
 * A key is written only while the file does not have it and its value differs from T3's own default
 * (T3 writes its file sparsely, so an absent key means the default); what the user set stays,
 * whatever it is. Written: the Pi provider instance, device access, new threads in worktrees,
 * background activity, the commit and pull request writing style, the branch naming rule
 * ({@link T3_BRANCH_INSTRUCTIONS}), thread resume and snooze, auto pull and storage cleanup
 * ({@link T3_STORAGE_CLEANUP}); the context meter, model choices, Pi launch settings and per-device
 * client settings are never written. Device access only where {@link deviceHost} finds Xcode or an
 * Android SDK, and only while the options and the config's `pi.t3` allow it; worktrees likewise.
 *
 * Nothing is written without T3's home folder (T3 Code is not installed), with `pi.enable` off, or
 * with `pi.t3.scope` `project`. A file that does not decode as a JSON object fails with a
 * {@link SetupFailure} naming it and stays untouched. The write goes through a temporary file
 * renamed over the target only while the file still has the text the step read, so a T3 save in
 * between fails the step naming the file instead of being lost, and is read back
 * ({@link writeVerified}). A group of keys the setup record shows setup wrote earlier is reported
 * as already written, not as left out. The keys it adds are recorded outside the file, which is
 * what {@link undoT3Settings} removes. With `dryRun` nothing is written or recorded.
 */
export const installT3Settings = Effect.fn("installT3Settings")(function* (
  env: Env,
  cwd: string,
  options: T3SettingsOptions,
) {
  const decided = yield* decide(env, cwd, options)
  if (decided === undefined) return []
  if ("line" in decided) return [decided.line]
  const { file, units: wanted, deviceNote } = decided.target
  const before = yield* readJsonObjectSnapshot(file)
  // Only for the report here; the write below reads the record again and fails on one that is bad.
  const recorded = yield* readRecorded(env, file).pipe(Effect.orElseSucceed(() => []))
  const { keys, left, own } = wantedKeys(before.value, wanted, recorded)
  const { merged, entries } = applyDefaults(before.value, keys)
  const added = entries.filter((entry) => entry.status === "added")
  const present = entries.filter((entry) => entry.status === "present")
  const kept = entries.filter((entry) => entry.status === "kept")
  if (added.length > 0 && !options.dryRun) {
    const written = new Set(added.map((entry) => entry.path))
    // Read the record first, so one that cannot be decoded stops the run before the file changes.
    yield* readRecorded(env, file)
    yield* writeVerified(file, merged, before, options)
    yield* addRecorded(
      env,
      file,
      keys
        .filter(({ path }) => written.has(path.join(".")))
        .map(({ path, value }) => ({ path, value })),
    ).pipe(
      Effect.mapError(
        (error) =>
          new SetupFailure({
            message: `${file} was written, but its keys could not be recorded, so --undo will not remove them: ${error.message}`,
          }),
      ),
    )
  }
  const parts = [
    ...(added.length === 0
      ? []
      : [
          `${options.dryRun ? "would add" : "added"} ${added.map((entry) => `${entry.path} ${show(entry.value)}`).join(", ")}`,
        ]),
    ...(present.length === 0 ? [] : [`already set: ${names(present)}`]),
    ...kept.map(
      (entry) =>
        `kept ${entry.path} ${show(entry.value)} (HolyAgent sets ${show(entry.wanted)}; yours wins)`,
    ),
    ...(own.length === 0 ? [] : [`already written: ${own.join(", ")}`]),
    ...(left.length === 0 ? [] : [`left out: ${left.join(", ")}`]),
    ...(deviceNote === undefined ? [] : [deviceNote]),
  ]
  const mark = added.length > 0 ? "+" : kept.length > 0 ? "~" : "="
  return [
    `${mark} ${label} ${file}: ${parts.join("; ")}${added.length > 0 && options.dryRun ? " (dry run, nothing written)" : ""}`,
  ]
})

/** What one unit of the T3 settings step would do to the file as it is. */
export interface T3UnitPreview {
  readonly name: string
  /** The setup choice that switches the unit; absent for a unit that is always applied. */
  readonly choice?: T3Choice
  /** `path value` of each key the run adds. */
  readonly added: ReadonlyArray<string>
  /** The paths of the keys already at the wanted value. */
  readonly present: ReadonlyArray<string>
  /** `path value` of each key the file sets differently, which setup keeps. */
  readonly kept: ReadonlyArray<string>
  /** Why the unit is left out whole, or `undefined`. */
  readonly left?: string
  /** True when the setup record shows setup wrote the whole group earlier. */
  readonly own?: boolean
}

/** What the T3 settings step would do on this machine with the given choices. */
export interface T3Preview {
  /** The T3 settings file. */
  readonly file: string
  /** What lets agents use devices here, or `undefined`: the device choice is offered only with one. */
  readonly device: string | undefined
  /** Whether the config lets setup write the worktree choice: the choice is offered only then. */
  readonly worktreesAllowed: boolean
  /** One entry per unit the choices keep in. */
  readonly units: ReadonlyArray<T3UnitPreview>
}

/**
 * What {@link installT3Settings} would do, unit by unit, without writing or recording anything:
 * `undefined` when the step has no work or no line on this machine (`pi.enable` off), a report line
 * when it only says why it writes nothing (T3 Code is not installed, `pi.t3.scope` is `project`),
 * else the {@link T3Preview}. It is what the setup interface offers choices from and lists in its
 * review.
 */
export const previewT3Settings = Effect.fn("previewT3Settings")(function* (
  env: Env,
  cwd: string,
  options: Pick<T3SettingsOptions, "worktrees" | "deviceAccess" | "platform" | "config">,
): Effect.fn.Return<T3Preview | { readonly line: string } | undefined, SetupFailure> {
  const decided = yield* decide(env, cwd, options)
  if (decided === undefined) return undefined
  if ("line" in decided) return { line: decided.line }
  const { file, units: wanted, device, worktreesAllowed } = decided.target
  const before = yield* readJsonObjectSnapshot(file)
  const recorded = yield* readRecorded(env, file).pipe(Effect.orElseSucceed(() => []))
  const units = wanted.map((unit): T3UnitPreview => {
    const outcome = unitOutcome(before.value, unit, recorded)
    const base = { name: unit.name, ...(unit.choice === undefined ? {} : { choice: unit.choice }) }
    if (outcome.status === "own") return { ...base, added: [], present: [], kept: [], own: true }
    if (outcome.status === "left")
      return { ...base, added: [], present: [], kept: [], left: outcome.reason }
    const { entries } = applyDefaults(before.value, outcome.keys)
    return {
      ...base,
      added: entries
        .filter((entry) => entry.status === "added")
        .map((entry) => `${entry.path} ${show(entry.value)}`),
      present: entries.filter((entry) => entry.status === "present").map((entry) => entry.path),
      kept: entries
        .filter((entry) => entry.status === "kept")
        .map((entry) => `${entry.path} ${show(entry.value)}`),
    }
  })
  return { file, device, worktreesAllowed, units }
})

/**
 * Backs out {@link installT3Settings}: a key the setup record names for T3's file is removed only
 * while its value still equals what setup wrote, so a value the user changed since stays and is
 * named in the line; a key setup did not record is never removed. An object the removal empties is
 * dropped, and the record is cleared after a real run. It follows the record, not the config, and
 * writes only while the file is as it was read and reads it again afterwards, like the install. No
 * record gives no line; a file that does not decode fails naming it and stays as it is. With
 * `dryRun` nothing is written and the record stays.
 */
export const undoT3Settings = Effect.fn("undoT3Settings")(function* (
  env: Env,
  options: Pick<T3SettingsOptions, "dryRun" | "write" | "restore">,
) {
  const file = t3SettingsFile(env)
  const recorded = yield* readRecorded(env, file)
  if (recorded.length === 0) return []
  const before = yield* readJsonObjectSnapshot(file)
  let result = before.value
  const removed: Array<string> = []
  const kept: Array<string> = []
  for (const { path, value } of recorded) {
    const [next, removal] = take(result, path, 0, value)
    result = next
    if (removal.status === "removed") removed.push(`${removal.path} ${show(removal.value)}`)
    if (removal.status === "kept")
      kept.push(`${removal.path} ${show(removal.value)} (setup wrote ${show(removal.wanted)})`)
  }
  if (!options.dryRun) {
    if (removed.length > 0) yield* writeVerified(file, result, before, options)
    yield* clearRecorded(env, file)
  }
  const parts = [
    ...(removed.length === 0
      ? []
      : [`${options.dryRun ? "would remove" : "removed"} ${removed.join(", ")}`]),
    ...(kept.length === 0 ? [] : [`kept ${kept.join(", ")}`]),
  ]
  const mark = removed.length > 0 ? "-" : kept.length > 0 ? "~" : "="
  return [
    `${mark} ${label} ${file}: ${parts.length === 0 ? "nothing of setup's left to remove" : parts.join("; ")}${removed.length > 0 && options.dryRun ? " (dry run, nothing written)" : ""}`,
  ]
})

/**
 * Doctor's report of the T3 settings: nothing unless Pi is in use, `pi.enable` is on and T3 Code is
 * installed (its home folder exists). Then one line: `ok` when the file holds every key setup would
 * write (or the user's own value stands in its place), a `~` hint naming the keys it lacks and the
 * command that writes them, or a `~` hint naming a file that does not decode. The lines never fail
 * doctor, and `--fix` does not write them. It reads files only, and says nothing about T3's
 * per-device client settings.
 */
export const checkT3Settings = (
  env: Env,
  cwd: string,
  options: Pick<T3SettingsOptions, "worktrees" | "deviceAccess" | "platform"> = {},
) =>
  Effect.gen(function* () {
    if (!(yield* piInUse(env))) return []
    const decided = yield* decide(env, cwd, options)
    if (decided === undefined || "line" in decided) return []
    const { file, units: wanted } = decided.target
    return yield* Effect.gen(function* () {
      const { value } = yield* readJsonObjectSnapshot(file)
      const { keys } = wantedKeys(value, wanted)
      const missing = applyDefaults(value, keys).entries.filter((entry) => entry.status === "added")
      return [
        missing.length === 0
          ? pass(label, `${file} holds the settings HolyAgent writes`)
          : hint(`${label} ${file} lacks ${names(missing)}; run \`holyagent setup\``),
      ]
    }).pipe(
      Effect.catchTag("SetupFailure", (error) =>
        Effect.succeed([
          hint(`${label}: ${error.message}; fix the file, then run \`holyagent setup\``),
        ]),
      ),
    )
  })
