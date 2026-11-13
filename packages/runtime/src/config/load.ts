import { join } from "node:path"

import { Effect, Schema } from "effect"

import { type Env, firstNonEmpty, homeDirectory } from "../setup/environment.ts"
import { readText } from "../state/files.ts"
import { CONFIG_FILE, STATE_DIRECTORY } from "../state/layout.ts"
import { ConfigInvalid } from "./errors.ts"
import { Config, ConfigFile } from "./schema.ts"

/**
 * The environment variable that names the home directory of the user-level config, in place of the
 * operating system's; tests and sandboxes use it to keep the real home out of a run.
 */
export const HOME_VARIABLE = "HOLYAGENT_HOME"

/**
 * The user-level config file: `.holyagent/config.json` in `HOLYAGENT_HOME`, else in the home
 * directory.
 */
export const userConfigFile = (env: Env): string =>
  join(firstNonEmpty(env[HOME_VARIABLE]) ?? homeDirectory(env), STATE_DIRECTORY, CONFIG_FILE)

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Merges two decoded config values key by key: objects merge recursively and the override wins
 * wherever either side is not an object. A list is a value, so it replaces the base's list
 * wholesale and is never combined with it.
 */
const merge = (base: unknown, override: unknown): unknown =>
  isRecord(base) && isRecord(override)
    ? {
        ...base,
        ...Object.fromEntries(
          Object.entries(override).map(([key, value]) => [
            key,
            Object.hasOwn(base, key) ? merge(base[key], value) : value,
          ]),
        ),
      }
    : override

/**
 * Settings that the user-level file can switch off for good: where the user file holds the "off"
 * value, the project file cannot turn the setting back on (it can still turn it off). They are the
 * settings that grant access, to the computer, to devices and to the web.
 */
const FINAL_OFF: ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly off: unknown }> = [
  { path: ["pi", "features", "computerUse"], off: false },
  { path: ["pi", "features", "web"], off: "off" },
  { path: ["pi", "t3", "deviceAccess"], off: false },
]

const valueAt = (value: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce((node, key) => (isRecord(node) ? node[key] : undefined), value)

const setAt = (value: unknown, path: ReadonlyArray<string>, leaf: unknown): unknown => {
  const [key, ...rest] = path
  return key === undefined
    ? leaf
    : { ...(isRecord(value) ? value : {}), [key]: setAt(valueAt(value, [key]), rest, leaf) }
}

/**
 * Whether a decoded user-level config switches the setting at `path` off for good: it holds the
 * "off" value of a setting the project cannot turn back on (`pi.features.computerUse`,
 * `pi.features.web`, `pi.t3.deviceAccess`).
 */
export const userLocksOff = (user: unknown, path: ReadonlyArray<string>): boolean =>
  FINAL_OFF.some(
    (entry) => entry.path.join(".") === path.join(".") && valueAt(user, entry.path) === entry.off,
  )

/**
 * Settings that only the user-level file decides, since they are security controls that a cloned
 * repository must not weaken: auto-review's switch and its policy text. A project file that holds
 * them is read and then ignored for these keys.
 */
const USER_ONLY: ReadonlyArray<ReadonlyArray<string>> = [
  ["pi", "features", "autoReview"],
  ["pi", "autoReview"],
]

/**
 * Whether a setting is one only the user-level file decides (see `USER_ONLY`): a project or local
 * file that holds it is ignored, so setup must not write it there.
 */
export const isUserOnly = (path: ReadonlyArray<string>): boolean =>
  USER_ONLY.some((entry) => entry.join(".") === path.join("."))

// The value without the key at `path`, which stays out of the merge.
const withoutAt = (value: unknown, path: ReadonlyArray<string>): unknown => {
  const [key, ...rest] = path
  if (key === undefined || !isRecord(value) || !Object.hasOwn(value, key)) return value
  const entries = Object.entries(value)
  return Object.fromEntries(
    rest.length === 0
      ? entries.filter(([name]) => name !== key)
      : entries.map(([name, item]) => [name, name === key ? withoutAt(item, rest) : item]),
  )
}

/**
 * Merges the project over the user, without the project's value for a user-only setting, then
 * restores every setting the user switched off for good.
 */
const mergeFiles = (user: unknown, project: unknown): unknown =>
  FINAL_OFF.reduce(
    (merged, { path, off }) => (valueAt(user, path) === off ? setAt(merged, path, off) : merged),
    merge(
      user,
      USER_ONLY.reduce((kept, path) => withoutAt(kept, path), project),
    ),
  )

const JsonValue = Schema.fromJsonString(Schema.Unknown)

/**
 * A `"vcs": null` is read as no `vcs` section, as older files and tools wrote it; the other
 * sections stay strict.
 */
const withoutNullVcs = (value: unknown): unknown =>
  isRecord(value) && value["vcs"] === null
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "vcs"))
    : value

/**
 * Reads one config file and decodes it strictly: an unknown key or an invalid value, at any depth,
 * fails with ConfigInvalid naming the field and this file's path. A missing file reads as
 * undefined, and no default is applied yet, so the file can still be merged.
 */
export const readConfigFile = (path: string) =>
  readText(path).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(JsonValue)(text).pipe(
            Effect.map(withoutNullVcs),
            Effect.flatMap(Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })),
            Effect.mapError((error) => new ConfigInvalid({ path, reason: error.message })),
          ),
    ),
  )

/** Where to look for the config files. */
export interface ConfigSources {
  /**
   * The project's state folders, `.holyagent` folders in the order to try: the config file of the
   * first one that has one is the project's.
   */
  readonly projectDirectories: ReadonlyArray<string>
  /** The environment that places the user-level file; the process's by default. */
  readonly env?: Env
}

/**
 * Loads the HolyAgent config: the user-level `~/.holyagent/config.json`, then the project's
 * `.holyagent/config.json`, each decoded with excess properties refused, merged key by key with the
 * project winning (lists replace wholesale), and the defaults filling what neither file sets. A
 * setting that the user file switches off for good (`pi.features.computerUse`, `pi.features.web`,
 * `pi.t3.deviceAccess`) stays off whatever the project says, and auto-review's switch and policy
 * (`pi.features.autoReview`, `pi.autoReview`) are the user file's alone. A missing file reads as an
 * empty one; a bad file stops the load with ConfigInvalid for that file.
 */
export const loadConfigWithSource = ({ projectDirectories, env = process.env }: ConfigSources) =>
  Effect.gen(function* () {
    const userPath = userConfigFile(env)
    const user = yield* readConfigFile(userPath)
    let project: typeof user
    let projectPath: string | undefined
    for (const directory of projectDirectories) {
      const path = join(directory, CONFIG_FILE)
      project = yield* readConfigFile(path)
      if (project !== undefined) {
        projectPath = path
        break
      }
    }
    // Preserve the written values as well as the resolved defaults so explicit routes stay explicit.
    const written = yield* Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })(
      mergeFiles(user ?? {}, project ?? {}),
    ).pipe(
      Effect.mapError(
        (error) => new ConfigInvalid({ path: projectPath ?? userPath, reason: error.message }),
      ),
    )
    const config = yield* Schema.decodeUnknownEffect(Config)(written).pipe(
      Effect.mapError(
        (error) => new ConfigInvalid({ path: projectPath ?? userPath, reason: error.message }),
      ),
    )
    return { config, written }
  })

/** Loads the resolved config without its source-level override information. */
export const loadConfig = (sources: ConfigSources) =>
  loadConfigWithSource(sources).pipe(Effect.map(({ config }) => config))
