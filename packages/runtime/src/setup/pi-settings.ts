import { join, relative, resolve, sep } from "node:path"

import { Effect, Equal } from "effect"

import type { Config } from "../config/schema.ts"
import { PROVIDERS } from "../pi/provider.ts"
import {
  BILLION_CONTEXT_FILE,
  PI_SETTINGS_FILE,
  SUBAGENTS_SETTINGS_FILE,
  toolSettings,
} from "../pi/tools.ts"
import { type Env, firstNonEmpty, homeDirectory } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import {
  applyDefaults,
  type Default,
  isJsonObject,
  type JsonObject,
  readJsonObject,
  writeJsonObject,
} from "./json-file.ts"
import { loadPiConfig, piAgentDirectory, piInUse } from "./pi-check.ts"
import type { PiInstallOptions } from "./pi-install.ts"
import { addRecorded, clearRecorded, readRecorded } from "./record.ts"
import { hint, show, skipped } from "./report.ts"
import { isSymlink, type Scope } from "./scope.ts"
import { take } from "./settings.ts"

/**
 * What each package does when its setting is unset, per settings file as {@link toolSettings} names
 * it, read from the released sources HolyAgent pins (`pi-packages.json`). Setup leaves out a key
 * whose wanted value equals the default, since writing it would only freeze today's default in the
 * user's file. A key with no entry has no default to equal (`fallbackSubagent` unset means the
 * package's `general-purpose` fallback; `pi.subagents` unset means an object of package defaults
 * with the delegate tools on, which is not the boolean `false`).
 *
 * - Codemode is a built-in extension of Pi: `codemode.mode` defaults to `on`
 *   (`SETTINGS_DEFAULTS.codemode.mode`, docs/settings.md of `@earendil-works/pi-coding-agent`).
 * - `@amaster.ai/pi-computer-use@0.1.36`, `dist/config.js`: both confirmations default to `true`.
 * - `@tintinweb/pi-subagents@0.23.1`, README "Disable defaults": `disableDefaultAgents` is `false`.
 * - `pi-provider-kimi-code@0.6.13`, `src/config.ts` `makeDefaultTools`: each Moonshot tool is
 *   `enabled: false`.
 */
const PACKAGE_DEFAULTS: ReadonlyMap<string, JsonObject> = new Map<string, JsonObject>([
  [
    PI_SETTINGS_FILE,
    {
      codemode: { mode: "on" },
      "pi-computer-use": { confirmAppLaunch: true, confirmDangerousActions: true },
    },
  ],
  [SUBAGENTS_SETTINGS_FILE, { disableDefaultAgents: false }],
  ...Object.values(PROVIDERS).map(
    (profile) =>
      [
        profile.toolsFile,
        { tools: Object.fromEntries(profile.webTools.map((tool) => [tool, { enabled: false }])) },
      ] as const,
  ),
])

/** The value at a key path of a JSON object, or undefined when a level is missing. */
const valueAt = (node: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((current, key) => (isJsonObject(current) ? current[key] : undefined), node)

/** The leaves of a settings fragment: every path down to a value that is not an object. */
const leaves = (content: JsonObject, prefix: ReadonlyArray<string> = []): ReadonlyArray<Default> =>
  Object.entries(content).flatMap(([key, child]) =>
    isJsonObject(child)
      ? leaves(child, [...prefix, key])
      : [{ path: [...prefix, key] as unknown as Default["path"], value: child }],
  )

/** The settings files {@link toolSettings} can name, as it names them. */
const KNOWN_FILES: ReadonlyArray<string> = [
  PI_SETTINGS_FILE,
  SUBAGENTS_SETTINGS_FILE,
  BILLION_CONTEXT_FILE,
  ...Object.values(PROVIDERS).map((profile) => profile.toolsFile),
]

const AGENT_PREFIX = "~/.pi/agent/"
const PI_PREFIX = "~/.pi/"

/**
 * Where a settings file of {@link toolSettings} lives at a scope, or `undefined` when it has no
 * place there. Scope `user` is the global location: Pi's agent folder for `~/.pi/agent/...`
 * (`PI_CODING_AGENT_DIR` honored), the home directory's `.pi` for the provider's file, and for
 * Billion Context `BILI_CONFIG_FILE`, else `XDG_CONFIG_HOME`, else `~/.config`. Scopes `project`
 * and `local` use the project's `.pi` folder, where Pi and the packages read project settings;
 * Billion Context has no project file, so its setting is user scope only.
 */
const locate = (env: Env, cwd: string, scope: Scope, logical: string): string | undefined => {
  const project = scope !== "user"
  const home = homeDirectory(env)
  if (logical === BILLION_CONTEXT_FILE) {
    if (project) return undefined
    const explicit = firstNonEmpty(env["BILI_CONFIG_FILE"])
    if (explicit !== undefined) return resolve(cwd, explicit)
    const base = firstNonEmpty(env["XDG_CONFIG_HOME"]) ?? join(home, ".config")
    return join(base, "billion-context", "billion-context.json")
  }
  if (logical.startsWith(AGENT_PREFIX)) {
    const name = logical.slice(AGENT_PREFIX.length)
    return project ? join(cwd, ".pi", name) : join(piAgentDirectory(env), name)
  }
  if (logical.startsWith(PI_PREFIX)) {
    const name = logical.slice(PI_PREFIX.length)
    return project ? join(cwd, ".pi", name) : join(home, ".pi", name)
  }
  return project || !logical.startsWith("~/") ? undefined : join(home, logical.slice(2))
}

/**
 * One settings file setup may write: every leaf {@link toolSettings} asks for, where the user's
 * global file for it is (at project and local scope), and the package defaults of the file.
 */
interface Target {
  readonly file: string
  /** The user-scope file of the same settings, set at project and local scope only. */
  readonly global: string | undefined
  readonly all: ReadonlyArray<Default>
  readonly defaults: JsonObject | undefined
}

/** What {@link toolSettings} asks for at a scope: the files to write, and files with no place there. */
interface Plan {
  readonly targets: ReadonlyArray<Target>
  readonly unplaced: ReadonlyArray<string>
}

const planFor = (env: Env, cwd: string, scope: Scope, config: Config): Plan => {
  const byFile = new Map<string, Array<Default>>()
  for (const patch of toolSettings(config)) {
    byFile.set(patch.file, [...(byFile.get(patch.file) ?? []), ...leaves(patch.content)])
  }
  const targets: Array<Target> = []
  const unplaced: Array<string> = []
  for (const [logical, all] of byFile) {
    const file = locate(env, cwd, scope, logical)
    if (file === undefined) {
      unplaced.push(logical)
      continue
    }
    targets.push({
      file,
      global: scope === "user" ? undefined : locate(env, cwd, "user", logical),
      all,
      defaults: PACKAGE_DEFAULTS.get(logical),
    })
  }
  return { targets, unplaced }
}

/** A {@link Target} after layering: the keys to set, and the leaves left out and why. */
interface Resolved {
  readonly file: string
  readonly keys: ReadonlyArray<Default>
  readonly atDefault: ReadonlyArray<string>
  readonly atGlobal: ReadonlyArray<string>
}

/**
 * Layers a target. At project and local scope a key the user's global file already sets, to any
 * value, is left out: the global value is the user's choice and a repository's file must not
 * override it (a user's `off` wins for the risky settings). Of the rest, a key equal to the package
 * default is left out, since writing it would only freeze today's default. Because a global key is
 * never written at project scope, leaving a default out there cannot hide a global value. Fails
 * with SetupFailure when the global file is not a JSON object, since what it sets is unknown.
 */
const resolveTarget = Effect.fn("resolveToolSettingsTarget")(function* (target: Target) {
  const global = target.global === undefined ? undefined : yield* readJsonObject(target.global)
  const setGlobally = (key: Default) =>
    global !== undefined && applyDefaults(global, [key]).entries[0]?.status !== "added"
  const isDefault = ({ path, value }: Default) =>
    target.defaults !== undefined && Equal.equals(valueAt(target.defaults, path), value)
  const free = target.all.filter((key) => !setGlobally(key))
  return {
    file: target.file,
    keys: free.filter((key) => !isDefault(key)),
    atDefault: free.filter(isDefault).map(({ path }) => path.join(".")),
    atGlobal: target.all.filter(setGlobally).map(({ path }) => path.join(".")),
  } satisfies Resolved
})

/**
 * Refuses a symlinked `.pi` folder, folder below it or settings file at project and local scope, so
 * a repository cannot redirect a write (or an `--undo`) to a file outside the project, as the
 * Claude settings step does for `.claude`. Scope `user` follows its links, as before.
 */
const refuseLinks = Effect.fn("refuseProjectLinks")(function* (
  cwd: string,
  scope: Scope,
  file: string,
  action: string,
) {
  if (scope === "user") return
  const parts = relative(cwd, file).split(sep)
  for (let depth = 1; depth <= parts.length; depth++) {
    const path = join(cwd, ...parts.slice(0, depth))
    if (yield* isSymlink(path)) {
      return yield* new SetupFailure({
        message: `${path} is a symlink; refusing to ${action} through it in the ${scope} scope. Replace it with a real ${depth === parts.length ? "file" : "folder"} and run again`,
      })
    }
  }
})

/**
 * The plan for a scope from the HolyAgent config that scope reads ({@link loadPiConfig}), or
 * `undefined` with `pi.enable` off or a config that cannot be loaded (the Pi package step and
 * doctor's Pi checks already report that).
 */
const planAt = (env: Env, cwd: string, scope: Scope) =>
  loadPiConfig(env, cwd, scope).pipe(
    Effect.map((config) => (config.pi.enable ? planFor(env, cwd, scope, config) : undefined)),
    Effect.orElseSucceed(() => undefined),
  )

const label = "tool settings"

/** Merges one target into its file and returns its report line. */
const mergeTarget = Effect.fn("mergeToolSettingsFile")(function* (
  env: Env,
  options: PiInstallOptions,
  planned: Target,
) {
  const { dryRun } = options
  const { file } = planned
  yield* refuseLinks(options.cwd, options.scope, file, "write")
  const target = yield* resolveTarget(planned)
  const existing = yield* readJsonObject(file)
  const { merged, entries } = applyDefaults(existing, target.keys)
  const added = entries.filter((entry) => entry.status === "added")
  const kept = entries.filter((entry) => entry.status === "kept")
  const present = entries.filter((entry) => entry.status === "present")
  if (added.length > 0 && !dryRun) {
    const names = new Set(added.map((entry) => entry.path))
    // Read the record first, so one that cannot be decoded stops the run before the file changes.
    yield* readRecorded(env, file)
    yield* writeJsonObject(file, merged)
    // The keys are in the file now, so a record that fails here is named: `--undo` would skip them.
    yield* addRecorded(
      env,
      file,
      target.keys.filter(({ path }) => names.has(path.join("."))),
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
          `${dryRun ? "would add" : "added"} ${added.map((entry) => `${entry.path} ${show(entry.value)}`).join(", ")}`,
        ]),
    ...(present.length === 0
      ? []
      : [`already set: ${present.map((entry) => entry.path).join(", ")}`]),
    ...kept.map(
      (entry) =>
        `kept ${entry.path} ${show(entry.value)} (HolyAgent sets ${show(entry.wanted)}; yours wins)`,
    ),
    ...(target.atGlobal.length === 0
      ? []
      : [`left out, set in your global file: ${target.atGlobal.join(", ")}`]),
    ...(target.atDefault.length === 0
      ? []
      : [`left out, the package default: ${target.atDefault.join(", ")}`]),
  ]
  const mark = added.length > 0 ? "+" : kept.length > 0 ? "~" : "="
  return `${mark} ${label} ${file}: ${parts.join("; ")}${added.length > 0 && dryRun ? " (dry run, nothing written)" : ""}`
})

/**
 * The tool settings step of `holyagent setup`: writes the settings {@link toolSettings} returns for
 * the HolyAgent config of the scope into the files the Pi packages read them from, one report line
 * per file. A key is written only where it is unset in the file and its value differs from the
 * package's own default ({@link PACKAGE_DEFAULTS}); a value the user set stays, whatever it is, so
 * a user's `off` wins for the risky settings too. At project and local scope a key the user's
 * global file sets is not written either ({@link resolveTarget}), and a symlinked `.pi` folder or
 * file is a `!` line with nothing written ({@link refuseLinks}). Keys the file already holds are
 * never touched. The keys it adds are recorded outside the project, which is what
 * {@link undoPiToolSettings} removes. Scope `user` writes Pi's global files, `project` and `local`
 * the project's `.pi` folder (Billion Context's file, which has no project location, is skipped
 * with a `-` line). A file that is not a JSON object is a `!` line and stays as it is, and the
 * other files are still written. Each write goes through a temporary file renamed over the target.
 * With `dryRun` nothing is written or recorded. With `pi.enable` off, or a config that cannot be
 * loaded, there are no lines.
 */
export const installPiToolSettings = Effect.fn("installPiToolSettings")(function* (
  env: Env,
  options: PiInstallOptions,
) {
  const plan = yield* planAt(env, options.cwd, options.scope)
  if (plan === undefined) return []
  const lines: Array<string> = []
  for (const target of plan.targets) {
    lines.push(
      yield* mergeTarget(env, options, target).pipe(
        Effect.catchTag("SetupFailure", (error) => Effect.succeed(`! ${label}: ${error.message}`)),
      ),
    )
  }
  for (const logical of plan.unplaced) {
    lines.push(
      skipped(
        `${label} ${logical}: has no file at ${options.scope} scope; run \`holyagent setup\` at user scope`,
      ),
    )
  }
  return lines
})

/**
 * Backs out {@link installPiToolSettings} at a scope: in each file that the setup record names, a
 * recorded key is removed only while its value still equals what setup wrote, so a value the user
 * changed since stays and is named in the line; a key setup did not record (it was there before, or
 * the user added it) is never removed. A parent object the removal empties is dropped, and the
 * record of the file is cleared after a real run. It follows the record, not the config or Pi's
 * presence, so a feature turned off since still gets its keys backed out. Files with no record get
 * no line, and a file that is not a JSON object is a `!` line left as it is. With `dryRun` nothing
 * is written and the record stays. At project and local scope a symlinked `.pi` folder or file is a
 * `!` line and nothing is edited through it.
 */
export const undoPiToolSettings = Effect.fn("undoPiToolSettings")(function* (
  env: Env,
  options: PiInstallOptions,
) {
  const lines: Array<string> = []
  const files = new Set(
    KNOWN_FILES.flatMap((logical) => locate(env, options.cwd, options.scope, logical) ?? []),
  )
  for (const file of files) {
    lines.push(
      ...(yield* Effect.gen(function* () {
        const recorded = yield* readRecorded(env, file)
        if (recorded.length === 0) return []
        yield* refuseLinks(options.cwd, options.scope, file, "edit")
        let result = yield* readJsonObject(file)
        const removed: Array<string> = []
        const kept: Array<string> = []
        for (const { path, value } of recorded) {
          const [next, removal] = take(result, path, 0, value)
          result = next
          if (removal.status === "removed") removed.push(`${removal.path} ${show(removal.value)}`)
          if (removal.status === "kept")
            kept.push(
              `${removal.path} ${show(removal.value)} (setup wrote ${show(removal.wanted)})`,
            )
        }
        if (!options.dryRun) {
          if (removed.length > 0) yield* writeJsonObject(file, result)
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
      }).pipe(
        Effect.catchTag("SetupFailure", (error) =>
          Effect.succeed([`! ${label}: ${error.message}`]),
        ),
      )),
    )
  }
  return lines
})

/** The command that writes the missing settings, for doctor's hint. */
const fixFor = (scope: Scope) =>
  scope === "user" ? "run `holyagent setup`" : `run \`holyagent setup --scope ${scope}\``

/**
 * Doctor's check of the tool settings: one `~` line for each file at the scope that lacks keys
 * setup would write (or cannot be read), naming the keys and the setup command that fixes it. It
 * adds nothing when the files are complete, and nothing at all unless Pi is in use
 * ({@link piInUse}) and `pi.enable` is on in the config of the scope, the same conditions as the Pi
 * checks. A key the user set to another value is not missing. Reads files only.
 */
export const checkPiToolSettings = (env: Env, cwd: string, scope: Scope) =>
  Effect.gen(function* () {
    if (!(yield* piInUse(env))) return []
    const plan = yield* planAt(env, cwd, scope)
    if (plan === undefined) return []
    const lines: Array<string> = []
    for (const planned of plan.targets) {
      lines.push(
        ...(yield* Effect.gen(function* () {
          yield* refuseLinks(cwd, scope, planned.file, "write")
          const target = yield* resolveTarget(planned)
          const existing = yield* readJsonObject(target.file)
          const missing = applyDefaults(existing, target.keys)
            .entries.filter((entry) => entry.status === "added")
            .map((entry) => entry.path)
          return missing.length === 0
            ? []
            : [hint(`${label} ${target.file} lacks ${missing.join(", ")}; ${fixFor(scope)}`)]
        }).pipe(
          Effect.catchTag("SetupFailure", (error) =>
            Effect.succeed([
              hint(`${label}: ${error.message}; fix the file, then ${fixFor(scope)}`),
            ]),
          ),
        )),
      )
    }
    return lines
  })
