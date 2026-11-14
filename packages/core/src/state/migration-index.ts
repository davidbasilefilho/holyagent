import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { copyFile, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import { Effect } from "effect"

import { StateIo, StateLocked } from "./errors.ts"
import { hasCode, io } from "./files.ts"
import { spawn } from "./process.ts"

/** One migration-owned regular file. Content is base64, mode is a Git file mode. */
export interface MigrationIndexInput {
  readonly path: string
  readonly content: string
  readonly mode: number
}

/** The preimage is absent or is a committed blob with the recorded mode. */
export interface MigrationIndexFile extends MigrationIndexInput {
  readonly before: string | null
  readonly after: string
}

/** Output of the trusted Git process runner. */
export interface GitResult {
  readonly code: number
  readonly stdout: Uint8Array
  readonly stderr: string
}

/** A trusted, shell-free runner; the index override is supplied in env. */
export type MigrationGitRunner = (options: {
  readonly cwd: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly stdin?: string
}) => Effect.Effect<GitResult, StateIo>

const defaultRunner: MigrationGitRunner = ({ cwd, args, env, stdin }) =>
  spawn("git", args, { cwd, env, stdin }).pipe(
    Effect.catchDefect((cause) => Effect.fail(new StateIo({ path: cwd, cause }))),
  )

const repositoryVariables = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_QUARANTINE_PATH",
])

interface ReadOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly runGit?: MigrationGitRunner
}

interface Options<E, R> extends ReadOptions {
  readonly authorize: Effect.Effect<void, E, R>
}

type Entry = { readonly mode: number; readonly oid: string; readonly stage: number }

const fail = (path: string, cause: string) => new StateIo({ path, cause })
const validPath = (path: string) =>
  path !== "" &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const validContent = (content: string) =>
  Buffer.from(content, "base64").toString("base64") === content
const validMode = (mode: number) => mode === 0o100644 || mode === 0o100755

const validate = (cwd: string, files: ReadonlyArray<MigrationIndexInput>) => {
  const seen = new Set<string>()
  for (const file of files) {
    if (
      !validPath(file.path) ||
      seen.has(file.path) ||
      !validMode(file.mode) ||
      !validContent(file.content)
    )
      return fail(cwd, `invalid or duplicate migration path, mode, or content: ${file.path}`)
    if (
      [...seen].some(
        (other) => other.startsWith(`${file.path}/`) || file.path.startsWith(`${other}/`),
      )
    )
      return fail(cwd, `overlapping migration paths: ${file.path}`)
    seen.add(file.path)
  }
  return undefined
}

const environment = (env: Readonly<Record<string, string | undefined>>, index?: string) => {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...env }))
    if (value !== undefined && !repositoryVariables.has(key)) result[key] = value
  if (index !== undefined) result.GIT_INDEX_FILE = index
  // Replacement refs are views of objects, not the immutable objects recorded in a journal.
  result.GIT_NO_REPLACE_OBJECTS = "1"
  return result
}

const git = (options: ReadOptions, args: ReadonlyArray<string>, index?: string, stdin?: string) =>
  (options.runGit ?? defaultRunner)({
    cwd: options.cwd,
    args,
    env: environment(options.env, index),
    ...(stdin === undefined ? {} : { stdin }),
  }).pipe(
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.try({
            try: () =>
              new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(result.stdout),
            catch: () => fail(options.cwd, "git returned output that is not valid UTF-8"),
          })
        : Effect.fail(
            fail(options.cwd, `git ${args[0]} exited ${result.code}: ${result.stderr.trim()}`),
          ),
    ),
  )

const entries = (options: ReadOptions, index?: string, readOnly = false) =>
  git(
    options,
    [...(readOnly ? ["-c", "core.fsmonitor=false"] : []), "ls-files", "--stage", "-z"],
    index,
  ).pipe(
    Effect.flatMap((output) => {
      const found = new Map<string, Entry[]>()
      for (const record of output.split("\0")) {
        if (record === "") continue
        const match = /^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record)
        if (match === null || !oidPattern.test(match[2]!))
          return Effect.fail(fail(options.cwd, "git returned an invalid index entry"))
        const path = match[4]!
        const list = found.get(path) ?? []
        list.push({ mode: Number.parseInt(match[1]!, 8), oid: match[2]!, stage: Number(match[3]) })
        found.set(path, list)
      }
      return Effect.succeed(found)
    }),
  )

const same = (actual: ReadonlyArray<Entry> | undefined, oid: string | null, mode: number) =>
  oid === null
    ? actual === undefined
    : actual?.length === 1 &&
      actual[0]?.stage === 0 &&
      actual[0].oid === oid &&
      actual[0].mode === mode

const conflictingPath = (entries: ReadonlyMap<string, ReadonlyArray<Entry>>, path: string) =>
  [...entries.keys()].some(
    (other) => other !== path && (other.startsWith(`${path}/`) || path.startsWith(`${other}/`)),
  )

const fingerprint = (files: ReadonlyArray<MigrationIndexFile>, after: boolean) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...files]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((file) => [
            file.path,
            after ? file.after : file.before,
            after || file.before !== null ? file.mode : null,
          ]),
      ),
    )
    .digest("hex")

const temporary = <E, R, A, E2, R2>(
  options: Options<E, R>,
  use: (dir: string) => Effect.Effect<A, E2, R2>,
) =>
  Effect.acquireUseRelease(
    options.authorize.pipe(
      Effect.andThen(io(tmpdir(), () => mkdtemp(join(tmpdir(), "holyagent-migration-")))),
    ),
    use,
    (dir) => io(dir, () => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
  )

/** Creates an unreachable migration-only commit. Caller journals it before updating the ref. */
export const prepareMigrationCommit = <E, R>(
  options: Options<E, R> & {
    readonly files: ReadonlyArray<MigrationIndexInput>
    readonly message: string
  },
) =>
  Effect.gen(function* () {
    const invalid = validate(options.cwd, options.files)
    if (invalid !== undefined) return yield* invalid
    return yield* temporary(options, (dir) =>
      Effect.gen(function* () {
        const index = join(dir, "index")
        const parent = (yield* git(options, ["rev-parse", "--verify", "HEAD"])).trim()
        if (!oidPattern.test(parent)) return yield* fail(options.cwd, "invalid HEAD object id")
        yield* options.authorize
        yield* git(options, ["read-tree", parent], index)
        const base = yield* entries(options, index)
        const live = yield* entries(options)
        const files: MigrationIndexFile[] = []
        for (const file of options.files) {
          const contentPath = join(dir, randomUUID())
          yield* options.authorize
          yield* io(contentPath, () => writeFile(contentPath, Buffer.from(file.content, "base64")))
          yield* options.authorize
          const after = (yield* git(options, [
            "hash-object",
            "-w",
            "--no-filters",
            "--",
            contentPath,
          ])).trim()
          if (!oidPattern.test(after)) return yield* fail(options.cwd, "invalid blob object id")
          if (conflictingPath(base, file.path) || conflictingPath(live, file.path))
            return yield* fail(file.path, "migration target conflicts with another index path")
          const prior = base.get(file.path)
          if (
            prior !== undefined &&
            (prior.length !== 1 || prior[0]?.stage !== 0 || prior[0].mode !== file.mode)
          )
            return yield* fail(file.path, "migration target has an incompatible committed mode")
          const before = prior === undefined ? null : prior[0]!.oid
          if (!same(live.get(file.path), before, file.mode))
            return yield* fail(file.path, "migration target has an unexpected index entry")
          files.push({ ...file, before, after })
        }
        if (files.length > 0) {
          yield* options.authorize
          yield* git(
            options,
            ["update-index", "-z", "--index-info"],
            index,
            files.map((file) => `${file.mode.toString(8)} ${file.after}\t${file.path}\0`).join(""),
          )
        }
        yield* options.authorize
        const tree = (yield* git(options, ["write-tree"], index)).trim()
        yield* options.authorize
        const commit = (yield* git(options, [
          "-c",
          "commit.gpgsign=false",
          "commit-tree",
          tree,
          "-p",
          parent,
          "-m",
          options.message,
        ])).trim()
        if (!oidPattern.test(tree) || !oidPattern.test(commit))
          return yield* fail(options.cwd, "invalid tree or commit object id")
        return {
          parent,
          tree,
          commit,
          indexBefore: fingerprint(files, false),
          indexAfter: fingerprint(files, true),
          files,
        }
      }),
    )
  })

/** Publishes only owned entries, under Git's real index lock; accepts either recorded state. */
export const publishMigrationIndex = <E, R>(
  options: Options<E, R> & {
    readonly files: ReadonlyArray<MigrationIndexFile>
  },
) =>
  Effect.gen(function* () {
    const invalid = validate(options.cwd, options.files)
    if (invalid !== undefined) return yield* invalid
    for (const file of options.files)
      if (!oidPattern.test(file.after) || (file.before !== null && !oidPattern.test(file.before)))
        return yield* fail(file.path, "invalid migration index preimage")
    const name = (yield* git(options, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ])).trim()
    if (!isAbsolute(name)) return yield* fail(options.cwd, "git returned a relative index path")
    const index = resolve(name)
    const lock = `${index}.lock`
    let published = false
    return yield* Effect.acquireUseRelease(
      options.authorize.pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () =>
              open(
                lock,
                constants.O_WRONLY |
                  constants.O_CREAT |
                  constants.O_EXCL |
                  (constants.O_NOFOLLOW ?? 0),
                0o666,
              ),
            catch: (cause) =>
              hasCode(cause, "EEXIST")
                ? new StateLocked({ lockFile: lock })
                : new StateIo({ path: lock, cause }),
          }),
        ),
      ),
      (handle) =>
        temporary(options, (dir) =>
          Effect.gen(function* () {
            const copy = join(dir, "index")
            yield* options.authorize
            const copied = yield* io(index, () => copyFile(index, copy)).pipe(
              Effect.as(true),
              Effect.catchIf(
                (error) => hasCode(error.cause, "ENOENT"),
                () => Effect.succeed(false),
              ),
            )
            if (!copied) {
              yield* options.authorize
              yield* git(options, ["read-tree", "--empty"], copy)
            }
            const live = yield* entries(options, copy)
            for (const file of options.files) {
              if (
                conflictingPath(live, file.path) ||
                (!same(live.get(file.path), file.before, file.mode) &&
                  !same(live.get(file.path), file.after, file.mode))
              )
                return yield* fail(file.path, "migration index entry changed; inspect and retry")
            }
            if (options.files.length > 0) {
              yield* options.authorize
              yield* git(
                options,
                ["update-index", "-z", "--index-info"],
                copy,
                options.files
                  .map((file) => `${file.mode.toString(8)} ${file.after}\t${file.path}\0`)
                  .join(""),
              )
            }
            const bytes = yield* io(copy, () => readFile(copy))
            yield* options.authorize
            yield* io(lock, async () => {
              await handle.writeFile(bytes)
              await handle.sync()
              await handle.close()
            })
            yield* options.authorize
            yield* io(index, async () => {
              await rename(lock, index)
              published = true
            }).pipe(Effect.uninterruptible)
          }),
        ),
      (handle) =>
        io(lock, () => handle.close()).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.suspend(() =>
              published
                ? Effect.void
                : io(lock, () => rm(lock, { force: true })).pipe(Effect.ignore),
            ),
          ),
        ),
    )
  })

type TreeEntry = { readonly mode: number; readonly type: string; readonly oid: string }

const treeEntries = (options: ReadOptions, tree: string) =>
  git(options, ["ls-tree", "-r", "-t", "-z", "--full-tree", tree]).pipe(
    Effect.flatMap((output) => {
      const found = new Map<string, TreeEntry>()
      for (const record of output.split("\0")) {
        if (record === "") continue
        const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record)
        if (match === null || !oidPattern.test(match[3]!) || found.has(match[4]!))
          return Effect.fail(fail(options.cwd, "git returned an invalid tree entry"))
        found.set(match[4]!, {
          mode: Number.parseInt(match[1]!, 8),
          type: match[2]!,
          oid: match[3]!,
        })
      }
      return Effect.succeed(found)
    }),
  )

const sameTreeEntry = (left: TreeEntry | undefined, right: TreeEntry | undefined) =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      left.mode === right.mode &&
      left.type === right.type &&
      left.oid === right.oid

const validateRecordedFiles = (cwd: string, files: ReadonlyArray<MigrationIndexFile>) => {
  if (validate(cwd, files) !== undefined) return fail(cwd, "invalid recorded migration files")
  for (const file of files) {
    if (!oidPattern.test(file.after) || (file.before !== null && !oidPattern.test(file.before)))
      return fail(cwd, "invalid recorded migration object id")
    const bytes = Buffer.from(file.content, "base64")
    const actual = createHash(file.after.length === 40 ? "sha1" : "sha256")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex")
    if (actual !== file.after)
      return fail(cwd, "recorded migration content does not match its blob")
  }
  return undefined
}

/** Checks owned postimages in the live index without modifying it. `cwd` is a trusted root. */
export const verifyMigrationIndex = (
  options: ReadOptions & {
    readonly files: ReadonlyArray<MigrationIndexFile>
  },
) =>
  Effect.gen(function* () {
    const invalid = validateRecordedFiles(options.cwd, options.files)
    if (invalid !== undefined) return yield* invalid
    const readOnly = { ...options, env: { ...options.env, GIT_OPTIONAL_LOCKS: "0" } }
    const live = yield* entries(readOnly, undefined, true)
    for (const file of options.files)
      if (conflictingPath(live, file.path) || !same(live.get(file.path), file.after, file.mode))
        return yield* fail(
          options.cwd,
          "migration index postimage differs; inspect the index before retrying",
        )
  })

/**
 * Checks the exact single parent and tree, every owned pre/postimage, and every other tree entry.
 * `cwd` is a caller-trusted target root; roots in a journal must never choose the repository.
 */
export const verifyMigrationCommit = (
  options: ReadOptions & {
    readonly parent: string
    readonly tree: string
    readonly commit: string
    readonly files: ReadonlyArray<MigrationIndexFile>
  },
) =>
  Effect.gen(function* () {
    const invalid = validateRecordedFiles(options.cwd, options.files)
    if (invalid !== undefined) return yield* invalid
    if (![options.parent, options.tree, options.commit].every((oid) => oidPattern.test(oid)))
      return yield* fail(options.cwd, "invalid recorded migration commit object id")
    const readOnly = { ...options, env: { ...options.env, GIT_OPTIONAL_LOCKS: "0" } }
    const kind = (yield* git(readOnly, ["cat-file", "-t", options.commit])).trim()
    if (kind !== "commit")
      return yield* fail(options.cwd, "recorded migration object is not a commit")
    const header =
      (yield* git(readOnly, ["cat-file", "-p", options.commit])).split("\n\n", 1)[0] ?? ""
    const lines = header.split("\n")
    const trees = lines.filter((line) => line.startsWith("tree "))
    const parents = lines.filter((line) => line.startsWith("parent "))
    if (
      trees.length !== 1 ||
      trees[0] !== `tree ${options.tree}` ||
      parents.length !== 1 ||
      parents[0] !== `parent ${options.parent}`
    )
      return yield* fail(options.cwd, "migration commit parent or tree differs from the journal")
    const before = yield* treeEntries(readOnly, options.parent)
    const after = yield* treeEntries(readOnly, options.tree)
    const owned = new Map(options.files.map((file) => [file.path, file]))
    for (const file of options.files) {
      const preimage = before.get(file.path)
      const postimage = after.get(file.path)
      if (
        (file.before === null
          ? preimage !== undefined
          : preimage?.type !== "blob" ||
            preimage.mode !== file.mode ||
            preimage.oid !== file.before) ||
        postimage?.type !== "blob" ||
        postimage.mode !== file.mode ||
        postimage.oid !== file.after
      )
        return yield* fail(options.cwd, "migration commit owned file differs from the journal")
    }
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const prior = before.get(path)
      const current = after.get(path)
      if (sameTreeEntry(prior, current) || owned.has(path)) continue
      const ancestor = options.files.some((file) => file.path.startsWith(`${path}/`))
      if (
        ancestor &&
        (prior === undefined || prior.type === "tree") &&
        (current === undefined || current.type === "tree")
      )
        continue
      return yield* fail(options.cwd, "migration commit contains an unrelated tree change")
    }
  })
