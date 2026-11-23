import { join, resolve } from "node:path"

import { Effect, Schema } from "effect"

import { type Env, userFiles } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import { type JsonObject, readJsonObject, writeJsonObject } from "./json-file.ts"

/** One key setup added to a settings file: its path and the value it wrote there. */
export interface Recorded {
  readonly path: readonly [string, ...Array<string>]
  /** What setup wrote; for a list such as `permissions.deny`, the entries it added. */
  readonly value: unknown
}

const RecordedKey = Schema.Struct({
  path: Schema.NonEmptyArray(Schema.String),
  value: Schema.Unknown,
})

const RecordFile = Schema.Struct({
  files: Schema.Record(Schema.String, Schema.Struct({ keys: Schema.Array(RecordedKey) })),
})

/**
 * Where setup keeps what it added, one record for all settings files:
 * `holyagent/setup-records.json` in the user's Claude Code folder (`CLAUDE_CONFIG_DIR`, else
 * `~/.claude`). It lives outside the project, so a repository cannot forge it to steer `--undo`.
 */
export const recordPath = (env: Env) =>
  join(userFiles(env).claudeDir, "holyagent", "setup-records.json")

/** The settings file as the record names it: an absolute path. */
const keyOf = (file: string) => resolve(file)

type Records = Readonly<Record<string, ReadonlyArray<Recorded>>>

const load = (env: Env): Effect.Effect<Records, SetupFailure> =>
  Effect.gen(function* () {
    const path = recordPath(env)
    const raw = yield* readJsonObject(path)
    if (Object.keys(raw).length === 0) return {}
    const decoded = yield* Schema.decodeUnknownEffect(RecordFile)(raw, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new SetupFailure({
            message: `${path} is not a setup record: ${error.message}; fix or delete it`,
          }),
      ),
    )
    return Object.fromEntries(Object.entries(decoded.files).map(([file, { keys }]) => [file, keys]))
  })

const save = (env: Env, files: Records) => {
  const body: JsonObject = {
    files: Object.fromEntries(
      Object.entries(files).map(([file, keys]) => [
        file,
        { keys: keys.map((key) => ({ ...key })) },
      ]),
    ),
  }
  // It names absolute project paths: readable by the user alone.
  return writeJsonObject(recordPath(env), body, { mode: 0o600 })
}

/**
 * What setup recorded as added to the settings file `file`; nothing when it recorded none. Fails
 * with SetupFailure when the record exists but cannot be decoded.
 */
export const readRecorded = Effect.fn("readRecorded")(function* (env: Env, file: string) {
  return (yield* load(env))[keyOf(file)] ?? ([] as ReadonlyArray<Recorded>)
})

/**
 * Adds `added` to the record of `file`, merging with earlier records: a key recorded again replaces
 * its older entry. Fails with SetupFailure when the record cannot be decoded or written.
 */
export const addRecorded = Effect.fn("addRecorded")(function* (
  env: Env,
  file: string,
  added: ReadonlyArray<Recorded>,
) {
  if (added.length === 0) return
  const files = yield* load(env)
  const key = keyOf(file)
  const names = new Set(added.map((item) => item.path.join("\0")))
  const earlier = (files[key] ?? []).filter((item) => !names.has(item.path.join("\0")))
  yield* save(env, { ...files, [key]: [...earlier, ...added] })
})

/**
 * Forgets the record of `file`, after `--undo` handled it: a key that stayed is the user's now.
 * Fails with SetupFailure when the record cannot be decoded or written.
 */
export const clearRecorded = Effect.fn("clearRecorded")(function* (env: Env, file: string) {
  const files = yield* load(env)
  const key = keyOf(file)
  if (!(key in files)) return
  yield* save(env, Object.fromEntries(Object.entries(files).filter(([name]) => name !== key)))
})

/**
 * Forgets some keys of the record of `file`, after a revert handled them, and keeps the others; the
 * file's entry goes when none is left. Fails with SetupFailure when the record cannot be decoded or
 * written.
 */
export const removeRecorded = Effect.fn("removeRecorded")(function* (
  env: Env,
  file: string,
  removed: ReadonlyArray<Recorded["path"]>,
) {
  if (removed.length === 0) return
  const files = yield* load(env)
  const key = keyOf(file)
  const names = new Set(removed.map((path) => path.join("\0")))
  const left = (files[key] ?? []).filter((item) => !names.has(item.path.join("\0")))
  if (left.length === (files[key] ?? []).length) return
  const others = Object.entries(files).filter(([name]) => name !== key)
  yield* save(env, Object.fromEntries(left.length === 0 ? others : [...others, [key, left]]))
})
