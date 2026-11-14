import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"

import { Effect, type Exit } from "effect"

import { fromGitPath, toPosix } from "../domain/paths.ts"
import { StateIo, type StateLocked, StateModeRefused } from "./errors.ts"
import { commitFile, hasCode, io, readText } from "./files.ts"
import { CONFIG_FILE, STATE_DIRECTORY, stateDirectory, TRACKED_STATE_PATHSPEC } from "./layout.ts"
import {
  type Patience,
  STATE_PATIENCE,
  withFileLock,
  withStateLock,
  WORKTREE_PATIENCE,
} from "./lock.ts"
import {
  cleanupMigrationSources,
  MigrationFilesError,
  publishMigrationFiles,
  readMigrationSource,
  verifyMigrationFilePreimages,
  verifyMigrationFiles,
} from "./migration-files.ts"
import {
  prepareMigrationCommit,
  publishMigrationIndex,
  verifyMigrationCommit,
  verifyMigrationIndex,
} from "./migration-index.ts"
import { MigrationJournalError, readMigrationJournal } from "./migration-journal.ts"
import { MigrationRunnerConflict, runMigrationTransaction } from "./migration-runner.ts"
import { parseStateMode, STATE_MODE_KEY, type StateMode } from "./mode.ts"
import { definedEnv, looksLikeAgent } from "./portable.ts"
import { spawn } from "./process.ts"
import { scanFiles } from "./scan.ts"

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
  /** What was resolved on the way, which a commit then need not ask git for again. */
  readonly resolved?: Resolved
}

/**
 * The state mode of a clone and, in `branch` mode, its state branch, as {@link resolveState} read
 * them from git config. {@link commitState} takes them instead of reading the same config again.
 */
export type Resolved =
  { readonly mode: "branch"; readonly branch: string } | { readonly mode: "work" | "local" }

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

/** Returns the Git environment without inherited repository-specific variables. */
export const gitEnvironment = (env: Environment): Record<string, string> =>
  definedEnv({ ...process.env, ...env }, REPOSITORY_VARIABLES)

interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs git in a directory and reports how it ended; only a failure to start git is an error. With
 * `input`, git reads it from its standard input, which is how a list that grows with the state
 * reaches it without a command line that can outgrow the system's limit.
 */
const git = (cwd: string, env: Environment, args: ReadonlyArray<string>, input?: string) =>
  spawn("git", process.platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args, {
    cwd,
    env: gitEnvironment(env),
    stdin: input,
  }).pipe(
    Effect.catchDefect((cause) => Effect.fail(new StateIo({ path: cwd, cause }))),
    Effect.map((output): Ran => ({
      code: output.code,
      stdout: new TextDecoder("utf-8", { ignoreBOM: true }).decode(output.stdout),
      stderr: output.stderr,
    })),
  )

const failed = (cwd: string, args: ReadonlyArray<string>, ran: Ran) =>
  new StateIo({
    path: cwd,
    cause: `git ${args.join(" ")} exited ${ran.code}: ${`${ran.stderr}\n${ran.stdout}`.trim().split("\n").slice(-10).join("\n")}`,
  })

/** Runs git and returns its trimmed output, failing with StateIo on a non-zero exit. */
const gitText = (cwd: string, env: Environment, args: ReadonlyArray<string>, input?: string) =>
  git(cwd, env, args, input).pipe(
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
 * lock, since a holder that died leaves it until it is found stale (`patience` says otherwise for a
 * caller under a timeout). When `done` holds for the lines read before the lock, the lock is not
 * taken.
 */
const editExclude = <E, R>(
  top: string,
  common: string,
  env: Environment,
  edit: (lines: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, E, R>,
  done?: (lines: ReadonlyArray<string>) => boolean,
  patience: Patience = WORKTREE_PATIENCE,
  authorize: Effect.Effect<void, E, R> = Effect.void,
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
        yield* authorize
        yield* commitFile(path, body)
      }),
      patience,
      authorize,
    )
  })

/**
 * Puts the state folder in the clone's exclude file when a command resolves the `local` state,
 * unless the clone has left `local` since the command read its mode: the mode is read again under
 * the lock, so a command that waited cannot bring the entry back after a mode change removed it.
 */
const ensureExcluded = <E>(
  top: string,
  common: string,
  env: Environment,
  patience: Patience | undefined,
  authorize: Effect.Effect<void, E>,
) =>
  editExclude(
    top,
    common,
    env,
    (lines) =>
      authorize.pipe(
        Effect.andThen(stateModeOf(top, env)),
        Effect.map((mode) => (mode === "local" ? withEntry(lines) : lines)),
      ),
    hasEntry,
    patience,
    authorize,
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
  gitText(cwd, env, ["worktree", "list", "--porcelain", "-z"]).pipe(
    Effect.map((text) =>
      text
        .split("\0\0")
        .map((block) => block.split("\0"))
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

/** Lists local worktrees for operational resource validation, or the root outside git. */
export const operationalWorktrees = (cwd: string, env: Environment) =>
  git(cwd, env, ["worktree", "list", "--porcelain", "-z"]).pipe(
    Effect.flatMap((result) => {
      if (result.code !== 0)
        return /not a git repository/i.test(result.stderr)
          ? Effect.succeed([cwd])
          : Effect.fail(failed(cwd, ["worktree", "list", "--porcelain", "-z"], result))
      const roots = result.stdout
        .split("\0")
        .filter((field) => field.startsWith("worktree "))
        .map((field) => fromGitPath(field.slice(9)))
      return roots.length
        ? Effect.succeed(roots)
        : Effect.fail(new StateIo({ path: cwd, cause: "git listed no worktrees" }))
    }),
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
      const folder = stateDirectory(entry)
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
  `${branch.replace(/[^\w.-]+/g, "-").slice(0, 40)}-${createHash("sha1").update(branch).digest("hex").slice(0, 10)}`

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

/** The longest the state fetch may run before it is killed, in milliseconds. */
const FETCH_TIMEOUT_MS = 8_000

/** The ssh options of a state fetch: it never prompts and gives up connecting. */
const NON_INTERACTIVE_SSH_OPTIONS = "-o BatchMode=yes -o ConnectTimeout=5"

/** Variables through which a program would ask a person for a secret, which a fetch cannot answer. */
const ASKPASS_VARIABLES: ReadonlySet<string> = new Set(["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"])

/**
 * The environment of the state fetch: no terminal, askpass program or interactive credential
 * manager prompt, and ssh in batch mode with a connect timeout. The user's own choice of ssh is
 * kept: `GIT_SSH_COMMAND` in the environment is left alone, and a configured `core.sshCommand`
 * (`configured`), which an injected `GIT_SSH_COMMAND` would override, runs with the options
 * appended, also beside `GIT_SSH`, which git ranks below it. `GIT_SSH` alone is left alone.
 */
export const fetchEnvironment = (
  env: Environment,
  configured: string | undefined,
): Record<string, string> => {
  const base = Object.fromEntries(
    Object.entries(gitEnvironment(env)).filter(([name]) => !ASKPASS_VARIABLES.has(name)),
  )
  const chosen =
    base["GIT_SSH_COMMAND"] !== undefined ||
    (configured === undefined && base["GIT_SSH"] !== undefined)
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    // An empty askpass program is skipped by git, where an unset one falls back to SSH_ASKPASS.
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    ...(chosen ? {} : { GIT_SSH_COMMAND: `${configured ?? "ssh"} ${NON_INTERACTIVE_SSH_OPTIONS}` }),
  }
}

/**
 * Kills the process group of a detached child: git's helpers (ssh, credential helpers) are its
 * children, and a kill of git alone would leave them running. A group that is already gone is not
 * an error. Windows has no process groups, so `taskkill /T` ends the child and the tree of
 * processes below it, and the child is killed on its own as well in case that fails. `platform` is
 * a parameter so a test can stand in for either system.
 */
export const killGroup = (
  child: { readonly pid: number; readonly kill: (signal?: NodeJS.Signals | number) => unknown },
  platform: string = process.platform,
) => {
  // A pid of 0 or 1 is no child's: a negative one reaches every process the user may signal.
  const real = Number.isInteger(child.pid) && child.pid > 1
  return platform === "win32"
    ? (real
        ? spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            cwd: process.cwd(),
            env: gitEnvironment({}),
          }).pipe(
            Effect.catchDefect(() => Effect.void),
            Effect.ignore,
          )
        : Effect.void
      ).pipe(Effect.andThen(Effect.try(() => child.kill("SIGKILL"))), Effect.ignore)
    : Effect.try(() => {
        if (real) process.kill(-child.pid, "SIGKILL")
      }).pipe(Effect.ignore)
}

/**
 * Releases a bounded child: when its use failed or was interrupted, kills its group unless the
 * child has already exited, because a reaped child's pid may belong to an unrelated group by now.
 */
export const releaseGroup = (
  child: {
    readonly pid: number
    readonly kill: (signal?: NodeJS.Signals | number) => unknown
    readonly exitCode: number | null
  },
  exit: Exit.Exit<unknown, unknown>,
  platform: string = process.platform,
) => (exit._tag === "Failure" && child.exitCode === null ? killGroup(child, platform) : Effect.void)

/**
 * Runs git for its exit code only and, after `timeout` milliseconds, kills it and every helper it
 * started, then yields -1. The child leads a process group of its own (`detached`) so the whole
 * group can be killed on interruption. The output is discarded because a killed git can leave an
 * ssh child holding its pipes open, which would stall a reader.
 */
const gitBounded = (
  cwd: string,
  env: Record<string, string>,
  args: ReadonlyArray<string>,
  timeout: number,
) =>
  spawn("git", args, { cwd, env, discard: true }).pipe(
    Effect.map((result) => result.code),
    Effect.catchDefect((cause) => Effect.fail(new StateIo({ path: cwd, cause }))),
    Effect.timeoutOption(timeout),
    Effect.map((code) => (code._tag === "Some" ? code.value : -1)),
  )

/**
 * Fetches the state branch from `origin` into its remote-tracking ref, for a clone that has never
 * fetched it, and returns whether the ref exists afterwards. The fetch is quiet, never prompts (see
 * {@link fetchEnvironment}), keeps the ssh command and credential helpers the user configured (a
 * stored helper answers without a prompt, which a private https remote needs) and is killed after
 * `timeout` milliseconds; an offline, slow, missing or empty remote only means the branch starts
 * from the base.
 */
export const fetchRemoteBranch = <E = never>(
  top: string,
  env: Environment,
  branch: string,
  timeout: number = FETCH_TIMEOUT_MS,
  authorize: Effect.Effect<void, E> = Effect.void,
) =>
  git(top, env, ["config", "--get", "core.sshCommand"]).pipe(
    Effect.map((ran) => (ran.code === 0 ? ran.stdout.trim() : "")),
    Effect.flatMap((configured) =>
      authorize.pipe(
        Effect.andThen(
          gitBounded(
            top,
            fetchEnvironment(env, configured === "" ? undefined : configured),
            [
              "-c",
              "core.askPass=",
              "fetch",
              "-q",
              "--no-tags",
              "origin",
              `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
            ],
            timeout,
          ),
        ),
      ),
    ),
    Effect.flatMap((code) =>
      code === 0 ? refExists(top, env, `refs/remotes/origin/${branch}`) : Effect.succeed(false),
    ),
  )

/** A durable per-branch marker keeps the first worktree sweep recoverable. */
const migrationSweepPath = (common: string, branch: string) =>
  join(common, "holyagent", `${worktreeFolder(branch)}.migration-sweep`)

const checkSweepFile = (
  path: string,
  info: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number; mode: number; uid: number },
) => {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())))
  )
    throw new Error(`unsafe migration sweep marker: ${path}`)
}

/** Syncing the marker and its directory makes the initial enumeration survive interruption. */
const syncSweepDirectory = async (path: string) => {
  if (process.platform === "win32") return
  const dir = await open(dirname(path), "r")
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}

const beginMigrationSweep = <E>(
  common: string,
  branch: string,
  authorize: Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    const path = migrationSweepPath(common, branch)
    const parent = dirname(path)
    const commonRoot = yield* io(common, () => realpath(common))
    const info = yield* io(parent, () => lstat(parent))
    const actual = yield* io(parent, () => realpath(parent))
    if (!info.isDirectory() || info.isSymbolicLink() || actual !== join(commonRoot, "holyagent"))
      return yield* new StateIo({
        path: parent,
        cause: "migration marker parent is not a canonical directory",
      })
    yield* authorize
    yield* io(path, async () => {
      let handle
      try {
        try {
          handle = await open(path, "wx", 0o600)
        } catch (cause) {
          if (!hasCode(cause, "EEXIST")) throw cause
        }
        if (handle !== undefined) await handle.sync()
        const marker = await lstat(path)
        checkSweepFile(path, marker)
      } finally {
        await handle?.close()
      }
      await syncSweepDirectory(path)
    }).pipe(Effect.uninterruptible)
  })

const finishMigrationSweep = <E>(
  common: string,
  branch: string,
  authorize: Effect.Effect<void, E>,
  terminalAuthorize: () => boolean,
) =>
  Effect.gen(function* () {
    const path = migrationSweepPath(common, branch)
    const before = yield* io(path, async () => {
      const info = await lstat(path)
      checkSweepFile(path, info)
      return { dev: info.dev, ino: info.ino }
    })
    yield* authorize
    yield* io(path, async () => {
      const current = await lstat(path)
      checkSweepFile(path, current)
      if (current.dev !== before.dev || current.ino !== before.ino)
        throw new Error("migration sweep marker changed during authorization")
      if (terminalAuthorize() !== true)
        throw new Error("terminal migration authority is unavailable or revoked")
      await rm(path)
      await syncSweepDirectory(path)
    }).pipe(Effect.uninterruptible)
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
 * `origin/<branch>` (fetched first when the clone has no such ref), else from the base branch head;
 * with none of them it is `deferred` until the base has a commit. With `make` false a missing
 * worktree is `absent`. A finished worktree gets a marker next to it, so that later commands pass
 * without the lock. `patience` is how long the lock is waited for (see {@link withFileLock}).
 */
const ensureWorktree = <E>(
  top: string,
  common: string,
  env: Environment,
  branch: string,
  path: string,
  options: { readonly make: boolean; readonly peek: boolean; readonly online: boolean },
  patience: Patience = WORKTREE_PATIENCE,
  authorize: Effect.Effect<void, E> = Effect.void,
) =>
  withFileLock(
    join(common, "holyagent", "worktree.lock"),
    Effect.gen(function* () {
      yield* authorize
      const ready = readyMarker(path)
      const again = yield* checkedOut(yield* listWorktrees(top, env), branch)
      if (again !== undefined) {
        if (!options.peek && (yield* samePath(again, path)) && !(yield* fileExists(ready))) {
          yield* authorize
          yield* io(ready, () =>
            mkdir(dirname(ready), { recursive: true }).then(() => writeFile(ready, "")),
          )
        }
        return { kind: "ready", path: again, created: false } satisfies Ensured
      }
      if (!options.make) return { kind: "absent" } satisfies Ensured
      // A mode change made while this command waited for the lock leaves no state branch to make.
      if ((yield* stateModeOf(top, env)) !== "branch") return { kind: "deferred" } satisfies Ensured
      yield* authorize
      yield* git(top, env, ["worktree", "prune"])
      yield* requireFree(yield* listWorktrees(top, env), path, branch)
      const add = [...BOOKKEEPING, "worktree", "add", "-q"]
      const local = yield* refExists(top, env, `refs/heads/${branch}`)
      const remote =
        (yield* refExists(top, env, `refs/remotes/origin/${branch}`)) ||
        (!local &&
          options.online &&
          (yield* authorize.pipe(
            Effect.andThen(fetchRemoteBranch(top, env, branch, undefined, authorize)),
          )))
      // Without the network the remote copy is unknown, so the branch is left for a command that
      // may fetch it; starting it from the base here would shadow the remote one for good.
      if (!local && !remote && !options.online) return { kind: "absent" } satisfies Ensured
      const start = local || remote ? undefined : yield* baseStart(top, env)
      const target = local
        ? [path, branch]
        : remote
          ? ["--track", "-b", branch, path, `origin/${branch}`]
          : start === undefined
            ? undefined
            : ["--no-track", "-b", branch, path, start]
      if (target === undefined) return { kind: "deferred" } satisfies Ensured
      // Keep the initial source sweep discoverable even if checkout or migration is interrupted.
      yield* beginMigrationSweep(common, branch, authorize)
      // The folder is ours (under the git directory) and no work tree is registered at it, so what
      // is there is a leftover.
      yield* authorize
      yield* io(ready, () => rm(ready, { force: true }))
      yield* authorize
      yield* io(path, () => rm(path, { recursive: true, force: true }))
      yield* authorize
      yield* io(path, () => mkdir(dirname(path), { recursive: true }))
      yield* authorize
      yield* gitText(top, env, [...add, ...target])
      // Finish marking a completed checkout; an interrupted checkout is recovered on the next run.
      yield* Effect.uninterruptible(
        io(ready, () =>
          mkdir(dirname(ready), { recursive: true }).then(() => writeFile(ready, "")),
        ),
      )
      return { kind: "ready", path, created: true } satisfies Ensured
    }),
    patience,
    authorize,
  )

interface Entry {
  /** The path relative to the state folder. */
  readonly path: string
  /** Its two-letter `git status --porcelain` code in the work tree; absent for a clean file. */
  readonly status: string | undefined
}

/** The per-clone files that move with the state: what the CLI keeps in `local/`. */
const LOCAL_FILES: ReadonlySet<string> = new Set(["local/specialists.json"])

const sameBytes = (a: string, b: string) =>
  Effect.all([io(a, () => readFile(a)), io(b, () => readFile(b))]).pipe(
    Effect.map(([left, right]) => Buffer.from(left).equals(Buffer.from(right))),
  )

const fileExists = (path: string) =>
  io(path, () => stat(path)).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => hasCode(error.cause, "ENOENT"),
      () => Effect.succeed(false),
    ),
  )

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

/** The files under a work tree's state folder, each with its git status when it is not clean. */
const workTreeEntries = (top: string, env: Environment) =>
  Effect.gen(function* () {
    const folder = stateDirectory(top)
    if (!(yield* isDirectory(folder))) return [] as ReadonlyArray<Entry>
    const files = yield* io(folder, () => scanFiles(folder)).pipe(
      Effect.map((paths) => paths.map((path) => toPosix(path))),
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
    if (listing.code !== 0) return yield* failed(top, ["status"], listing)
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

const migrationMarker = (common: string, top: string) =>
  io(top, () => realpath(top)).pipe(
    Effect.map((real) =>
      join(
        common,
        "holyagent",
        "migrated",
        createHash("sha1").update(real).digest("hex").slice(0, 16),
      ),
    ),
  )

/** One clone-wide journal protects readers from an incomplete migration. */
const migrationJournalPath = (common: string) =>
  join(common, "holyagent", "migration", "journal.json")
const pendingMigration = (common: string) =>
  kindAt(migrationJournalPath(common)).pipe(Effect.map((kind) => kind !== undefined))

const pendingReadMigration = (common: string, branch: string) =>
  Effect.gen(function* () {
    if (yield* pendingMigration(common)) return true
    return (yield* kindAt(migrationSweepPath(common, branch))) !== undefined
  })

/** Run or recover the migration while holding the shared state lock. */
const migrateWorkTree = <E>(
  top: string,
  common: string,
  worktree: string,
  env: Environment,
  branch: string,
  patience: Patience = STATE_PATIENCE,
  authorize: Effect.Effect<void, E> = Effect.void,
  terminalAuthorize: () => boolean = () => false,
) =>
  Effect.gen(function* () {
    const source = stateDirectory(top)
    const target = stateDirectory(worktree)
    const marker = yield* migrationMarker(common, top)
    if (!(yield* pendingMigration(common)) && (yield* fileExists(marker))) return
    yield* requireStateFolder(target)
    const sourceKind = yield* kindAt(source)
    if (sourceKind !== undefined && sourceKind !== "directory") {
      if (yield* pendingMigration(common))
        return yield* new StateIo({
          path: source,
          cause: "migration source is no longer a real directory; inspect it before recovery",
        })
      return
    }
    yield* withStateLock(
      target,
      Effect.gen(function* () {
        if (!(yield* pendingMigration(common)) && (yield* fileExists(marker))) return
        if (!(yield* pendingMigration(common)) && (yield* workTreeEntries(top, env)).length === 0) {
          yield* authorize
          yield* io(marker, () =>
            mkdir(dirname(marker), { recursive: true }).then(() => writeFile(marker, "")),
          )
          return
        }
        const sourceRoot = yield* io(top, () => realpath(top))
        const targetRoot = yield* io(worktree, () => realpath(worktree))
        const journalPath = migrationJournalPath(common)
        const commonRoot = yield* io(common, () => realpath(common))
        const privateRoot = join(commonRoot, "holyagent")
        for (const directory of [privateRoot, join(privateRoot, "migration")]) {
          yield* authorize
          yield* io(directory, () => mkdir(directory, { mode: 0o700 })).pipe(
            Effect.catchIf(
              (error) => hasCode(error.cause, "EEXIST"),
              () => Effect.void,
            ),
          )
          const info = yield* io(directory, () => lstat(directory))
          const actual = yield* io(directory, () => realpath(directory))
          if (!info.isDirectory() || info.isSymbolicLink() || actual !== directory)
            return yield* new StateIo({
              path: directory,
              cause: "migration journal parent is not a canonical directory",
            })
        }
        const location = {
          path: join(commonRoot, "holyagent", "migration", "journal.json"),
          sourceRoot,
          targetRoot,
        }
        const identity = yield* committing(targetRoot, env)
        const local = (path: string) => path.startsWith(`${STATE_DIRECTORY}/local/`)
        const indexFiles = <T extends { readonly path: string }>(files: ReadonlyArray<T>) =>
          files.filter((file) => !local(file.path))
        const run = runMigrationTransaction<StateIo | StateLocked | MigrationFilesError, E, never>({
          location,
          branch,
          authorize,
          services: {
            prepare: (begin) =>
              Effect.gen(function* () {
                const entries = yield* workTreeEntries(sourceRoot, env)
                const trackedText = yield* gitText(
                  sourceRoot,
                  { ...env, GIT_OPTIONAL_LOCKS: "0" },
                  ["ls-files", "-z", "--", STATE_DIRECTORY],
                )
                const tracked = new Set(trackedText.split("\0"))
                const algorithm = (yield* gitText(targetRoot, env, [
                  "rev-parse",
                  "--show-object-format",
                ])).trim()
                if (algorithm !== "sha1" && algorithm !== "sha256")
                  return yield* new StateIo({
                    path: targetRoot,
                    cause: "unsupported Git object format",
                  })
                const files: Array<{ path: string; content: string; mode: number }> = []
                const sourceFiles: Array<{ path: string; digest: string; tracked: boolean }> = []
                for (const entry of entries) {
                  if (!(yield* isPlainFile(source, entry.path))) continue
                  yield* requirePlainTarget(target, entry.path)
                  const path = `${STATE_DIRECTORY}/${entry.path}`
                  const to = join(target, entry.path)
                  const there = (yield* kindAt(to)) !== undefined
                  const dirty = entry.status !== undefined && !entry.status.includes("D")
                  if (local(path) && there) continue
                  if (there && !dirty) continue
                  const { bytes, mode } = yield* readMigrationSource({ root: sourceRoot, path })
                  files.push({ path, content: bytes.toString("base64"), mode })
                  if (dirty && !local(path))
                    sourceFiles.push({
                      path,
                      digest: createHash(algorithm)
                        .update(`blob ${bytes.length}\0`)
                        .update(bytes)
                        .digest("hex"),
                      tracked: tracked.has(path),
                    })
                }
                const prepared = yield* prepareMigrationCommit({
                  cwd: targetRoot,
                  env: identity,
                  files: indexFiles(files),
                  message: "chore(state): migrate the state found in a work tree",
                  authorize: begin,
                })
                const localFiles = files
                  .filter((file) => local(file.path))
                  .map((file) => {
                    const bytes = Buffer.from(file.content, "base64")
                    return {
                      ...file,
                      before: null,
                      after: createHash(algorithm)
                        .update(`blob ${bytes.length}\0`)
                        .update(bytes)
                        .digest("hex"),
                    }
                  })
                const planned = [...prepared.files, ...localFiles]
                yield* verifyMigrationFilePreimages({ root: targetRoot, files: planned })
                return { ...prepared, files: planned, source: sourceFiles }
              }),
            readRef: (name) =>
              gitText(targetRoot, env, ["rev-parse", "--verify", `refs/heads/${name}`]),
            compareAndSwapRef: (name, parent, commit, begin) =>
              begin.pipe(
                Effect.andThen(
                  gitText(targetRoot, env, ["update-ref", `refs/heads/${name}`, commit, parent]),
                ),
                Effect.asVoid,
              ),
            verifyCommit: (journal) =>
              Effect.gen(function* () {
                // Roots come from the caller, and recovery may only touch paths the migration
                // planner owns. A source deletion must be tied to its published postimage.
                const planned = new Map(journal.files.map((file) => [file.path, file]))
                const allowed = (path: string) =>
                  path.startsWith(`${STATE_DIRECTORY}/`) &&
                  path !== `${STATE_DIRECTORY}/${CONFIG_FILE}` &&
                  (!local(path) || path === `${STATE_DIRECTORY}/local/specialists.json`)
                if (
                  journal.files.some((file) => !allowed(file.path)) ||
                  journal.source.some(
                    (file) =>
                      !allowed(file.path) ||
                      local(file.path) ||
                      planned.get(file.path)?.after !== file.digest,
                  )
                )
                  return yield* new StateIo({
                    path: journalPath,
                    cause:
                      "migration journal contains unowned or inconsistent paths; inspect it before recovery",
                  })
                yield* verifyMigrationCommit({
                  cwd: targetRoot,
                  env,
                  parent: journal.parent,
                  tree: journal.tree,
                  commit: journal.commit,
                  files: indexFiles(journal.files),
                })
              }),
            publishFiles: (journal, begin) =>
              publishMigrationFiles({
                root: targetRoot,
                files: journal.files,
                authorize: begin,
                terminalAuthorize,
              }),
            publishIndex: (journal, begin) =>
              publishMigrationIndex({
                cwd: targetRoot,
                env,
                files: indexFiles(journal.files),
                authorize: begin,
              }),
            verifyTarget: (journal) =>
              verifyMigrationFiles({ root: targetRoot, files: journal.files }).pipe(
                Effect.andThen(
                  verifyMigrationIndex({ cwd: targetRoot, env, files: indexFiles(journal.files) }),
                ),
              ),
            cleanupSource: (journal, begin) =>
              Effect.gen(function* () {
                const cleaned = yield* cleanupMigrationSources({
                  root: sourceRoot,
                  source: journal.source,
                  authorize: begin,
                  terminalAuthorize,
                  isTracked: (path) =>
                    git(sourceRoot, { ...env, GIT_OPTIONAL_LOCKS: "0" }, [
                      "--literal-pathspecs",
                      "ls-files",
                      "--error-unmatch",
                      "--",
                      path,
                    ]).pipe(
                      Effect.flatMap((result) =>
                        result.code === 0
                          ? Effect.succeed(true)
                          : result.code === 1
                            ? Effect.succeed(false)
                            : Effect.fail(failed(sourceRoot, ["ls-files"], result)),
                      ),
                    ),
                })
                if (cleaned.retained.some((file) => file.reason === "changed"))
                  return yield* new StateIo({
                    path: sourceRoot,
                    cause: "source state changed during migration; inspect and retry",
                  })
                for (const path of cleaned.removed) {
                  let folder = dirname(join(sourceRoot, path))
                  while (folder.startsWith(`${source}${sep}`)) {
                    yield* begin
                    const removed = yield* io(folder, () => rmdir(folder)).pipe(
                      Effect.as(true),
                      Effect.orElseSucceed(() => false),
                    )
                    if (!removed) break
                    folder = dirname(folder)
                  }
                }
                yield* begin
                yield* io(source, () => rmdir(source)).pipe(Effect.ignore)
                yield* begin
                yield* io(marker, () =>
                  mkdir(dirname(marker), { recursive: true }).then(() => writeFile(marker, "")),
                )
              }),
          },
        })
        yield* run.pipe(
          Effect.mapError((error) =>
            error instanceof MigrationJournalError ||
            error instanceof MigrationRunnerConflict ||
            error instanceof MigrationFilesError
              ? new StateIo({ path: journalPath, cause: error.message })
              : error,
          ),
        )
      }),
      patience,
      authorize,
    )
  })

/**
 * The files HolyAgent writes under the state folder, relative to it: the settings, the records and
 * the notes of an Intent folder (`resume-notes.md` and `notes/`, never a `.tmp` file). It does not
 * list what `holyagent migrate` copies: migrate passes every copied path to {@link commitState},
 * which stages those files by name (see {@link stageState}) whether or not this pattern matches.
 */
const STATE_FILE =
  /^(?:config\.json|intents\/[^/]+\/(?:intent\.json|(?:assignments|branches|pulls)\/[^/]+\.json|resume-notes\.md|notes\/(?:.+\/)?[^/]+(?<!\.tmp)))$/

/**
 * Stages the changes under `.holyagent/` of the state worktree: the changes and removals of what
 * git already tracks there, then each file HolyAgent writes ({@link STATE_FILE}) with `-f`, because
 * a branch started from the base inherits its `.gitignore`, which may ignore the state folder as a
 * whole. Any other file stays unstaged whatever the ignore rules say, as does `local/`, except the
 * `copied` files a command wrote itself (absolute paths; one outside the state folder or in
 * `local/` is ignored).
 */
const stageState = <E>(
  worktree: string,
  env: Environment,
  copied: ReadonlyArray<string>,
  begin: Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    // Newer git rejects `add -u` for a pathspec that matches nothing git tracks, as on the first
    // state commit, so only update what is tracked.
    const tracked = [STATE_DIRECTORY, `:(exclude)${STATE_DIRECTORY}/local`]
    if ((yield* gitText(worktree, env, ["ls-files", "--", ...tracked])) !== "") {
      yield* begin
      yield* gitText(worktree, env, ["add", "-u", "--", ...tracked])
    }
    const folder = stateDirectory(worktree)
    const files = yield* io(folder, () => scanFiles(folder))
    const named = copied
      .map((path) => toPosix(relative(folder, path)))
      .filter((path) => path !== "" && !path.startsWith("../") && !/^local(?:\/|$)/.test(path))
    const wanted = [
      ...new Set([
        ...files.map((path) => toPosix(path)).filter((path) => STATE_FILE.test(path)),
        ...named,
      ]),
    ].map((path) => `${STATE_DIRECTORY}/${path}`)
    // The names go to git on its standard input, NUL-separated: on the command line they would
    // outgrow the operating system's limit as the history grows (about 200 files on Windows).
    if (wanted.length > 0) {
      yield* begin
      yield* gitText(
        worktree,
        env,
        ["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"],
        wanted.map((path) => `${path}\0`).join(""),
      )
    }
  })

/**
 * Commits what changed under `.holyagent/` of the state worktree on the state branch, with the
 * identity git has for the repository, and returns whether a commit was made. Nothing happens in
 * the `work` and `local` modes (the work commit or nobody carries the state), when the folder is
 * not in a worktree on the state branch (outside git, or on another branch), or when nothing
 * changed. `copied` lists files outside the usual record names that the caller wrote and wants
 * committed (see {@link stageState}); every other stray file stays out. `resolved` is the mode and
 * branch that {@link resolveState} found, which save reading them from git config again; without it
 * they are read. Call it under the state lock.
 */
export const commitState = <E = never>(
  directory: string,
  env: Environment,
  message: string,
  copied: ReadonlyArray<string> = [],
  resolved?: Resolved,
  begin: Effect.Effect<void, E> = Effect.void,
) =>
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
    const known = resolved ?? {
      mode: yield* stateModeOf(worktree, env),
    }
    if (known.mode !== "branch") return false
    // Only a worktree on the state branch takes the commit, wherever it is: the one under the git
    // directory can have been switched, and a commit there would land on the wrong branch.
    const current = yield* git(worktree, env, ["symbolic-ref", "--short", "-q", "HEAD"])
    const branch = "branch" in known ? known.branch : yield* stateBranch(worktree, env)
    if (current.code !== 0 || current.stdout.trim() !== branch) return false
    yield* stageState(worktree, env, copied, begin)
    if (yield* gitSucceeds(worktree, env, ["diff", "--cached", "--quiet", "--", STATE_DIRECTORY]))
      return false
    const identity = yield* committing(worktree, env)
    yield* begin
    yield* gitText(worktree, identity, [
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
    const located = yield* git(cwd, env, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
    if (located.code !== 0) {
      const complaint = located.stderr.trim()
      if (NOT_A_REPOSITORY.test(complaint)) return undefined
      return yield* new StateIo({ path: cwd, cause: `git: ${complaint}` })
    }
    const commonResult = yield* git(cwd, env, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
    if (commonResult.code !== 0) return yield* failed(cwd, ["rev-parse"], commonResult)
    // Each command emits one path followed by a newline; embedded and trailing whitespace in
    // worktree names is part of that path, not a separator between multiple results.
    const gitPath = (text: string) => {
      const ending =
        process.platform === "win32" && text.endsWith("\r\n") ? 2 : text.endsWith("\n") ? 1 : 0
      return fromGitPath(ending === 0 ? text : text.slice(0, -ending))
    }
    const top = gitPath(located.stdout)
    const common = gitPath(commonResult.stdout)
    if (top === "" || common === "")
      return yield* new StateIo({ path: cwd, cause: "git returned an empty repository path" })
    return { top, common }
  })

/**
 * Read a branch migration fence without writing. A caller compares checkpoints before and after a
 * read: a pending journal or changed ref means the read may have crossed publication.
 */
export const migrationReadCheckpoint = (cwd: string, env: Environment, branch: string) =>
  Effect.gen(function* () {
    const repository = yield* locate(cwd, env)
    if (repository === undefined)
      return yield* new StateIo({
        path: cwd,
        cause: "the state repository disappeared during a read",
      })
    const journal = migrationJournalPath(repository.common)
    const requireComplete = pendingReadMigration(repository.common, branch).pipe(
      Effect.flatMap((pending) =>
        pending
          ? Effect.fail(
              new StateIo({
                path: journal,
                cause:
                  "state migration is incomplete; run an authorized state command to recover it",
              }),
            )
          : Effect.void,
      ),
    )
    yield* requireComplete
    const ref = yield* git(repository.top, { ...env, GIT_OPTIONAL_LOCKS: "0" }, [
      "rev-parse",
      "--verify",
      "-q",
      `refs/heads/${branch}`,
    ])
    if (ref.code !== 0 && ref.code !== 1) return yield* failed(repository.top, ["rev-parse"], ref)
    yield* requireComplete
    return { common: repository.common, head: ref.code === 0 ? ref.stdout.trim() : null }
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
 * reported, so state is not silently written somewhere else. With `online` false (a hook's case)
 * nothing touches the network: a state branch that exists nowhere locally is not made, since only a
 * fetch can tell whether the remote has it, and the state counts as absent until a command that may
 * fetch makes it. With `patience`, every lock it takes (exclude, worktree and migration) is waited
 * for that long at most, so a plugin hook passes one deadline (see {@link deadlineIn}) to give up
 * inside the host's hook timeout; without it each lock keeps the wait its holder needs.
 */
export const resolveState = <E = never>(
  cwd: string,
  env: Environment,
  ensure: Ensure,
  online: boolean = true,
  patience?: Patience,
  authorize: Effect.Effect<void, E> = Effect.void,
  terminalAuthorize: () => boolean = () => authorize === Effect.void,
) =>
  Effect.gen(function* () {
    const repository = yield* locate(cwd, env)
    if (repository === undefined)
      return { root: cwd, directory: stateDirectory(cwd) } satisfies StateTree
    const { top, common } = repository
    const mode = yield* stateModeOf(top, env)
    if (mode !== "branch") {
      if (mode === "local" && ensure !== "peek") {
        yield* authorize
        yield* ensureExcluded(top, common, env, patience, authorize)
      }
      return { root: top, directory: stateDirectory(top), resolved: { mode } } satisfies StateTree
    }
    const branch = yield* stateBranch(top, env)
    if (ensure === "peek" && (yield* pendingReadMigration(common, branch)))
      return yield* new StateIo({
        path: migrationJournalPath(common),
        cause: "state migration is incomplete; run an authorized state command to recover it",
      })
    const resolved: Resolved = { mode, branch }
    const listed = yield* listWorktrees(top, env)
    const found = yield* checkedOut(listed, branch)
    const standard = join(common, "holyagent", worktreeFolder(branch))
    // A worktree git has registered may still be checking out: only one with its marker, or one
    // the user made elsewhere, is used without the lock. Otherwise the command waits for the
    // command that is making it, then finds it made.
    const settled =
      found !== undefined &&
      (!(yield* samePath(found, standard)) || (yield* fileExists(readyMarker(standard))))
    if (ensure === "peek" && found !== undefined && !settled)
      return yield* new StateIo({
        path: found,
        cause: "the state worktree is not ready; wait for its checkout to finish and retry",
      })
    const make =
      ensure === "create" ||
      (ensure === "ifPresent" &&
        ((yield* pendingReadMigration(common, branch)) ||
          (yield* keepsState(top, env, branch, listed))))
    const ensured: Ensured =
      found !== undefined && settled
        ? { kind: "ready", path: found, created: false }
        : found === undefined && !make
          ? { kind: "absent" }
          : yield* authorize.pipe(
              Effect.andThen(
                ensureWorktree(
                  top,
                  common,
                  env,
                  branch,
                  standard,
                  {
                    make,
                    peek: ensure === "peek",
                    online,
                  },
                  patience,
                  authorize,
                ),
              ),
            )
    if (ensured.kind === "deferred")
      return { root: top, directory: stateDirectory(top), resolved } satisfies StateTree
    if (ensured.kind === "absent") {
      yield* requireFree(listed, standard, branch)
      return { root: top, directory: stateDirectory(standard), resolved } satisfies StateTree
    }
    const worktree = ensured.path
    const directory = stateDirectory(worktree)
    if (ensure !== "peek") {
      // Resolve a clone-wide journal against Git-registered roots, never against the caller by
      // assumption or a root supplied by the journal. Serialize whole sweeps before state locks.
      yield* withFileLock(
        join(common, "holyagent", "migration-sweep.lock"),
        Effect.gen(function* () {
          const pending = yield* pendingMigration(common)
          let sweeping = (yield* kindAt(migrationSweepPath(common, branch))) !== undefined
          // Journals made by an older version did not have a sweep marker. Persist one before
          // recovering so a second interruption cannot lose the remaining registered sources.
          if (pending && !sweeping) {
            yield* beginMigrationSweep(common, branch, authorize)
            sweeping = true
          }
          const targetRoot = yield* io(worktree, () => realpath(worktree))
          if (!pending && !sweeping) {
            const source = yield* io(top, () => realpath(top))
            if (source !== targetRoot)
              yield* migrateWorkTree(
                source,
                common,
                worktree,
                env,
                branch,
                patience,
                authorize,
                terminalAuthorize,
              )
            return
          }
          const sweepPath = migrationSweepPath(common, branch)
          yield* io(sweepPath, async () => checkSweepFile(sweepPath, await lstat(sweepPath)))
          const registered = yield* listWorktrees(top, env)
          const own = join(yield* io(common, () => realpath(common)), "holyagent")
          const commonRoot = yield* io(common, () => realpath(common))
          const candidates: string[] = []
          for (const entry of registered) {
            if (entry.prunable || entry.path.startsWith(`${own}${sep}`)) continue
            const kind = yield* kindAt(entry.path)
            if (kind !== "directory")
              return yield* new StateIo({
                path: entry.path,
                cause: "a registered worktree is not a real directory; inspect it before migration",
              })
            const sourceRoot = yield* io(entry.path, () => realpath(entry.path))
            if (sourceRoot === targetRoot) continue
            const sourceRepo = yield* locate(sourceRoot, env)
            if (sourceRepo === undefined)
              return yield* new StateIo({
                path: entry.path,
                cause: "a registered worktree no longer belongs to this clone",
              })
            const [sourceTop, sourceCommon] = yield* Effect.all([
              io(sourceRepo.top, () => realpath(sourceRepo.top)),
              io(sourceRepo.common, () => realpath(sourceRepo.common)),
            ])
            if (sourceTop !== sourceRoot || sourceCommon !== commonRoot)
              return yield* new StateIo({
                path: entry.path,
                cause: "a registered worktree no longer belongs to this clone",
              })
            if (!candidates.includes(sourceRoot)) candidates.push(sourceRoot)
          }
          const primary = yield* io(top, () => realpath(top))
          const primaryIndex = candidates.indexOf(primary)
          if (primaryIndex > 0) {
            candidates.splice(primaryIndex, 1)
            candidates.unshift(primary)
          }
          if (pending) {
            let recorded: string | undefined
            for (const sourceRoot of candidates) {
              const matches = yield* readMigrationJournal({
                path: join(commonRoot, "holyagent", "migration", "journal.json"),
                sourceRoot,
                targetRoot,
              }).pipe(
                Effect.match({
                  onFailure: () => false,
                  onSuccess: (journal) => journal !== undefined,
                }),
              )
              if (matches) {
                recorded = sourceRoot
                break
              }
            }
            if (recorded === undefined)
              return yield* new StateIo({
                path: migrationJournalPath(common),
                cause:
                  "migration journal does not match a registered worktree of this clone; inspect it before recovery",
              })
            yield* migrateWorkTree(
              recorded,
              common,
              worktree,
              env,
              branch,
              patience,
              authorize,
              terminalAuthorize,
            )
          }
          for (const source of candidates)
            yield* migrateWorkTree(
              source,
              common,
              worktree,
              env,
              branch,
              patience,
              authorize,
              terminalAuthorize,
            )
          yield* finishMigrationSweep(common, branch, authorize, terminalAuthorize)
        }),
        patience,
        authorize,
      )
    }
    return { root: top, directory, resolved } satisfies StateTree
  })

/** Refuses a handoff when branch-mode records cannot be represented by its read-only snapshot. */
export const requireHandoffState = (cwd: string, env: Environment, directory: string) =>
  Effect.gen(function* () {
    const repository = yield* locate(cwd, env)
    if (repository === undefined || (yield* stateModeOf(repository.top, env)) !== "branch") return
    const { top, common } = repository
    const branch = yield* stateBranch(top, env)
    const listed = yield* listWorktrees(top, env)
    const stateWorktree = yield* checkedOut(listed, branch)
    if (
      stateWorktree === undefined &&
      ((yield* refExists(top, env, `refs/heads/${branch}`)) ||
        (yield* refExists(top, env, `refs/remotes/origin/${branch}`)))
    )
      return yield* new StateIo({
        path: directory,
        cause: `the recorded state branch ${branch} is not checked out; run a state command to make it available, then retry handoff`,
      })
    const own = join(common, "holyagent")
    for (const entry of listed) {
      if (
        entry.prunable ||
        (stateWorktree !== undefined && (yield* samePath(entry.path, stateWorktree))) ||
        entry.path.startsWith(`${own}${sep}`)
      )
        continue
      const source = stateDirectory(entry.path)
      yield* requireStateFolder(source)
      const records = join(source, "intents")
      const kind = yield* kindAt(records)
      if (kind === undefined) continue
      if (kind !== "directory")
        return yield* new StateIo({
          path: records,
          cause: "recorded state is not a directory; inspect it before retrying handoff",
        })
      const marker = yield* migrationMarker(common, entry.path)
      if (!(yield* fileExists(marker)))
        return yield* new StateIo({
          path: source,
          cause:
            "recorded state awaits migration; run a state command from this worktree, then retry handoff",
        })
      const entries = yield* workTreeEntries(entry.path, { ...env, GIT_OPTIONAL_LOCKS: "0" })
      const trackedResult = yield* git(entry.path, { ...env, GIT_OPTIONAL_LOCKS: "0" }, [
        "ls-files",
        "--cached",
        "-z",
        "--",
        `${STATE_DIRECTORY}/intents`,
      ])
      if (trackedResult.code !== 0)
        return yield* failed(
          entry.path,
          ["ls-files", "--cached", "-z", "--", `${STATE_DIRECTORY}/intents`],
          trackedResult,
        )
      const tracked = new Set(
        trackedResult.stdout.split("\0").map((path) => path.slice(STATE_DIRECTORY.length + 1)),
      )
      for (const file of entries.filter((item) => item.path.startsWith("intents/"))) {
        const target = join(directory, file.path)
        if (
          !(yield* isPlainFile(source, file.path)) ||
          !(yield* isPlainFile(directory, file.path)) ||
          ((file.status !== undefined || !tracked.has(file.path)) &&
            !(yield* sameBytes(join(source, file.path), target)))
        )
          return yield* new StateIo({
            path: source,
            cause:
              "recorded state differs from the shared state; inspect and reconcile this worktree before retrying handoff",
          })
      }
    }
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
            reason: `the repository tracks state in ${STATE_DIRECTORY}/, which an exclude entry cannot hide; use local only after the tracked state is removed from git, work only in a repository its owner controls (it commits the state with the work), or ask the owner; see docs/usage.md`,
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
      WORKTREE_PATIENCE,
    )
  })
