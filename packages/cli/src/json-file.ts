import { Effect, Equal, FileSystem, Path, Schema } from "effect"

import { CliFailure } from "./report.ts"

/** A JSON object whose values are left untouched; used for files the user also edits by hand. */
export type JsonObject = { readonly [key: string]: unknown }

const JsonObjectText = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), {
  space: 2,
})

const empty: JsonObject = {}

/** Whether a decoded JSON value is a plain object (not an array, null or a scalar). */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Reads a JSON object file. A missing file is an empty object, and a file that is not a JSON object
 * fails with a message naming the file, so a hand-edited file is never overwritten.
 */
export const readJsonObject = (path: string) =>
  readJsonObjectSnapshot(path).pipe(Effect.map((snapshot) => snapshot.value))

/** A JSON object file as read: the object, and the text it came from (`undefined` when missing). */
export interface JsonSnapshot {
  readonly value: JsonObject
  readonly text: string | undefined
}

/**
 * Reads a JSON object file like {@link readJsonObject} and also returns its text, so a later write
 * can check that the file did not change in between (see {@link writeJsonObjectIfUnchanged}).
 */
export const readJsonObjectSnapshot = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path))) return { value: empty, text: undefined } satisfies JsonSnapshot
    const text = yield* fs.readFileString(path)
    const value = yield* Schema.decodeUnknownEffect(JsonObjectText)(text).pipe(
      Effect.mapError(
        (error) => new CliFailure({ message: `${path} is not a JSON object: ${error.message}` }),
      ),
    )
    return { value, text } satisfies JsonSnapshot
  }).pipe(
    Effect.catchTag(
      "PlatformError",
      (error) => new CliFailure({ message: `cannot read ${path}: ${error.message}` }),
    ),
  )

/**
 * Writes a JSON object with two-space indentation and a final newline. The text goes to a temporary
 * file next to the target and is renamed over it, so readers never see a partial file.
 */
export const writeJsonObject = (
  path: string,
  value: JsonObject,
  options?: { readonly mode?: number },
) => replaceJsonObject(path, value, options).pipe(Effect.asVoid)

/**
 * Like {@link writeJsonObject}, but writes only when the file still has the text `unchangedSince`
 * (from {@link readJsonObjectSnapshot}); the check runs just before the rename, so the window in
 * which another program's update could be lost is the rename itself. Returns whether it wrote.
 */
export const writeJsonObjectIfUnchanged = (
  path: string,
  value: JsonObject,
  unchangedSince: string,
  options?: { readonly mode?: number },
) => replaceJsonObject(path, value, options, unchangedSince)

const replaceJsonObject = (
  path: string,
  value: JsonObject,
  options?: { readonly mode?: number },
  unchangedSince?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { dirname, basename, join } = yield* Path.Path
    // Write through a symlink to the real file, and keep the permissions the file already has.
    const exists = yield* fs.exists(path)
    const target = exists ? yield* fs.realPath(path) : path
    const mode = options?.mode ?? (exists ? (yield* fs.stat(target)).mode & 0o777 : undefined)
    const directory = dirname(target)
    const temporary = join(directory, `.${basename(target)}.${process.pid}.tmp`)
    const text = (yield* Schema.encodeEffect(JsonObjectText)(value)) + "\n"
    yield* fs.makeDirectory(directory, { recursive: true })
    yield* fs.writeFileString(temporary, text, {
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    })
    return yield* Effect.gen(function* () {
      // The open call applies the umask; chmod sets the exact mode.
      if (mode !== undefined) yield* fs.chmod(temporary, mode)
      if (unchangedSince !== undefined && (yield* fs.readFileString(target)) !== unchangedSince) {
        yield* fs.remove(temporary)
        return false
      }
      yield* fs.rename(temporary, target)
      return true
    }).pipe(Effect.onError(() => Effect.ignore(fs.remove(temporary))))
  }).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        new CliFailure({ message: `cannot write ${path}: ${error.message}` }),
      SchemaError: (error) =>
        new CliFailure({ message: `cannot encode ${path}: ${error.message}` }),
    }),
  )

/** A value that should exist at a key path, reported at the depth of the path. */
export interface Default {
  readonly path: readonly [string, ...Array<string>]
  readonly value: unknown
}

/** One planned key: `added` when missing, `present` when already equal, `kept` when it differs. */
export interface Entry {
  readonly path: string
  readonly status: "added" | "present" | "kept"
  /** The value now in the file (the existing one for `present` and `kept`). */
  readonly value: unknown
  readonly wanted: unknown
}

const place = (
  node: JsonObject,
  path: readonly [string, ...Array<string>],
  depth: number,
  wanted: unknown,
): readonly [JsonObject, Entry] => {
  const key = path[depth] as string
  const reported = path.slice(0, depth + 1).join(".")
  const current = node[key]
  if (depth === path.length - 1) {
    if (current === undefined) {
      return [
        { ...node, [key]: wanted },
        { path: reported, status: "added", value: wanted, wanted },
      ]
    }
    const status = Equal.equals(current, wanted) ? "present" : "kept"
    return [node, { path: reported, status, value: current, wanted }]
  }
  // A scalar or array where an object is needed is the user's choice; leave it alone.
  if (current !== undefined && !isJsonObject(current)) {
    return [node, { path: reported, status: "kept", value: current, wanted }]
  }
  const [child, entry] = place(current ?? {}, path, depth + 1, wanted)
  return [child === current ? node : { ...node, [key]: child }, entry]
}

/**
 * Adds each default that is missing and leaves every existing value as it is. Returns the merged
 * object, which is the input itself when nothing was added, and one entry per distinct key path.
 */
export const applyDefaults = (
  existing: JsonObject,
  defaults: ReadonlyArray<Default>,
): { readonly merged: JsonObject; readonly entries: ReadonlyArray<Entry> } => {
  let merged = existing
  const entries = new Map<string, Entry>()
  for (const { path, value } of defaults) {
    const [next, entry] = place(merged, path, 0, value)
    merged = next
    if (!entries.has(entry.path)) entries.set(entry.path, entry)
  }
  return { merged, entries: [...entries.values()] }
}
