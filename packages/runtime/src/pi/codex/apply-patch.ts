import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { Data, Effect } from "effect"

export { APPLY_PATCH_TOOL } from "@holyagent/core/pi/codex/names.ts"

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
 * What sits at a path itself, a final symbolic link not followed: a file with its exact bytes and
 * permission bits, or a link with the target it holds. A write that fails is put back from it.
 */
export type Snapshot =
  | { readonly kind: "file"; readonly bytes: Uint8Array; readonly mode: number }
  | { readonly kind: "link"; readonly target: string }

/**
 * The file system a patch is applied to, with absolute paths. `read` answers `undefined` for a file
 * that does not exist; `write` creates the folders above the file; `remove` deletes the file, or
 * only the link when the path is one; `real` resolves symbolic links; `kind` tells what sits at a
 * path without reading it; `snapshot` and `restore` save and put back what sits at a path. The
 * extension supplies one over the disk, a test an in-memory one.
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
  /** Deletes a file; for a symbolic link, the link and not its target. */
  readonly remove: (path: string) => Effect.Effect<void, PatchFileError>
  /**
   * Whether a link, or anything else (a file), sits at the path itself, or `undefined` when nothing
   * does; a final link is not followed and no content is read.
   */
  readonly kind: (path: string) => Effect.Effect<"link" | "file" | undefined, PatchFileError>
  /** What sits at the path itself, or `undefined` when nothing does; a final link is not followed. */
  readonly snapshot: (path: string) => Effect.Effect<Snapshot | undefined, PatchFileError>
  /** Puts back what `snapshot` saved at the path, byte for byte, a link as a link. */
  readonly restore: (path: string, saved: Snapshot) => Effect.Effect<void, PatchFileError>
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
 * The paths a patch names in its file headers (`*** Add File:`, `*** Update File:`, `*** Delete
 * File:` and `*** Move to:`), read with the rule {@link parsePatch} reads a header by: each line is
 * trimmed first, so an indented header counts. It is a superset of what the parser accepts (it does
 * not follow hunks, so a context line that looks like a header is listed too), which is the safe
 * side for a check that decides what to review. Nothing is validated and no file is touched.
 */
export const patchHeaderPaths = (text: string): ReadonlyArray<string> =>
  text.split("\n").flatMap((line) => {
    const head = line.replace(/\r$/, "").trim()
    const header = [ADD, DELETE, UPDATE, MOVE].find((prefix) => head.startsWith(prefix))
    return header === undefined ? [] : [head.slice(header.length)]
  })

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
 * a write out of it; a file is known by its resolved path, so two names of one file are one file.
 * Deleting a link unlinks the link alone, so it may point out of the project. The whole patch is
 * planned in memory first, reading each file once and seeing the effect of the operations before
 * it, so a bad hunk, a missing file or a bad path fails before any file changes; the writes then
 * run in the order of the patch. If one of them fails, the files already written are put back as
 * they were, bytes and links included (folders the writes created stay), so the patch is applied
 * whole or not at all. Add overwrites an existing file; delete and update need the file to exist;
 * an update's `Move to` writes the new path and removes the old one, and a `Move to` that names the
 * file's own path is a plain update.
 */
export const applyPatch = (
  text: string,
  cwd: string,
  fs: PatchFs,
): Effect.Effect<PatchResult, PatchError> =>
  Effect.gen(function* () {
    const operations = yield* parsePatch(text)
    const realCwd = yield* fs.real(cwd)
    const lexical = (path: string) => {
      const file = resolve(cwd, path)
      return path === "" || isAbsolute(path) || !isBelow(cwd, file)
        ? Effect.fail(new PatchPathError({ path }))
        : Effect.succeed(file)
    }
    const inside = (path: string, real: string) =>
      isBelow(realCwd, real) ? Effect.succeed(real) : Effect.fail(new PatchPathError({ path }))
    // The resolved path of a file the patch names, which is also its key in `planned`: a symbolic
    // link or a change of case in the name does not make it another file.
    const locate = (path: string) =>
      lexical(path).pipe(
        Effect.flatMap(fs.real),
        Effect.flatMap((real) => inside(path, real)),
      )
    // What a delete (or the removal after a move) takes away. A symbolic link is itself, not its
    // target, so it is known by its resolved folder and its own name and may point out of the
    // project: unlinking it touches nothing outside.
    const locateEntry = (path: string) =>
      Effect.gen(function* () {
        const file = yield* lexical(path)
        const entry = yield* fs
          .real(dirname(file))
          .pipe(Effect.flatMap((folder) => inside(path, join(folder, basename(file)))))
        return (yield* fs.kind(entry)) === "link" ? entry : yield* locate(path)
      })
    // The planned content of each touched file by resolved path, in the order first touched: its
    // text, or `null` once deleted.
    const planned = new Map<string, string | null>()
    // What a file the patch needs holds: its planned state, else what `disk` finds there
    // (`undefined` for nothing). A file that is gone, planned or on disk, fails with `reason`.
    const need = <A>(
      file: string,
      path: string,
      reason: string,
      fromPlan: (content: string) => A,
      disk: Effect.Effect<A | undefined, PatchFileError>,
    ) =>
      Effect.gen(function* () {
        const known = planned.get(file)
        const found =
          known === undefined ? yield* disk : known === null ? undefined : fromPlan(known)
        return found === undefined ? yield* new PatchFileError({ path, reason }) : found
      })
    const load = (file: string, path: string) =>
      need(file, path, "Failed to read file to update", (content) => content, fs.read(file))
    // A delete finds a link, dangling or not, and never opens its target.
    const exists = (file: string, path: string) =>
      need(
        file,
        path,
        "Failed to delete file: it does not exist",
        () => true,
        fs.kind(file).pipe(Effect.map((kind) => (kind === undefined ? undefined : true))),
      )
    const stage = (file: string, content: string | null) => {
      planned.set(file, content)
    }
    const changes: Array<PatchResult["changes"][number]> = []
    for (const operation of operations) {
      if (operation.kind === "add") {
        // Adding where this patch deleted a link makes a regular file at the link's own path, not a
        // write to what the link led to.
        const entry = yield* locateEntry(operation.path)
        stage(planned.get(entry) === null ? entry : yield* locate(operation.path), operation.text)
        changes.push({ status: "A", path: operation.path })
      } else if (operation.kind === "delete") {
        const entry = yield* locateEntry(operation.path)
        yield* exists(entry, operation.path)
        stage(entry, null)
        changes.push({ status: "D", path: operation.path })
      } else {
        const file = yield* locate(operation.path)
        const next = yield* updatedText(
          operation.path,
          yield* load(file, operation.path),
          operation.hunks,
        )
        const target = operation.moveTo === undefined ? file : yield* locate(operation.moveTo)
        stage(target, next)
        // A move to the file's own path leaves the file in place: only a real move removes the old
        // one, and a link that was the old name goes alone, not the file it led to.
        if (target !== file) stage(yield* locateEntry(operation.path), null)
        changes.push({ status: "M", path: operation.moveTo ?? operation.path })
      }
    }
    // What each write replaced, in the order of the writes, so a failure can put it back.
    const written: Array<{ readonly file: string; readonly before: Snapshot | undefined }> = []
    const writeAll = Effect.gen(function* () {
      for (const [file, content] of planned) {
        const before = yield* fs.snapshot(file)
        // A file the patch created and then moved or deleted was never on disk: nothing to remove.
        if (content === null && before === undefined) continue
        // Recorded before the attempt: a write that fails halfway may have left the file changed.
        written.push({ file, before })
        // A link at the path is unlinked first, since a write would follow it to its target.
        if (content === null || before?.kind === "link") yield* fs.remove(file)
        if (content !== null) yield* fs.write(file, content)
      }
    })
    // Puts the written files back, newest first; answers the files it could not put back.
    const restore = Effect.suspend(() =>
      Effect.forEach(written.toReversed(), ({ file, before }) =>
        (before === undefined
          ? fs
              .snapshot(file)
              .pipe(Effect.flatMap((now) => (now === undefined ? Effect.void : fs.remove(file))))
          : fs.restore(file, before)
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
