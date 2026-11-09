import { isAbsolute, relative, resolve, sep } from "node:path"

import { Data, Effect } from "effect"

/** The name of the tool the Codex provider adds for specialists that write files. */
export const APPLY_PATCH_TOOL = "apply_patch"

/**
 * What the model reads about the tool: the format of Codex's `apply_patch`, which GPT-6 is trained
 * on, so the tool takes the patch in the shape the model already knows.
 */
export const APPLY_PATCH_DESCRIPTION = `Edit files with a patch. Put the whole patch in \`input\`:

*** Begin Patch
*** Add File: path/new.txt
+first line
*** Update File: path/old.txt
*** Move to: path/renamed.txt
@@ function name or other line that places the hunk
 a line kept as it is
-a line to remove
+a line to add
*** Delete File: path/gone.txt
*** End Patch

Each file operation is Add File (every line starts with +), Delete File, or Update File with an optional Move to and one or more hunks. A hunk starts with @@ (the first may omit it); its lines start with a space (kept), - (removed) or + (added). Give about three lines of context around each change, enough to find the place once; add *** End of File after a hunk that ends at the end of the file. Paths are relative to the working directory, never absolute. The patch is applied whole or not at all.`

/** The patch text does not follow Codex's patch format. `line` is the 1-based line, when known. */
export class PatchSyntaxError extends Data.TaggedError("PatchSyntaxError")<{
  readonly reason: string
  readonly line?: number
}> {
  /** The description shown to the model. */
  override get message() {
    return this.line === undefined
      ? `Invalid patch: ${this.reason}`
      : `Invalid patch at line ${this.line}: ${this.reason}`
  }
}

/** A path of the patch is absolute or leaves the working directory. */
export class PatchPathError extends Data.TaggedError("PatchPathError")<{
  readonly path: string
}> {
  /** The description shown to the model. */
  override get message() {
    return `Invalid patch: ${this.path} is not a path below the working directory; file references must be relative`
  }
}

/** A hunk does not match the file: the context line or the lines to replace were not found. */
export class PatchContextError extends Data.TaggedError("PatchContextError")<{
  readonly path: string
  readonly reason: string
}> {
  /** The description shown to the model. */
  override get message() {
    return `${this.reason} in ${this.path}`
  }
}

/** A file the patch names cannot be read, written or removed, or is missing when it must exist. */
export class PatchFileError extends Data.TaggedError("PatchFileError")<{
  readonly path: string
  readonly reason: string
}> {
  /** The description shown to the model. */
  override get message() {
    return `${this.path}: ${this.reason}`
  }
}

/** Every way a patch can fail; none of them leaves a file changed. */
export type PatchError = PatchSyntaxError | PatchPathError | PatchContextError | PatchFileError

/**
 * The file system a patch is applied to, with absolute paths. `read` answers `undefined` for a file
 * that does not exist; `write` creates the folders above the file; `remove` deletes the file;
 * `real` resolves symbolic links. The extension supplies one over the disk, a test an in-memory
 * one.
 */
export interface PatchFs {
  /**
   * The path with every symbolic link resolved. For a path that does not exist yet, its nearest
   * existing ancestor is resolved and the rest is kept, so the answer says where a write would
   * land.
   */
  readonly real: (path: string) => Effect.Effect<string, PatchFileError>
  /** Reads a file as text, or `undefined` when it does not exist. */
  readonly read: (path: string) => Effect.Effect<string | undefined, PatchFileError>
  /** Writes a file's whole text, creating its folders. */
  readonly write: (path: string, text: string) => Effect.Effect<void, PatchFileError>
  /** Deletes a file. */
  readonly remove: (path: string) => Effect.Effect<void, PatchFileError>
}

/** One changed region of an updated file: the lines it replaces and the lines that replace them. */
export interface Hunk {
  /** The line that places the hunk (the text after `@@`), when the hunk names one. */
  readonly context: string | undefined
  readonly oldLines: ReadonlyArray<string>
  readonly newLines: ReadonlyArray<string>
  /** True when the hunk ends with `*** End of File`: it matches at the end of the file. */
  readonly endOfFile: boolean
}

/** One file operation of a patch. */
export type FileOperation =
  | { readonly kind: "add"; readonly path: string; readonly text: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "update"
      readonly path: string
      readonly moveTo: string | undefined
      readonly hunks: ReadonlyArray<Hunk>
    }

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"
const ADD = "*** Add File: "
const DELETE = "*** Delete File: "
const UPDATE = "*** Update File: "
const MOVE = "*** Move to: "
const END_OF_FILE = "*** End of File"

/** A shell heredoc around the patch (`<<'EOF' ... EOF`), which models sometimes leave in. */
const HEREDOC = /^<<-?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1$/

const unwrapHeredoc = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const first = lines[0]?.trim() ?? ""
  const match = HEREDOC.exec(first)
  const last = lines.at(-1)?.trim()
  return match !== null && lines.length >= 2 && last === match[2] ? lines.slice(1, -1) : lines
}

/**
 * Parses a patch in Codex's format: `*** Begin Patch`, then `*** Add File:`, `*** Delete File:` and
 * `*** Update File:` operations (an update may follow with `*** Move to:`), then `*** End Patch`.
 * An update holds hunks, each opened by `@@` (the first may omit it) and made of lines that start
 * with a space (kept), `-` (removed) or `+` (added), closed by an optional `*** End of File`. A
 * heredoc around the patch is accepted. The parser reads the text and touches no file.
 */
export const parsePatch = (
  text: string,
): Effect.Effect<ReadonlyArray<FileOperation>, PatchSyntaxError> =>
  Effect.suspend(() => {
    const lines = unwrapHeredoc(
      text
        .trim()
        .split("\n")
        .map((line) => line.replace(/\r$/, "")),
    )
    const fail = (reason: string, at?: number) =>
      Effect.fail(new PatchSyntaxError(at === undefined ? { reason } : { reason, line: at + 1 }))
    if (lines[0]?.trim() !== BEGIN) return fail(`the first line must be '${BEGIN}'`)
    if (lines.at(-1)?.trim() !== END) return fail(`the last line must be '${END}'`)
    const operations: Array<FileOperation> = []
    let at = 1
    const last = lines.length - 1
    while (at < last) {
      const head = (lines[at] ?? "").trim()
      if (head.startsWith(ADD)) {
        const body: Array<string> = []
        at += 1
        while (at < last && (lines[at] ?? "").startsWith("+")) {
          body.push(`${(lines[at] ?? "").slice(1)}\n`)
          at += 1
        }
        operations.push({ kind: "add", path: head.slice(ADD.length), text: body.join("") })
      } else if (head.startsWith(DELETE)) {
        operations.push({ kind: "delete", path: head.slice(DELETE.length) })
        at += 1
      } else if (head.startsWith(UPDATE)) {
        const path = head.slice(UPDATE.length)
        at += 1
        let moveTo: string | undefined
        const move = (lines[at] ?? "").trim()
        if (at < last && move.startsWith(MOVE)) {
          moveTo = move.slice(MOVE.length)
          at += 1
        }
        const hunks: Array<Hunk> = []
        while (at < last && !(lines[at] ?? "").startsWith("***")) {
          const first = lines[at] ?? ""
          let context: string | undefined
          if (first === "@@") at += 1
          else if (first.startsWith("@@ ")) {
            context = first.slice(3)
            at += 1
          } else if (hunks.length > 0)
            return fail(
              `expected an update hunk to start with a @@ context marker, found '${first}'`,
              at,
            )
          const oldLines: Array<string> = []
          const newLines: Array<string> = []
          let endOfFile = false
          let read = 0
          while (at < last) {
            const line = lines[at] ?? ""
            if (line === END_OF_FILE) {
              if (read === 0) return fail("an update hunk does not contain any lines", at)
              endOfFile = true
              at += 1
              break
            }
            const marker = line.slice(0, 1)
            if (line === "" || marker === " ") {
              oldLines.push(line.slice(1))
              newLines.push(line.slice(1))
            } else if (marker === "+") newLines.push(line.slice(1))
            else if (marker === "-") oldLines.push(line.slice(1))
            else if (read === 0)
              return fail(
                `unexpected line in an update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line) or '-' (removed line)`,
                at,
              )
            else break
            read += 1
            at += 1
          }
          if (read === 0 && !endOfFile) return fail("an update hunk does not contain any lines", at)
          hunks.push({ context, oldLines, newLines, endOfFile })
        }
        if (hunks.length === 0) return fail(`the update of ${path} has no hunks`, at)
        operations.push({ kind: "update", path, moveTo, hunks })
      } else {
        return fail(
          `'${head}' is not a valid file operation; expected '${ADD.trim()}', '${DELETE.trim()}' or '${UPDATE.trim()}'`,
          at,
        )
      }
    }
    return operations.length === 0
      ? fail("the patch has no file operations")
      : Effect.succeed(operations)
  })

// Typographic look-alikes that models write for their ASCII twins, as Codex's matcher folds them.
const normalised = (line: string): string =>
  line
    .trim()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘-‛]/g, "'")
    .replace(/[“-‟]/g, '"')
    .replace(/[  -   　]/g, " ")

const COMPARERS: ReadonlyArray<(a: string, b: string) => boolean> = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
  (a, b) => normalised(a) === normalised(b),
]

/**
 * Finds where `pattern` occurs in `lines` at or after `start`, matching exactly first, then with
 * trailing whitespace ignored, then with surrounding whitespace ignored, then with typographic
 * punctuation folded to ASCII; the first level that matches wins. An end-of-file pattern is looked
 * for at the end first. Returns the index of its first line, or `undefined`.
 */
export const seekSequence = (
  lines: ReadonlyArray<string>,
  pattern: ReadonlyArray<string>,
  start: number,
  endOfFile: boolean,
): number | undefined => {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return undefined
  const from = endOfFile ? lines.length - pattern.length : start
  for (const same of COMPARERS)
    for (let index = from; index <= lines.length - pattern.length; index += 1)
      if (pattern.every((line, offset) => same(lines[index + offset] ?? "", line))) return index
  return undefined
}

/** One region of a file to replace: where it starts, how many lines go, and what takes their place. */
interface Replacement {
  readonly start: number
  readonly length: number
  readonly lines: ReadonlyArray<string>
}

const withoutLast = <T>(items: ReadonlyArray<T>): ReadonlyArray<T> => items.slice(0, -1)

/**
 * Applies the hunks of one update to a file's text. Each hunk is placed after the previous one: its
 * context line (if any) is sought first, then its removed and kept lines. A hunk with no lines to
 * match is appended at the end. The file's line ending (`\r\n` or `\n`) is kept and the result ends
 * with one.
 */
export const updatedText = (
  path: string,
  original: string,
  hunks: ReadonlyArray<Hunk>,
): Effect.Effect<string, PatchContextError> =>
  Effect.gen(function* () {
    const eol = original.includes("\r\n") ? "\r\n" : "\n"
    const lines = original.split(/\r?\n/)
    if (lines.at(-1) === "") lines.pop()
    const replacements: Array<Replacement> = []
    let cursor = 0
    for (const hunk of hunks) {
      if (hunk.context !== undefined) {
        const found = seekSequence(lines, [hunk.context], cursor, false)
        if (found === undefined)
          return yield* new PatchContextError({
            path,
            reason: `Failed to find context '${hunk.context}'`,
          })
        cursor = found + 1
      }
      if (hunk.oldLines.length === 0) {
        replacements.push({ start: lines.length, length: 0, lines: hunk.newLines })
        continue
      }
      let pattern = hunk.oldLines
      let replacement = hunk.newLines
      let found = seekSequence(lines, pattern, cursor, hunk.endOfFile)
      if (found === undefined && pattern.at(-1) === "") {
        pattern = withoutLast(pattern)
        if (replacement.at(-1) === "") replacement = withoutLast(replacement)
        found = seekSequence(lines, pattern, cursor, hunk.endOfFile)
      }
      if (found === undefined)
        return yield* new PatchContextError({
          path,
          reason: `Failed to find expected lines:\n${hunk.oldLines.join("\n")}\n`,
        })
      replacements.push({ start: found, length: pattern.length, lines: replacement })
      cursor = found + pattern.length
    }
    const result = [...lines]
    for (const { start, length, lines: added } of replacements
      .toSorted((a, b) => a.start - b.start)
      .toReversed())
      result.splice(start, length, ...added)
    return `${result.join(eol)}${eol}`
  })

/** What a patch did: each file and what happened to it, in the order of the patch. */
export interface PatchResult {
  /** `A` added, `M` modified (or moved to), `D` deleted, with the path as the patch wrote it. */
  readonly changes: ReadonlyArray<{ readonly status: "A" | "M" | "D"; readonly path: string }>
  /** The summary the tool returns to the model. */
  readonly summary: string
}

const summarise = (changes: PatchResult["changes"]): string =>
  `Success. Updated the following files:\n${changes
    .map(({ status, path }) => `${status} ${path}`)
    .join("\n")}`

/** Whether `file` is `root` or below it, by the text of the two paths. */
const isBelow = (root: string, file: string): boolean => {
  const inside = relative(root, file)
  return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}

/**
 * Applies a patch in Codex's format below `cwd`. Every path must be relative and stay below `cwd`,
 * also once symbolic links are resolved (`PatchFs.real`), so a link inside the project cannot carry
 * a write out of it. The whole patch is planned in memory first, reading each file once and seeing
 * the effect of the operations before it, so a bad hunk, a missing file or a bad path fails before
 * any file changes; the writes then run in the order of the patch. If one of them fails, the files
 * already written are put back as they were (folders the writes created stay), so the patch is
 * applied whole or not at all. Add overwrites an existing file; delete and update need the file to
 * exist; an update's `Move to` writes the new path and removes the old one, and a `Move to` that
 * names the file's own path is a plain update.
 */
export const applyPatch = (
  text: string,
  cwd: string,
  fs: PatchFs,
): Effect.Effect<PatchResult, PatchError> =>
  Effect.gen(function* () {
    const operations = yield* parsePatch(text)
    const realCwd = yield* fs.real(cwd)
    const locate = (path: string) => {
      const file = resolve(cwd, path)
      return path === "" || isAbsolute(path) || !isBelow(cwd, file)
        ? Effect.fail(new PatchPathError({ path }))
        : fs
            .real(file)
            .pipe(
              Effect.flatMap((real) =>
                isBelow(realCwd, real)
                  ? Effect.succeed(file)
                  : Effect.fail(new PatchPathError({ path })),
              ),
            )
    }
    // The planned content of each touched file, in the order first touched: its text, or `null`
    // once deleted.
    const planned = new Map<string, string | null>()
    const load = (file: string, path: string) =>
      Effect.gen(function* () {
        const known = planned.get(file)
        return known !== undefined ? known : ((yield* fs.read(file)) ?? null)
      }).pipe(
        Effect.flatMap((content) =>
          content === null
            ? Effect.fail(new PatchFileError({ path, reason: "Failed to read file to update" }))
            : Effect.succeed(content),
        ),
      )
    const stage = (file: string, content: string | null) => {
      planned.set(file, content)
    }
    const changes: Array<PatchResult["changes"][number]> = []
    for (const operation of operations) {
      const file = yield* locate(operation.path)
      if (operation.kind === "add") {
        stage(file, operation.text)
        changes.push({ status: "A", path: operation.path })
      } else if (operation.kind === "delete") {
        yield* load(file, operation.path)
        stage(file, null)
        changes.push({ status: "D", path: operation.path })
      } else {
        const next = yield* updatedText(
          operation.path,
          yield* load(file, operation.path),
          operation.hunks,
        )
        const target = operation.moveTo === undefined ? file : yield* locate(operation.moveTo)
        stage(target, next)
        // A move to the file's own path leaves the file in place: only a real move removes the old one.
        if (target !== file) stage(file, null)
        changes.push({ status: "M", path: operation.moveTo ?? operation.path })
      }
    }
    // What each write replaced, in the order of the writes, so a failure can put it back.
    const written: Array<{ readonly file: string; readonly before: string | undefined }> = []
    const writeAll = Effect.gen(function* () {
      for (const [file, content] of planned) {
        const before = yield* fs.read(file)
        // A file the patch created and then moved or deleted was never on disk: nothing to remove.
        if (content === null && before === undefined) continue
        // Recorded before the attempt: a write that fails halfway may have left the file changed.
        written.push({ file, before })
        yield* content === null ? fs.remove(file) : fs.write(file, content)
      }
    })
    // Puts the written files back, newest first; answers the files it could not put back.
    const restore = Effect.suspend(() =>
      Effect.forEach(written.toReversed(), ({ file, before }) =>
        (before === undefined
          ? fs
              .read(file)
              .pipe(Effect.flatMap((now) => (now === undefined ? Effect.void : fs.remove(file))))
          : fs.write(file, before)
        ).pipe(
          Effect.as([] as ReadonlyArray<string>),
          Effect.catch(() => Effect.succeed([file])),
        ),
      ).pipe(Effect.map((failed) => failed.flat())),
    )
    yield* writeAll.pipe(
      Effect.catch((error) =>
        restore.pipe(
          Effect.flatMap((stuck) =>
            Effect.fail(
              stuck.length === 0
                ? error
                : new PatchFileError({
                    path: error.path,
                    reason: `${error.reason} (and could not restore ${stuck.join(", ")})`,
                  }),
            ),
          ),
        ),
      ),
    )
    return { changes, summary: summarise(changes) }
  })
