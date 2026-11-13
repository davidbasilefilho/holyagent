import { createHash } from "node:crypto"
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"

import { Effect, type Exit } from "effect"

import { fromGitPath, toPosix } from "../domain/paths.ts"
import { StateIo, StateModeRefused } from "./errors.ts"
import { commitFile, hasCode, io, readText } from "./files.ts"
import { CONFIG_FILE, STATE_DIRECTORY, stateDirectory, TRACKED_STATE_PATHSPEC } from "./layout.ts"
import {
  type Patience,
  STATE_PATIENCE,
  withFileLock,
  withStateLock,
  WORKTREE_PATIENCE,
} from "./lock.ts"
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

/**
 * Copies a plain file into the state worktree through a temporary neighbour and a rename, after
 * checking that the folders it lands in are plain folders inside the worktree. The rename never
 * follows a link at the destination.
 */
const copyInto = <E>(root: string, relative: string, from: string, begin: Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    yield* requirePlainTarget(root, relative)
    const to = join(root, relative)
    yield* begin
    yield* io(to, () => mkdir(dirname(to), { recursive: true }))
    const [folder, base] = yield* Effect.all([canonical(dirname(to)), realStateFolder(root)])
    if (folder !== base && !folder.startsWith(`${base}${sep}`))
      return yield* new StateIo({ path: to, cause: `${folder} is outside the state worktree` })
    const temporary = `${to}.${process.pid}.${crypto.randomUUID()}.tmp`
    yield* io(to, () => copyFile(from, temporary)).pipe(
      Effect.andThen(io(to, () => rename(temporary, to))),
      Effect.tapError(() =>
        io(temporary, () => rm(temporary, { force: true })).pipe(Effect.ignore),
      ),
    )
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
        createHash("sha1").update(real).digest("hex").slice(0, 16),
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
 * only when the state worktree has none. `patience` is how long the state lock is waited for.
 */
const migrateWorkTree = <E>(
  top: string,
  common: string,
  worktree: string,
  env: Environment,
  commit: (message: string, begin: Effect.Effect<void, E>) => Effect.Effect<boolean, StateIo | E>,
  patience: Patience = STATE_PATIENCE,
  authorize: Effect.Effect<void, E> = Effect.void,
) => {
  const source = stateDirectory(top)
  const target = stateDirectory(worktree)
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
                          yield* authorize
                          if (yield* fileExists(marker)) return
                          const entries = yield* workTreeEntries(top, env)
                          const moved: Array<Entry> = []
                          const copies: Array<Entry> = []
                          for (const entry of entries) {
                            // A link, device or socket in the work tree is not state.
                            if (!(yield* isPlainFile(source, entry.path))) continue
                            const to = join(target, entry.path)
                            yield* requirePlainTarget(target, entry.path)
                            const dirty = entry.status !== undefined && !entry.status.includes("D")
                            const there = (yield* kindAt(to)) !== undefined
                            const wanted =
                              !there || (dirty && !(yield* sameBytes(join(source, entry.path), to)))
                            if (wanted) copies.push(entry)
                            if (dirty && !entry.path.startsWith("local/")) moved.push(entry)
                          }
                          let started = false
                          const begin = Effect.suspend(() =>
                            started
                              ? Effect.void
                              : authorize.pipe(
                                  Effect.tap(() =>
                                    Effect.sync(() => {
                                      started = true
                                    }),
                                  ),
                                ),
                          )
                          yield* Effect.uninterruptible(
                            Effect.gen(function* () {
                              for (const entry of copies)
                                yield* copyInto(target, entry.path, join(source, entry.path), begin)
                              yield* commit(
                                "chore(state): migrate the state found in a work tree",
                                begin,
                              )
                              // Only what the state worktree now holds byte for byte leaves the work tree.
                              for (const entry of moved) {
                                const from = join(source, entry.path)
                                if (!(yield* sameBytes(from, join(target, entry.path)))) continue
                                const status = entry.status ?? ""
                                yield* begin
                                if (status === "??")
                                  yield* io(from, () => rm(from, { force: true }))
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
                              yield* begin
                              yield* io(source, () => rmdir(source)).pipe(Effect.ignore)
                              yield* io(marker, () =>
                                mkdir(dirname(marker), { recursive: true }).then(() =>
                                  writeFile(marker, ""),
                                ),
                              )
                            }),
                          )
                        }),
                        patience,
                        authorize,
                      ),
                ),
              ),
        ),
      ),
    ),
  )
}

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
      (ensure === "ifPresent" && (yield* keepsState(top, env, branch, listed)))
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
        if (source !== worktree && (yield* isDirectory(source))) {
          yield* authorize
          yield* migrateWorkTree(
            source,
            common,
            worktree,
            env,
            (message, begin) => commitState(directory, env, message, [], resolved, begin),
            patience,
            authorize,
          )
        }
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
