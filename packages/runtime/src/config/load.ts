import { join } from "node:path"

import { Effect, Schema } from "effect"

import { type Env, firstNonEmpty, homeDirectory } from "../setup/environment.ts"
import { CorruptRecord } from "../state/errors.ts"
import { readText } from "../state/files.ts"
import { CONFIG_FILE, STATE_DIRECTORY } from "../state/layout.ts"
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

const JsonFile = Schema.fromJsonString(ConfigFile)

/**
 * Reads one config file and decodes it strictly: an unknown key or an invalid value, at any depth,
 * fails with CorruptRecord naming the field and this file's path. A missing file reads as
 * undefined, and no default is applied yet, so the file can still be merged.
 */
export const readConfigFile = (path: string) =>
  readText(path).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(JsonFile, { onExcessProperty: "error" })(text).pipe(
            Effect.mapError((error) => new CorruptRecord({ path, reason: error.message })),
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
 * missing file reads as an empty one; a bad file stops the load with CorruptRecord for that file.
 */
export const loadConfig = ({ projectDirectories, env = process.env }: ConfigSources) =>
  Effect.gen(function* () {
    const userPath = userConfigFile(env)
    const user = yield* readConfigFile(userPath)
    let project: typeof user
    let projectPath = userPath
    for (const directory of projectDirectories) {
      projectPath = join(directory, CONFIG_FILE)
      project = yield* readConfigFile(projectPath)
      if (project !== undefined) break
    }
    // Both files decoded on their own, so this only fills in defaults; it cannot refuse a setting.
    return yield* Schema.decodeUnknownEffect(Config)(merge(user ?? {}, project ?? {})).pipe(
      Effect.mapError(
        (error) =>
          new CorruptRecord({ path: `${userPath}, ${projectPath}`, reason: error.message }),
      ),
    )
  })
