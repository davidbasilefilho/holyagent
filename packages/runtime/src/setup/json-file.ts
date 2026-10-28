import { chmod, realpath, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { Effect, Equal, Schema } from "effect"

import { SetupFailure } from "./errors.ts"

/** A JSON object whose values are left untouched; used for files the user also edits by hand. */
export type JsonObject = { readonly [key: string]: unknown }

const JsonObjectText = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), {
  space: 2,
})

const strict = { onExcessProperty: "error" } as const

const empty: JsonObject = {}

/** Runs a file operation, turning a rejection into a SetupFailure that names the path. */
export const fileOperation = <A>(path: string, what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new SetupFailure({
        message: `cannot ${what} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

/** Whether decoded JSON is a plain object (not an array, null or a scalar). */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Whether a file exists; any failure to find out counts as not existing. */
export const fileExists = (path: string) =>
  Effect.tryPromise(() => Bun.file(path).exists()).pipe(Effect.orElseSucceed(() => false))

/**
 * Whether a file exists and contains the text; a missing or unreadable file contains nothing. The
 * read is a `tryPromise`, so its rejection is a failure that `orElseSucceed` handles, not a
 * defect.
 */
export const fileContains = (path: string, needle: string) =>
  Effect.tryPromise(() => Bun.file(path).text()).pipe(
    Effect.map((text) => text.includes(needle)),
    Effect.orElseSucceed(() => false),
  )

/**
 * Reads a JSON object file. A missing file, and a file that is empty or only whitespace, is an
 * empty object; a file that is not a JSON object fails with a message naming the file, so a
 * hand-edited file is never overwritten.
 */
export const readJsonObject = (path: string) =>
  Effect.gen(function* () {
    if (!(yield* fileOperation(path, "read", () => Bun.file(path).exists()))) return empty
    const text = yield* fileOperation(path, "read", () => Bun.file(path).text())
    if (text.trim() === "") return empty
    return yield* Schema.decodeUnknownEffect(JsonObjectText)(text, strict).pipe(
      Effect.mapError(
        (error) => new SetupFailure({ message: `${path} is not a JSON object: ${error.message}` }),
      ),
    )
  })

/**
 * Writes a JSON object with two-space indentation and a final newline. The text goes to a temporary
 * file next to the target and is renamed over it, so readers never see a partial file. A symlink is
 * written through to its real file, and an existing file keeps its permissions unless `mode` is
 * set.
 */
export const writeJsonObject = (
  path: string,
  value: JsonObject,
  options?: { readonly mode?: number },
) =>
  Effect.gen(function* () {
    const exists = yield* fileOperation(path, "write", () => Bun.file(path).exists())
    const target = exists ? yield* fileOperation(path, "write", () => realpath(path)) : path
    const mode =
      options?.mode ??
      (exists
        ? (yield* fileOperation(target, "write", () => Bun.file(target).stat())).mode & 0o777
        : undefined)
    const text =
      (yield* Schema.encodeEffect(JsonObjectText)(value, strict).pipe(
        Effect.mapError(
          (error) => new SetupFailure({ message: `cannot encode ${path}: ${error.message}` }),
        ),
      )) + "\n"
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`)
    yield* fileOperation(temporary, "write", () => Bun.write(temporary, text, { createPath: true }))
    yield* Effect.gen(function* () {
      // Bun.write applies the umask; chmod sets the exact mode.
      if (mode !== undefined) yield* fileOperation(temporary, "write", () => chmod(temporary, mode))
      yield* fileOperation(target, "write", () => rename(temporary, target))
    }).pipe(
      Effect.onError(() =>
        Effect.ignore(fileOperation(temporary, "remove", () => rm(temporary, { force: true }))),
      ),
    )
  })

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
