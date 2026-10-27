import { mkdir, readdir, realpath, rm, rmdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import { looksLikeAgent } from "../vcs/identity.ts"
import { readSettings, type VcsSettings } from "../vcs/settings.ts"
import { StateIo } from "./errors.ts"
import { hasCode, io } from "./files.ts"
import { STATE_DIRECTORY } from "./layout.ts"
import { withFileLock, withStateLock } from "./lock.ts"

// The Intent state lives on one branch of its own, checked out in one linked worktree that every
// worktree of the clone shares. Work branches never carry `.holyagent/`, and the state branch
// carries nothing else, so merging either into the other, or into a branch stacked on it, cannot
// conflict. Every state transition is committed on the state branch, locally: pushing is the
// root's, with plain git.

/** The branch that holds the Intent state unless git config or the config file names another. */
export const DEFAULT_STATE_BRANCH = "holyagent/state"

/** The git config key that names the state branch. */
const BRANCH_KEY = "holyagent.stateBranch"

/**
 * How far a command may go to find the state: `create` makes the state worktree (and the branch)
 * when missing, `ifPresent` does so only for a project that already keeps state (a state branch,
 * its remote copy or a `.holyagent` folder in the work tree), and `peek` changes nothing.
 */
export type Ensure = "create" | "ifPresent" | "peek"

/** Where a command finds the state. */
export interface StateTree {
  /** The top-level folder of the work tree the command runs in, else the working directory. */
  readonly root: string
  /** The `.holyagent` folder that holds the state: in the state worktree, else under `root`. */
  readonly directory: string
}

/** The environment of a process, as the host passes it. */
export type Environment = Readonly<Record<string, string | undefined>>

/**
 * Variables that point git at one repository or index. They are set while git runs a hook, and
 * would make the git commands of the state worktree work on the wrong repository or index.
 */
const REPOSITORY_VARIABLES: ReadonlySet<string> = new Set([
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

const gitEnvironment = (env: Environment): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !REPOSITORY_VARIABLES.has(entry[0]),
    ),
  )

interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs git in a directory and reports how it ended; only a failure to start git is an error. */
const git = (cwd: string, env: Environment, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => $`git ${args}`.cwd(cwd).env(gitEnvironment(env)).quiet().nothrow(),
    catch: (cause) => new StateIo({ path: cwd, cause }),
  }).pipe(
    Effect.map((output): Ran => ({
      code: output.exitCode,
      stdout: output.stdout.toString(),
      stderr: output.stderr.toString(),
    })),
  )

const failed = (cwd: string, args: ReadonlyArray<string>, ran: Ran) =>
  new StateIo({
    path: cwd,
    cause: `git ${args.join(" ")} exited ${ran.code}: ${`${ran.stderr}\n${ran.stdout}`.trim().split("\n").slice(-10).join("\n")}`,
  })

/** Runs git and returns its trimmed output, failing with StateIo on a non-zero exit. */
const gitText = (cwd: string, env: Environment, args: ReadonlyArray<string>) =>
  git(cwd, env, args).pipe(
    Effect.flatMap((ran) =>
      ran.code === 0 ? Effect.succeed(ran.stdout.trim()) : Effect.fail(failed(cwd, args, ran)),
    ),
  )

/** True when git exits 0 for the arguments. */
const gitSucceeds = (cwd: string, env: Environment, args: ReadonlyArray<string>) =>
  git(cwd, env, args).pipe(Effect.map((ran) => ran.code === 0))

/**
 * State commits are bookkeeping: they skip the repository's hooks (which build, lint and check
 * messages for work commits) and signing, which would prompt or fail without a person.
 */
const BOOKKEEPING = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"] as const

const NOT_A_REPOSITORY = /not a git repository|command not found/i

const isDirectory = (path: string) =>
  io(path, () => stat(path)).pipe(
    Effect.map((info) => info.isDirectory()),
    Effect.catchIf(
      (error) => hasCode(error.cause, "ENOENT"),
      () => Effect.succeed(false),
    ),
  )

/**
 * The name of the state branch: git config `holyagent.stateBranch`, else `vcs.stateBranch` of the
 * work tree's `.holyagent/config.json`, else {@link DEFAULT_STATE_BRANCH}. A config file that does
 * not read counts as not naming one, so a typo there cannot stop every command.
 */
const stateBranch = (top: string, env: Environment) =>
  Effect.gen(function* () {
    const configured = yield* git(top, env, ["config", "--get", BRANCH_KEY])
    const fromGit = configured.code === 0 ? configured.stdout.trim() : ""
    const fromFile =
      fromGit === ""
        ? (yield* readSettings([join(top, STATE_DIRECTORY)]).pipe(
            Effect.orElseSucceed((): VcsSettings => ({})),
          )).stateBranch
        : undefined
    const branch = fromGit !== "" ? fromGit : (fromFile ?? DEFAULT_STATE_BRANCH)
    const valid =
      !branch.startsWith("-") &&
      (yield* gitSucceeds(top, env, ["check-ref-format", `refs/heads/${branch}`]))
    if (!valid)
      return yield* new StateIo({
        path: top,
        cause: `"${branch}" is not a branch name; set ${BRANCH_KEY} or vcs.stateBranch in .holyagent/config.json to one`,
      })
    return branch
  })

interface Listed {
  readonly path: string
  readonly branch: string | undefined
  readonly prunable: boolean
}

const listWorktrees = (cwd: string, env: Environment) =>
  gitText(cwd, env, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map((text) =>
      text
        .split("\n\n")
        .map((block) => block.split("\n"))
        .map((lines): Listed => {
          const field = (name: string) =>
            lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1)
          return {
            path: field("worktree") ?? "",
            branch: field("branch"),
            prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
          }
        })
        .filter((entry) => entry.path !== ""),
    ),
  )

/** The listed worktree that has the branch checked out, when its folder is still there. */
const checkedOut = (listed: ReadonlyArray<Listed>, branch: string) =>
  Effect.gen(function* () {
    for (const entry of listed)
      if (
        entry.branch === `refs/heads/${branch}` &&
        !entry.prunable &&
        (yield* isDirectory(entry.path))
      )
        return entry.path
    return undefined
  })

const refExists = (cwd: string, env: Environment, ref: string) =>
  gitSucceeds(cwd, env, ["show-ref", "--verify", "--quiet", ref])

const NEUTRAL_IDENTITY = {
  GIT_AUTHOR_NAME: "holyagent",
  GIT_AUTHOR_EMAIL: "holyagent@localhost",
  GIT_COMMITTER_NAME: "holyagent",
  GIT_COMMITTER_EMAIL: "holyagent@localhost",
}

/**
 * The environment for a state commit: the one given, with a neutral identity on top when git knows
 * no identity for the repository or the one it knows is an agent's, which never authors a commit.
 */
const committing = (cwd: string, env: Environment) =>
  git(cwd, env, ["var", "GIT_COMMITTER_IDENT"]).pipe(
    Effect.map((ran): Environment => {
      const ident = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(ran.stdout.trim())
      return ran.code === 0 &&
        ident !== null &&
        !looksLikeAgent({ name: ident[1] ?? "", email: ident[2] ?? "" })
        ? env
        : { ...env, ...NEUTRAL_IDENTITY }
    }),
  )

/**
 * Where a new state branch starts when no remote copy exists: the head of the base branch (the one
 * `origin/HEAD` names, else `main`, else `master`; a local branch before its remote copy), else the
 * current commit, else a new empty commit for a repository that has none.
 */
const baseStart = (top: string, env: Environment) =>
  Effect.gen(function* () {
    const head = yield* git(top, env, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])
    const named = head.code === 0 ? head.stdout.trim().replace("refs/remotes/origin/", "") : ""
    for (const name of [named, "main", "master"]) {
      if (name === "") continue
      if (yield* refExists(top, env, `refs/heads/${name}`)) return `refs/heads/${name}`
      if (yield* refExists(top, env, `refs/remotes/origin/${name}`))
        return `refs/remotes/origin/${name}`
    }
    const current = yield* git(top, env, ["rev-parse", "--verify", "-q", "HEAD"])
    if (current.code === 0) return current.stdout.trim()
    const tree = yield* gitText(top, env, ["hash-object", "-t", "tree", "-w", "/dev/null"])
    return yield* gitText(top, yield* committing(top, env), [
      "commit-tree",
      "-m",
      "chore(state): start the state branch",
      tree,
    ])
  })

/**
 * True when the clone keeps state: a state branch, its remote copy or a state folder in any of its
 * work trees.
 */
const keepsState = (top: string, env: Environment, branch: string, listed: ReadonlyArray<Listed>) =>
  Effect.gen(function* () {
    if (
      (yield* refExists(top, env, `refs/heads/${branch}`)) ||
      (yield* refExists(top, env, `refs/remotes/origin/${branch}`))
    )
      return true
    for (const entry of [top, ...listed.filter((tree) => !tree.prunable).map((tree) => tree.path)])
      if (yield* isDirectory(join(entry, STATE_DIRECTORY))) return true
    return false
  })

/**
 * Makes the state worktree at `path` for the branch: from the local branch when it exists, else
 * from its remote copy `origin/<branch>`, else from the base branch head. Under a lock, so two
 * commands starting at once make it once.
 */
const createWorktree = (
  top: string,
  common: string,
  env: Environment,
  branch: string,
  path: string,
) =>
  withFileLock(
    join(common, "holyagent", "worktree.lock"),
    Effect.gen(function* () {
      const again = yield* checkedOut(yield* listWorktrees(top, env), branch)
      if (again !== undefined) return again
      yield* git(top, env, ["worktree", "prune"])
      // The folder is ours (under the git directory) and not registered, so a leftover is removed.
      yield* io(path, () => rm(path, { recursive: true, force: true }))
      yield* io(path, () => mkdir(dirname(path), { recursive: true }))
      const add = [...BOOKKEEPING, "worktree", "add", "-q"]
      if (yield* refExists(top, env, `refs/heads/${branch}`))
        yield* gitText(top, env, [...add, path, branch])
      else if (yield* refExists(top, env, `refs/remotes/origin/${branch}`))
        yield* gitText(top, env, [...add, "--track", "-b", branch, path, `origin/${branch}`])
      else
        yield* gitText(top, env, [
          ...add,
          "--no-track",
          "-b",
          branch,
          path,
          yield* baseStart(top, env),
        ])
      return path
    }),
  )

interface Entry {
  /** The path relative to the state folder. */
  readonly path: string
  /** Its two-letter `git status --porcelain` code in the work tree; absent for a clean file. */
  readonly status: string | undefined
}

/** The per-clone files that move with the state: what the CLI keeps in `local/`. */
const LOCAL_FILES: ReadonlySet<string> = new Set([
  "local/active-intent.json",
  "local/specialists.json",
  "local/vcs.json",
])

const sameBytes = (a: string, b: string) =>
  Effect.all([io(a, () => Bun.file(a).bytes()), io(b, () => Bun.file(b).bytes())]).pipe(
    Effect.map(([left, right]) => Buffer.from(left).equals(Buffer.from(right))),
  )

const fileExists = (path: string) => io(path, () => Bun.file(path).exists())

/** The files under a work tree's state folder, each with its git status when it is not clean. */
const workTreeEntries = (top: string, env: Environment) =>
  Effect.gen(function* () {
    const folder = join(top, STATE_DIRECTORY)
    if (!(yield* isDirectory(folder))) return [] as ReadonlyArray<Entry>
    const files = yield* io(folder, () =>
      Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: folder, dot: true, onlyFiles: true })),
    )
    const status = new Map<string, string>()
    const listing = yield* git(top, env, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      STATE_DIRECTORY,
    ])
    const parts = listing.stdout.split("\0")
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index] ?? ""
      if (part.length < 4) continue
      const code = part.slice(0, 2)
      status.set(part.slice(3 + STATE_DIRECTORY.length + 1), code)
      // A rename or copy lists its origin as a further entry.
      if (code.includes("R") || code.includes("C")) index++
    }
    return files
      .filter((path) => !path.startsWith("local/") || LOCAL_FILES.has(path))
      .toSorted()
      .map((path): Entry => ({ path, status: status.get(path) }))
  })

/** Removes the folders a cleanup emptied, from the file's folder up to the state folder. */
const pruneEmpty = (folder: string, from: string) =>
  Effect.gen(function* () {
    let current = from
    while (current.startsWith(`${folder}/`)) {
      const names = yield* io(current, () => readdir(current)).pipe(
        Effect.orElseSucceed(() => ["still here"]),
      )
      if (names.length > 0) return
      yield* io(current, () => rmdir(current)).pipe(Effect.ignore)
      current = dirname(current)
    }
  })

const migrationMarker = (common: string, top: string) =>
  io(top, () => realpath(top)).pipe(
    Effect.map((real) =>
      join(
        common,
        "holyagent",
        "migrated",
        new Bun.CryptoHasher("sha1").update(real).digest("hex").slice(0, 16),
      ),
    ),
  )

/**
 * Moves the state found in a work tree into the state worktree, once per work tree. A file the
 * state worktree lacks is copied; one it has is replaced only by a work-tree file that is
 * uncommitted, since an uncommitted edit is newer than any commit and a committed copy may be an
 * older one than the state branch holds. Copies are committed on the state branch, and then the
 * uncommitted originals are removed from the work tree (untracked ones deleted, modified ones
 * restored), so the work tree is left without uncommitted state. The per-clone files are copied
 * only when the state worktree has none.
 */
const migrateWorkTree = (
  top: string,
  common: string,
  worktree: string,
  env: Environment,
  commit: (message: string) => Effect.Effect<boolean, StateIo>,
) => {
  const source = join(top, STATE_DIRECTORY)
  const target = join(worktree, STATE_DIRECTORY)
  return migrationMarker(common, top).pipe(
    Effect.flatMap((marker) =>
      fileExists(marker).pipe(
        Effect.flatMap((done) =>
          done
            ? Effect.void
            : withStateLock(
                target,
                Effect.gen(function* () {
                  if (yield* fileExists(marker)) return
                  const entries = yield* workTreeEntries(top, env)
                  const moved: Array<Entry> = []
                  for (const entry of entries) {
                    const to = join(target, entry.path)
                    const dirty = entry.status !== undefined && !entry.status.includes("D")
                    const there = yield* fileExists(to)
                    const wanted =
                      !there || (dirty && !(yield* sameBytes(join(source, entry.path), to)))
                    if (wanted)
                      yield* io(to, () => Bun.write(to, Bun.file(join(source, entry.path))))
                    if (dirty && !entry.path.startsWith("local/")) moved.push(entry)
                  }
                  yield* commit("chore(state): migrate the state found in a work tree")
                  // Only what the state worktree now holds byte for byte leaves the work tree.
                  for (const entry of moved) {
                    const from = join(source, entry.path)
                    if (!(yield* sameBytes(from, join(target, entry.path)))) continue
                    const status = entry.status ?? ""
                    if (status === "??") yield* io(from, () => rm(from, { force: true }))
                    else if (status.startsWith("A"))
                      yield* gitText(top, env, [
                        "rm",
                        "-f",
                        "-q",
                        "--",
                        `${STATE_DIRECTORY}/${entry.path}`,
                      ])
                    else
                      yield* gitText(top, env, [
                        "--literal-pathspecs",
                        "restore",
                        "--source=HEAD",
                        "--staged",
                        "--worktree",
                        "--",
                        `${STATE_DIRECTORY}/${entry.path}`,
                      ])
                    yield* pruneEmpty(source, dirname(from))
                  }
                  // The folder goes too when only its emptied husk is left; one with `local/` stays.
                  yield* io(source, () => rmdir(source)).pipe(Effect.ignore)
                  yield* io(marker, () => Bun.write(marker, ""))
                }),
              ),
        ),
      ),
    ),
  )
}

/**
 * Commits what changed under `.holyagent/` of the state worktree on the state branch, with the
 * identity git has for the repository, and returns whether a commit was made. Nothing happens when
 * the folder is not the state worktree (outside git, or in a worktree on another branch), or when
 * nothing changed. Call it under the state lock.
 */
export const commitState = (directory: string, env: Environment, message: string) =>
  Effect.gen(function* () {
    const worktree = dirname(directory)
    if (!(yield* isDirectory(worktree))) return false
    const top = yield* git(worktree, env, ["rev-parse", "--show-toplevel"])
    if (top.code !== 0) return false
    const own = yield* Effect.all([
      io(worktree, () => realpath(worktree)),
      io(worktree, () => realpath(top.stdout.trim())),
    ]).pipe(Effect.map(([a, b]) => a === b))
    if (!own) return false
    // The state worktree is the one made under the git directory; one the user checked out the
    // state branch in elsewhere is recognised by its branch.
    const common = yield* gitText(worktree, env, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
    const inside = (yield* io(worktree, () => realpath(worktree))).startsWith(
      `${yield* io(common, () => realpath(common))}/holyagent/`,
    )
    const current = yield* git(worktree, env, ["symbolic-ref", "--short", "-q", "HEAD"])
    if (
      !inside &&
      (current.code !== 0 || current.stdout.trim() !== (yield* stateBranch(worktree, env)))
    )
      return false
    yield* gitText(worktree, env, ["add", "-A", "--", STATE_DIRECTORY])
    if (yield* gitSucceeds(worktree, env, ["diff", "--cached", "--quiet", "--", STATE_DIRECTORY]))
      return false
    yield* gitText(worktree, yield* committing(worktree, env), [
      ...BOOKKEEPING,
      "commit",
      "-q",
      "--no-verify",
      "-m",
      message,
      "--",
      STATE_DIRECTORY,
    ])
    return true
  })

/**
 * Finds the state a command works on. Inside a repository that is the `.holyagent` folder of the
 * state worktree, the same from the main checkout and from any linked worktree on any branch; it is
 * made (see {@link Ensure}) from `origin/<branch>` when that exists, else from the base branch
 * head, and the state found in a work tree is moved into it once. Outside a repository, or without
 * git, the state is the `.holyagent` folder of the working directory. Any other git failure is
 * reported, so state is not silently written somewhere else.
 */
export const resolveState = (cwd: string, env: Environment, ensure: Ensure) =>
  Effect.gen(function* () {
    const located = yield* git(cwd, env, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ])
    if (located.code !== 0) {
      const complaint = located.stderr.trim()
      if (NOT_A_REPOSITORY.test(complaint))
        return { root: cwd, directory: join(cwd, STATE_DIRECTORY) } satisfies StateTree
      return yield* new StateIo({ path: cwd, cause: `git: ${complaint}` })
    }
    const [top = cwd, common = join(cwd, ".git")] = located.stdout.trim().split("\n")
    const branch = yield* stateBranch(top, env)
    const listed = yield* listWorktrees(top, env)
    const found = yield* checkedOut(listed, branch)
    const standard = join(common, "holyagent", branch.replace(/[^\w.-]+/g, "-"))
    if (found === undefined) {
      const make =
        ensure === "create" ||
        (ensure === "ifPresent" && (yield* keepsState(top, env, branch, listed)))
      if (!make)
        return { root: top, directory: join(standard, STATE_DIRECTORY) } satisfies StateTree
    }
    const worktree = found ?? (yield* createWorktree(top, common, env, branch, standard))
    const directory = join(worktree, STATE_DIRECTORY)
    if (ensure !== "peek") {
      // A new state worktree takes in the state of every work tree of the clone, not just this one.
      const sources =
        found === undefined
          ? [top, ...listed.filter((entry) => !entry.prunable).map((entry) => entry.path)]
          : [top]
      for (const source of new Set(sources))
        if (source !== worktree && (yield* isDirectory(source)))
          yield* migrateWorkTree(source, common, worktree, env, (message) =>
            commitState(directory, env, message),
          )
    }
    return { root: top, directory } satisfies StateTree
  })
