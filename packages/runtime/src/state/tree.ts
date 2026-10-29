import { lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises"
import { basename, dirname, join, sep } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import { fromGitPath, toPosix } from "../domain/paths.ts"
import { looksLikeAgent } from "../vcs/identity.ts"
import { StateIo, StateModeRefused } from "./errors.ts"
import { commitFile, hasCode, io, readText } from "./files.ts"
import { CONFIG_FILE, STATE_DIRECTORY, TRACKED_STATE_PATHSPEC } from "./layout.ts"
import { withFileLock, withStateLock } from "./lock.ts"
import { parseStateMode, STATE_MODE_KEY, type StateMode } from "./mode.ts"

// In the default `branch` mode the Intent state lives on one branch of its own, checked out in one
// linked worktree that every worktree of the clone shares. Work branches never carry `.holyagent/`,
// and the state branch carries nothing else, so merging either into the other, or into a branch
// stacked on it, cannot conflict. Every state transition is committed on the state branch,
// locally: pushing is the root's, with plain git. The `work` and `local` modes (git config
// `holyagent.stateMode`, see mode.ts) keep the state in the `.holyagent/` of the work tree instead,
// for a project whose PRs do not stack: `work` commits it with the work, `local` keeps it out of git.

/** The branch that holds the Intent state unless git config names another. */
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

/** The mode of the clone: git config `holyagent.stateMode`, else `branch`. */
const stateModeOf = (top: string, env: Environment) =>
  git(top, env, ["config", "--get", STATE_MODE_KEY]).pipe(
    Effect.flatMap((ran) => parseStateMode(ran.code === 0 ? ran.stdout : undefined)),
  )

/** The line in `.git/info/exclude` that keeps the state folder out of git in `local` mode. */
const EXCLUDE_LINE = `/${STATE_DIRECTORY}/`

/** The comment above the line holyagent adds, which lets it remove only what it put there. */
const EXCLUDE_MARK = "# added by holyagent (state mode local)"

// Git strips one trailing carriage return and then trailing spaces from an exclude line, and keeps
// everything else as part of the pattern: " /.holyagent/" (leading space) and "/.holyagent/\t"
// (trailing tab) are other patterns that hide nothing, so exactly those two are removed here.
const gitPattern = (line: string) => line.replace(/\r$/, "").replace(/ +$/, "")
const isMark = (line: string) => gitPattern(line) === EXCLUDE_MARK
const isEntry = (line: string) => gitPattern(line) === EXCLUDE_LINE

/** True when the exclude line is there, with or without the comment above it. */
const hasEntry = (lines: ReadonlyArray<string>) => lines.some(isEntry)

/**
 * The lines with holyagent's entry in place: nothing changes when the marked pair or a line the
 * user wrote is there, a marker comment whose line was deleted gets the line back, and otherwise a
 * new marked pair is appended.
 */
const withEntry = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (hasEntry(lines)) return lines
  const orphan = lines.findIndex(isMark)
  return orphan >= 0
    ? [...lines.slice(0, orphan + 1), EXCLUDE_LINE, ...lines.slice(orphan + 1)]
    : [...lines, EXCLUDE_MARK, EXCLUDE_LINE]
}

/** The lines without any marker comment of ours or the exclude line directly below it. */
const withoutMarked = (lines: ReadonlyArray<string>) =>
  lines.filter((line, index) => {
    if (isMark(line)) return false
    return !(isEntry(line) && isMark(lines[index - 1] ?? ""))
  })

/** The clone's exclude file; git resolves a symbolic link at it, so a rename replaces its target. */
const excludePath = (top: string, env: Environment) =>
  gitText(top, env, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).pipe(
    Effect.map((path) => fromGitPath(path)),
  )

/** The lines of a file; the empty file and the missing one have none. */
const linesOf = (text: string | undefined) =>
  text === undefined || text === "" ? [] : text.replace(/\n$/, "").split("\n")

/**
 * Edits the clone's `.git/info/exclude`, which every work tree of the clone shares, under the
 * clone's exclude lock so two commands never lose each other's change. `edit` receives the lines
 * and returns the new ones (or the same to leave the file) and a result. It is the clone's own
 * ignore file, so the repository's `.gitignore` is never touched and no PR carries the entry. The
 * file is replaced through a temporary file and a rename (removed again when either fails), so a
 * concurrent `git add` never reads it half written. The lock is waited for as long as the worktree
 * lock, since a holder that died leaves it until it is found stale. When `done` holds for the lines
 * read before the lock, the lock is not taken.
 */
const editExclude = <E, R>(
  top: string,
  common: string,
  env: Environment,
  edit: (lines: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, E, R>,
  done?: (lines: ReadonlyArray<string>) => boolean,
) =>
  Effect.gen(function* () {
    const path = yield* excludePath(top, env)
    if (done?.(linesOf(yield* readText(path))) === true) return
    yield* withFileLock(
      join(common, "holyagent", "exclude.lock"),
      Effect.gen(function* () {
        const before = linesOf(yield* readText(path))
        const lines = yield* edit(before)
        if (lines.join("\n") === before.join("\n")) return
        const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`
        yield* commitFile(path, body)
      }),
      "long",
    )
  })

/**
 * Puts the state folder in the clone's exclude file when a command resolves the `local` state,
 * unless the clone has left `local` since the command read its mode: the mode is read again under
 * the lock, so a command that waited cannot bring the entry back after a mode change removed it.
 */
const ensureExcluded = (top: string, common: string, env: Environment) =>
  editExclude(
    top,
    common,
    env,
    (lines) =>
      stateModeOf(top, env).pipe(
        Effect.map((mode) => (mode === "local" ? withEntry(lines) : lines)),
      ),
    hasEntry,
  )

/**
 * Puts the state folder in the clone's exclude file as the clone enters `local`, before the mode is
 * written. A line the user already had stays theirs and is never removed.
 */
const excludeState = (top: string, common: string, env: Environment) =>
  editExclude(top, common, env, (lines) => Effect.succeed(withEntry(lines)))

/**
 * Takes the state folder out of the clone's exclude file as the clone leaves `local`. Only what
 * holyagent added goes: the marked pair, and a stray marker comment. An unmarked line is the
 * user's, whenever it was written, since nothing proves that holyagent wrote it.
 */
const unexcludeState = (top: string, common: string, env: Environment) =>
  editExclude(top, common, env, (lines) => Effect.succeed(withoutMarked(lines)))

const isDirectory = (path: string) =>
  io(path, () => stat(path)).pipe(
    Effect.map((info) => info.isDirectory()),
    Effect.catchIf(
      (error) => hasCode(error.cause, "ENOENT"),
      () => Effect.succeed(false),
    ),
  )

/**
 * The name of the state branch: git config `holyagent.stateBranch`, else
 * {@link DEFAULT_STATE_BRANCH}. Only git config names it: the files of the repository are content
 * another person may have written, and a branch they name would be one the commands commit on.
 */
const stateBranch = (top: string, env: Environment) =>
  Effect.gen(function* () {
    const configured = yield* git(top, env, ["config", "--get", BRANCH_KEY])
    const fromGit = configured.code === 0 ? configured.stdout.trim() : ""
    const branch = fromGit !== "" ? fromGit : DEFAULT_STATE_BRANCH
    const valid =
      !branch.startsWith("-") &&
      (yield* gitSucceeds(top, env, ["check-ref-format", `refs/heads/${branch}`]))
    if (!valid)
      return yield* new StateIo({
        path: top,
        cause: `"${branch}" is not a branch name; set ${BRANCH_KEY} in git config to one`,
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
            path: fromGitPath(field("worktree") ?? ""),
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
 * Where a new state branch starts when no remote copy exists: the head of the repository's base
 * branch, so that merging the state branch into the base takes in nothing but state. The base is
 * the branch `origin/HEAD` names, else `init.defaultBranch`, else `main`, else `master`; a local
 * branch before its remote copy. Without any of them (no commit yet, or a base this cannot tell)
 * there is no start and the state branch is not made: the current commit is a feature's, and an
 * empty root would share no history with the base.
 */
const baseStart = (top: string, env: Environment) =>
  Effect.gen(function* () {
    const head = yield* git(top, env, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])
    const named = head.code === 0 ? head.stdout.trim().replace("refs/remotes/origin/", "") : ""
    const initial = yield* git(top, env, ["config", "--get", "init.defaultBranch"])
    const configured = initial.code === 0 ? initial.stdout.trim() : ""
    for (const name of [named, configured, "main", "master"]) {
      if (name === "") continue
      if (yield* refExists(top, env, `refs/heads/${name}`)) return `refs/heads/${name}`
      if (yield* refExists(top, env, `refs/remotes/origin/${name}`))
        return `refs/remotes/origin/${name}`
    }
    return undefined
  })

/**
 * True when the `.holyagent` folder of the work tree at `top` or of any listed work tree holds
 * anything besides the project's config.
 */
const holdsRecords = (top: string, listed: ReadonlyArray<Listed>) =>
  Effect.gen(function* () {
    for (const entry of [
      top,
      ...listed.filter((tree) => !tree.prunable).map((tree) => tree.path),
    ]) {
      const folder = join(entry, STATE_DIRECTORY)
      if (!(yield* isDirectory(folder))) continue
      const names = yield* io(folder, () => readdir(folder))
      if (names.some((name) => name !== CONFIG_FILE)) return true
    }
    return false
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
    return yield* holdsRecords(top, listed)
  })

/** The folder of a branch's state worktree: the branch name as a readable slug and a hash of it. */
const worktreeFolder = (branch: string) =>
  `${branch.replace(/[^\w.-]+/g, "-").slice(0, 40)}-${new Bun.CryptoHasher("sha1").update(branch).digest("hex").slice(0, 10)}`

const canonical = (path: string) =>
  io(path, () => realpath(path)).pipe(Effect.orElseSucceed(() => path))

const samePath = (a: string, b: string) =>
  Effect.all([canonical(a), canonical(b)]).pipe(Effect.map(([left, right]) => left === right))

/**
 * Fails when a work tree of the clone is checked out at `path`, whatever its branch: the folder is
 * then not a leftover to delete, and its contents are not the state of `branch`.
 */
const requireFree = (listed: ReadonlyArray<Listed>, path: string, branch: string) =>
  Effect.gen(function* () {
    for (const entry of listed) {
      if (entry.prunable || !(yield* isDirectory(entry.path))) continue
      if (!(yield* samePath(entry.path, path))) continue
      const on =
        entry.branch === undefined ? "a detached head" : entry.branch.replace("refs/heads/", "")
      return yield* new StateIo({
        path,
        cause: `this work tree is registered with git but is on ${on}, not on ${branch}; switch it back with \`git -C ${path} switch ${branch}\` or remove it with \`git worktree remove\``,
      })
    }
  })

/** The file whose presence says the state worktree at `path` is fully checked out. */
const readyMarker = (path: string) => `${path}.ready`

/** What {@link ensureWorktree} found or made. */
type Ensured =
  | { readonly kind: "ready"; readonly path: string; readonly created: boolean }
  | { readonly kind: "absent" }
  | { readonly kind: "deferred" }

/**
 * Finds or makes the state worktree at `path`, under the worktree lock, which every command that
 * finds it unfinished waits on: a worktree git has registered may still be checking out its files.
 * A new one is made from the local branch when it exists, else from its remote copy
 * `origin/<branch>`, else from the base branch head; with none of them it is `deferred` until the
 * base has a commit. With `make` false a missing worktree is `absent`. A finished worktree gets a
 * marker next to it, so that later commands pass without the lock.
 */
const ensureWorktree = (
  top: string,
  common: string,
  env: Environment,
  branch: string,
  path: string,
  options: { readonly make: boolean; readonly peek: boolean },
) =>
  withFileLock(
    join(common, "holyagent", "worktree.lock"),
    Effect.gen(function* () {
      const ready = readyMarker(path)
      const again = yield* checkedOut(yield* listWorktrees(top, env), branch)
      if (again !== undefined) {
        if (!options.peek && (yield* samePath(again, path)) && !(yield* fileExists(ready)))
          yield* io(ready, () => Bun.write(ready, ""))
        return { kind: "ready", path: again, created: false } satisfies Ensured
      }
      if (!options.make) return { kind: "absent" } satisfies Ensured
      // A mode change made while this command waited for the lock leaves no state branch to make.
      if ((yield* stateModeOf(top, env)) !== "branch") return { kind: "deferred" } satisfies Ensured
      yield* git(top, env, ["worktree", "prune"])
      yield* requireFree(yield* listWorktrees(top, env), path, branch)
      const add = [...BOOKKEEPING, "worktree", "add", "-q"]
      const local = yield* refExists(top, env, `refs/heads/${branch}`)
      const remote = yield* refExists(top, env, `refs/remotes/origin/${branch}`)
      const start = local || remote ? undefined : yield* baseStart(top, env)
      const target = local
        ? [path, branch]
        : remote
          ? ["--track", "-b", branch, path, `origin/${branch}`]
          : start === undefined
            ? undefined
            : ["--no-track", "-b", branch, path, start]
      if (target === undefined) return { kind: "deferred" } satisfies Ensured
      // The folder is ours (under the git directory) and no work tree is registered at it, so what
      // is there is a leftover.
      yield* io(ready, () => rm(ready, { force: true }))
      yield* io(path, () => rm(path, { recursive: true, force: true }))
      yield* io(path, () => mkdir(dirname(path), { recursive: true }))
      yield* gitText(top, env, [...add, ...target])
      yield* io(ready, () => Bun.write(ready, ""))
      return { kind: "ready", path, created: true } satisfies Ensured
    }),
    "long",
  )

interface Entry {
  /** The path relative to the state folder. */
  readonly path: string
  /** Its two-letter `git status --porcelain` code in the work tree; absent for a clean file. */
  readonly status: string | undefined
}

/** The per-clone files that move with the state: what the CLI keeps in `local/`. */
const LOCAL_FILES: ReadonlySet<string> = new Set(["local/specialists.json", "local/vcs.json"])

const sameBytes = (a: string, b: string) =>
  Effect.all([io(a, () => Bun.file(a).bytes()), io(b, () => Bun.file(b).bytes())]).pipe(
    Effect.map(([left, right]) => Buffer.from(left).equals(Buffer.from(right))),
  )

const fileExists = (path: string) => io(path, () => Bun.file(path).exists())

/** What is at a path without following a link: its type, or undefined when nothing is there. */
const kindAt = (path: string) =>
  io(path, () => lstat(path)).pipe(
    Effect.map((info) =>
      info.isSymbolicLink()
        ? "link"
        : info.isFile()
          ? "file"
          : info.isDirectory()
            ? "directory"
            : "other",
    ),
    Effect.catchIf(
      (error) => hasCode(error.cause, "ENOENT") || hasCode(error.cause, "ENOTDIR"),
      () => Effect.succeed(undefined),
    ),
  )

/**
 * The `.holyagent` folder at `root` reached through the real path of its work tree only. The folder
 * itself is left unresolved, so a link standing for it never counts as being inside itself.
 */
const realStateFolder = (root: string) =>
  canonical(dirname(root)).pipe(Effect.map((parent) => join(parent, basename(root))))

/**
 * Fails when the `.holyagent` folder at `root` is there as anything but a real folder: a link in
 * its place would send every read and write somewhere else. An absent folder passes.
 */
const requireStateFolder = (root: string) =>
  kindAt(root).pipe(
    Effect.flatMap((kind) =>
      kind === undefined || kind === "directory"
        ? Effect.void
        : Effect.fail(
            new StateIo({
              path: root,
              cause: `a ${kind} stands where the state folder is to be; the state worktree must hold a real folder, so remove it`,
            }),
          ),
    ),
  )

/**
 * True when `relative` under the state folder `root` is a regular file reached through no link: a
 * link, a device, a socket or a link in the path is not state, and following it would read or write
 * elsewhere. The state folder itself must be a real folder inside the real path of its work tree.
 */
const isPlainFile = (root: string, relative: string) =>
  Effect.gen(function* () {
    const path = join(root, relative)
    if ((yield* kindAt(root)) !== "directory" || (yield* kindAt(path)) !== "file") return false
    const [real, base] = yield* Effect.all([canonical(path), realStateFolder(root)])
    return real === join(base, relative)
  })

/**
 * Fails when `root`, the state folder, or something in the path from it down to `relative` (the
 * last part included) is already there as anything but a folder, or a file for the last part: a
 * link in the state worktree would send a write outside it.
 */
const requirePlainTarget = (root: string, relative: string) =>
  Effect.gen(function* () {
    yield* requireStateFolder(root)
    const parts = relative.split("/")
    let current = root
    for (const [index, part] of parts.entries()) {
      current = join(current, part)
      const kind = yield* kindAt(current)
      if (kind === undefined) return
      if (kind !== (index === parts.length - 1 ? "file" : "directory"))
        return yield* new StateIo({
          path: current,
          cause: `a ${kind} stands where state is to be written; the state worktree must hold only plain files and folders, so remove it`,
        })
    }
  })

/**
 * Copies a plain file into the state worktree through a temporary neighbour and a rename, after
 * checking that the folders it lands in are plain folders inside the worktree. The rename never
 * follows a link at the destination.
 */
const copyInto = (root: string, relative: string, from: string) =>
  Effect.gen(function* () {
    yield* requirePlainTarget(root, relative)
    const to = join(root, relative)
    yield* io(to, () => mkdir(dirname(to), { recursive: true }))
    const [folder, base] = yield* Effect.all([canonical(dirname(to)), realStateFolder(root)])
    if (folder !== base && !folder.startsWith(`${base}${sep}`))
      return yield* new StateIo({ path: to, cause: `${folder} is outside the state worktree` })
    const temporary = `${to}.${process.pid}.${crypto.randomUUID()}.tmp`
    yield* io(to, () => Bun.write(temporary, Bun.file(from))).pipe(
      Effect.andThen(io(to, () => rename(temporary, to))),
      Effect.tapError(() =>
        io(temporary, () => rm(temporary, { force: true })).pipe(Effect.ignore),
      ),
    )
  })

/** The files under a work tree's state folder, each with its git status when it is not clean. */
const workTreeEntries = (top: string, env: Environment) =>
  Effect.gen(function* () {
    const folder = join(top, STATE_DIRECTORY)
    if (!(yield* isDirectory(folder))) return [] as ReadonlyArray<Entry>
    const files = yield* io(folder, () =>
      Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: folder, dot: true, onlyFiles: true })),
    ).pipe(Effect.map((paths) => paths.map((path) => toPosix(path))))
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
      .filter((path) => path !== CONFIG_FILE)
      .filter((path) => !path.startsWith("local/") || LOCAL_FILES.has(path))
      .toSorted()
      .map((path): Entry => ({ path, status: status.get(path) }))
  })

/** Removes the folders a cleanup emptied, from the file's folder up to the state folder. */
const pruneEmpty = (folder: string, from: string) =>
  Effect.gen(function* () {
    let current = from
    while (current.startsWith(`${folder}${sep}`)) {
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
            : // Checked before the lock, which writes under the target: a link or other non-folder
              // in place of either state folder is never read or written through. A work tree
              // whose folder is one has no state to move.
              requireStateFolder(target).pipe(
                Effect.andThen(kindAt(source)),
                Effect.flatMap((kind) =>
                  kind !== undefined && kind !== "directory"
                    ? Effect.void
                    : withStateLock(
                        target,
                        Effect.gen(function* () {
                          if (yield* fileExists(marker)) return
                          const entries = yield* workTreeEntries(top, env)
                          const moved: Array<Entry> = []
                          for (const entry of entries) {
                            // A link, device or socket in the work tree is not state.
                            if (!(yield* isPlainFile(source, entry.path))) continue
                            const to = join(target, entry.path)
                            yield* requirePlainTarget(target, entry.path)
                            const dirty = entry.status !== undefined && !entry.status.includes("D")
                            const there = (yield* kindAt(to)) !== undefined
                            const wanted =
                              !there || (dirty && !(yield* sameBytes(join(source, entry.path), to)))
                            if (wanted)
                              yield* copyInto(target, entry.path, join(source, entry.path))
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
      ),
    ),
  )
}

/**
 * Commits what changed under `.holyagent/` of the state worktree on the state branch, with the
 * identity git has for the repository, and returns whether a commit was made. Nothing happens in
 * the `work` and `local` modes (the work commit or nobody carries the state), when the folder is
 * not in a worktree on the state branch (outside git, or on another branch), or when nothing
 * changed. Call it under the state lock.
 */
export const commitState = (directory: string, env: Environment, message: string) =>
  Effect.gen(function* () {
    const worktree = dirname(directory)
    if (!(yield* isDirectory(worktree))) return false
    const top = yield* git(worktree, env, ["rev-parse", "--show-toplevel"])
    if (top.code !== 0) return false
    const own = yield* Effect.all([
      io(worktree, () => realpath(worktree)),
      io(worktree, () => realpath(fromGitPath(top.stdout.trim()))),
    ]).pipe(Effect.map(([a, b]) => a === b))
    if (!own) return false
    if ((yield* stateModeOf(worktree, env)) !== "branch") return false
    // Only a worktree on the state branch takes the commit, wherever it is: the one under the git
    // directory can have been switched, and a commit there would land on the wrong branch.
    const current = yield* git(worktree, env, ["symbolic-ref", "--short", "-q", "HEAD"])
    if (current.code !== 0 || current.stdout.trim() !== (yield* stateBranch(worktree, env)))
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

/** The top-level folder and git directory of the repository `cwd` is in; undefined outside one. */
const locate = (cwd: string, env: Environment) =>
  Effect.gen(function* () {
    const located = yield* git(cwd, env, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ])
    if (located.code !== 0) {
      const complaint = located.stderr.trim()
      if (NOT_A_REPOSITORY.test(complaint)) return undefined
      return yield* new StateIo({ path: cwd, cause: `git: ${complaint}` })
    }
    // Git prints `/`-separated paths even on Windows (`C:/repo`); the rest of this file compares
    // them with `join()` and `realpath()` results, so they are converted once, here.
    const [top = cwd, common = join(cwd, ".git")] = located.stdout
      .trim()
      .split("\n")
      .map((path) => fromGitPath(path))
    return { top, common }
  })

/**
 * Finds the state a command works on. Inside a repository in the default `branch` mode that is the
 * `.holyagent` folder of the state worktree, the same from the main checkout and from any linked
 * worktree on any branch; it is made (see {@link Ensure}) from `origin/<branch>` when that exists,
 * else from the base branch head, and the state found in a work tree is moved into it once. In the
 * `work` and `local` modes it is the `.holyagent` folder of the work tree (`local` also keeps it
 * out of git through the clone's exclude file). Outside a repository, without git, or while the
 * base branch has no commit to start from, the state is the `.holyagent` folder of the work tree,
 * and in `branch` mode moves into the state worktree as soon as that can be made. A worktree at the
 * state folder that is on another branch is reported, never used. Any other git failure is
 * reported, so state is not silently written somewhere else.
 */
export const resolveState = (cwd: string, env: Environment, ensure: Ensure) =>
  Effect.gen(function* () {
    const repository = yield* locate(cwd, env)
    if (repository === undefined)
      return { root: cwd, directory: join(cwd, STATE_DIRECTORY) } satisfies StateTree
    const { top, common } = repository
    const mode = yield* stateModeOf(top, env)
    if (mode !== "branch") {
      if (mode === "local" && ensure !== "peek") yield* ensureExcluded(top, common, env)
      return { root: top, directory: join(top, STATE_DIRECTORY) } satisfies StateTree
    }
    const branch = yield* stateBranch(top, env)
    const listed = yield* listWorktrees(top, env)
    const found = yield* checkedOut(listed, branch)
    const standard = join(common, "holyagent", worktreeFolder(branch))
    // A worktree git has registered may still be checking out: only one with its marker, or one
    // the user made elsewhere, is used without the lock. Otherwise the command waits for the
    // command that is making it, then finds it made.
    const settled =
      found !== undefined &&
      (!(yield* samePath(found, standard)) || (yield* fileExists(readyMarker(standard))))
    const make =
      ensure === "create" ||
      (ensure === "ifPresent" && (yield* keepsState(top, env, branch, listed)))
    const ensured: Ensured =
      found !== undefined && settled
        ? { kind: "ready", path: found, created: false }
        : found === undefined && !make
          ? { kind: "absent" }
          : yield* ensureWorktree(top, common, env, branch, standard, {
              make,
              peek: ensure === "peek",
            })
    if (ensured.kind === "deferred")
      return { root: top, directory: join(top, STATE_DIRECTORY) } satisfies StateTree
    if (ensured.kind === "absent") {
      yield* requireFree(listed, standard, branch)
      return { root: top, directory: join(standard, STATE_DIRECTORY) } satisfies StateTree
    }
    const worktree = ensured.path
    const directory = join(worktree, STATE_DIRECTORY)
    if (ensure !== "peek") {
      // A new state worktree takes in the state of every work tree of the clone, not just this one.
      // The state worktrees of other state branches are not work trees.
      const own = join(common, "holyagent")
      const sources = ensured.created
        ? [
            top,
            ...listed
              .filter((entry) => !entry.prunable && !entry.path.startsWith(`${own}${sep}`))
              .map((entry) => entry.path),
          ]
        : [top]
      for (const source of new Set(sources))
        if (source !== worktree && (yield* isDirectory(source)))
          yield* migrateWorkTree(source, common, worktree, env, (message) =>
            commitState(directory, env, message),
          )
    }
    return { root: top, directory } satisfies StateTree
  })

/** The state mode of a clone and where its state lives. */
export interface StateModeView {
  readonly mode: StateMode
  /** True when git config names the mode, false when it is the default. */
  readonly configured: boolean
  /** The `.holyagent` folder the commands use in this mode. */
  readonly directory: string
}

const requireRepository = (cwd: string, env: Environment) =>
  locate(cwd, env).pipe(
    Effect.flatMap((repository) =>
      repository === undefined
        ? Effect.fail(
            new StateIo({
              path: cwd,
              cause:
                "not a git repository; the state modes apply inside one, and outside it the state is the .holyagent folder of the project",
            }),
          )
        : Effect.succeed(repository),
    ),
  )

/** Reads the state mode of the clone `cwd` is in and the state folder it gives. */
export const readStateMode = (cwd: string, env: Environment) =>
  Effect.gen(function* () {
    const { top } = yield* requireRepository(cwd, env)
    const configured = yield* gitSucceeds(top, env, ["config", "--get", STATE_MODE_KEY])
    const mode = yield* stateModeOf(top, env)
    const { directory } = yield* resolveState(cwd, env, "peek")
    return { mode, configured, directory } satisfies StateModeView
  })

/**
 * The command that puts the clone's mode back to what it is now: the previous value when the clone
 * has its own, else no value at all, so a clone that chose none stays unconfigured.
 */
const modeRestore = (top: string, env: Environment, previous: StateMode) =>
  gitSucceeds(top, env, ["config", "--local", "--get", STATE_MODE_KEY]).pipe(
    Effect.map((configured) =>
      configured
        ? gitText(top, env, ["config", "--local", STATE_MODE_KEY, previous])
        : gitText(top, env, ["config", "--local", "--unset", STATE_MODE_KEY]),
    ),
  )

/**
 * Sets the state mode in the clone's git config, holding the worktree lock that creating the state
 * branch also holds, so a branch is not made between the checks and the write. The records are
 * never moved or deleted: a change away from `branch` is refused once the state branch exists, and
 * one onto it while any work tree's `.holyagent/` holds records, since the new mode would not look
 * where the records are; `local` is refused while git tracks state in `.holyagent/` (its config
 * file is settings), which an exclude entry cannot hide. Setting `local` adds the exclude entry
 * before the mode, so the records are never exposed to git, and any other mode removes it after.
 */
export const setStateMode = (cwd: string, env: Environment, mode: StateMode) =>
  Effect.gen(function* () {
    const { top, common } = yield* requireRepository(cwd, env)
    return yield* withFileLock(
      join(common, "holyagent", "worktree.lock"),
      Effect.gen(function* () {
        const previous = yield* stateModeOf(top, env)
        if (previous === "branch" && mode !== "branch") {
          const branch = yield* stateBranch(top, env)
          if (
            (yield* refExists(top, env, `refs/heads/${branch}`)) ||
            (yield* refExists(top, env, `refs/remotes/origin/${branch}`))
          )
            return yield* new StateModeRefused({
              reason: `this clone already has the ${branch} branch, and its records are not moved into the work tree`,
            })
        }
        if (
          previous !== "branch" &&
          mode === "branch" &&
          (yield* holdsRecords(top, yield* listWorktrees(top, env)))
        )
          return yield* new StateModeRefused({
            reason: `${STATE_DIRECTORY}/ of a work tree already holds records, and they are not moved onto the state branch`,
          })
        if (
          mode === "local" &&
          (yield* gitText(top, env, ["ls-files", "--", ...TRACKED_STATE_PATHSPEC])) !== ""
        )
          return yield* new StateModeRefused({
            reason: `the repository tracks state in ${STATE_DIRECTORY}/, which an exclude entry cannot hide; choose the mode with holyagent state mode, and see docs/usage.md for what each one does to a repository you do not control`,
          })
        if (mode === "local") yield* excludeState(top, common, env)
        // Leaving local removes the entry after the mode write, so a failure there must put the
        // mode back; the way back is read before the write, and only where it can be needed.
        const restoreMode = mode === "local" ? undefined : yield* modeRestore(top, env, previous)
        yield* gitText(top, env, ["config", "--local", STATE_MODE_KEY, mode]).pipe(
          Effect.tapError(() =>
            mode === "local" && previous !== "local"
              ? unexcludeState(top, common, env).pipe(Effect.ignore)
              : Effect.void,
          ),
        )
        if (restoreMode !== undefined)
          yield* unexcludeState(top, common, env).pipe(
            Effect.catch((error) =>
              restoreMode.pipe(
                Effect.matchEffect({
                  onSuccess: () => Effect.fail(error),
                  onFailure: (restoreError) =>
                    Effect.fail(
                      new StateIo({
                        path: top,
                        cause: `${error.message}; the mode could not be put back to ${previous} either (${restoreError.message}); set git config ${STATE_MODE_KEY} by hand`,
                      }),
                    ),
                }),
              ),
            ),
          )
        return { previous, mode }
      }),
      "long",
    )
  })
