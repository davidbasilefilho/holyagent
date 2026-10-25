import { Context, Effect, Layer } from "effect"

import { Usage } from "../cli/errors.ts"
import { DetachedHead, GitFailed } from "./errors.ts"
import { type Env, spawn } from "./process.ts"

/** What a git command printed and how it ended. */
export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Git in the project: a command runner and a raw blob reader. */
export class Git extends Context.Service<
  Git,
  {
    /** Runs `git <args>` and reports how it ended; `env` adds to the environment of that run. */
    readonly run: (args: ReadonlyArray<string>, env?: Env) => Effect.Effect<GitResult>
    /** The bytes of a stored blob. */
    readonly blob: (oid: string) => Effect.Effect<Uint8Array, GitFailed>
  }
>()("holyagent/vcs/Git") {}

/** Git in `cwd`, run with the given environment on top of the process's own. */
export const gitLive = (cwd: string, env: Env) =>
  Layer.succeed(Git, {
    run: (args, extra = {}) =>
      spawn("git", args, { cwd, env: { ...process.env, ...env, ...extra } }).pipe(
        Effect.map(({ code, stdout, stderr }) => ({
          code,
          stdout: new TextDecoder().decode(stdout),
          stderr,
        })),
      ),
    blob: (oid) =>
      spawn("git", ["cat-file", "blob", oid], { cwd, env: { ...process.env, ...env } }).pipe(
        Effect.filterOrFail(
          ({ code }) => code === 0,
          ({ code, stderr }) =>
            new GitFailed({ args: ["cat-file", "blob", oid], code, output: stderr }),
        ),
        Effect.map(({ stdout }) => stdout),
      ),
  })

const tail = (result: GitResult) =>
  `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-20).join("\n")

/** Runs git and returns its output, failing with GitFailed on a non-zero exit. */
export const git = (args: ReadonlyArray<string>, env?: Env) =>
  Git.use((service) => service.run(args, env)).pipe(
    Effect.filterOrFail(
      ({ code }) => code === 0,
      (result) => new GitFailed({ args, code: result.code, output: tail(result) }),
    ),
    Effect.map(({ stdout }) => stdout.trim()),
  )

/** Runs git and returns its output when it succeeded, else undefined. */
export const gitMaybe = (args: ReadonlyArray<string>) =>
  Git.use((service) => service.run(args)).pipe(
    Effect.map(({ code, stdout }) => (code === 0 ? stdout.trim() : undefined)),
  )

/** Runs a pathspec command with paths read literally, so a name with `*` is that file. */
export const gitPaths = (args: ReadonlyArray<string>, paths: ReadonlyArray<string>) =>
  git(["--literal-pathspecs", ...args, "--", ...paths])

/**
 * A branch name git accepts as it is written. One that starts with a dash would read as an option
 * and one that starts with a plus would turn a push refspec into a forced one.
 */
export const validBranch = (name: string): Effect.Effect<string, Usage, Git> =>
  Effect.gen(function* () {
    const plain = !name.startsWith("-") && !name.startsWith("+")
    if (plain && (yield* gitMaybe(["check-ref-format", "--branch", name])) === name) return name
    return yield* new Usage({
      message: `"${name}" is not a plain branch name`,
      hint: "Name branches without a leading dash or plus, such as feature/parser.",
    })
  })

/** The branch HEAD is on, when its name is one that is safe to hand to git and GitHub. */
export const currentBranch: Effect.Effect<string, DetachedHead | Usage, Git> = Effect.gen(
  function* () {
    const branch = yield* gitMaybe(["symbolic-ref", "--short", "-q", "HEAD"])
    if (branch === undefined || branch === "") return yield* new DetachedHead()
    return yield* validBranch(branch)
  },
)

/** The URL with any user name or password removed, so it is safe to keep and to print. */
export const stripUserinfo = (url: string): string =>
  url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1")

/**
 * The URL `origin` really fetches from (`git remote get-url`, so `insteadOf` rewrites apply) with
 * any user name or password removed, or empty text when there is no origin. This is the form that
 * is checked for its host and slug, stored and printed.
 */
export const originUrl = gitMaybe(["remote", "get-url", "origin"]).pipe(
  Effect.map((url) => stripUserinfo(url ?? "")),
)

/** The `owner/repo` a remote URL names, in https, scp-like, ssh and local-proxy forms. */
export const repoSlug = (url: string): string | undefined => {
  const match = /([^/:]+)\/([^/]+?)(?:\.git)?\/*$/.exec(url.trim())
  if (match === null) return undefined
  const [, owner = "", repo = ""] = match
  const dots = new Set([".", ".."])
  return dots.has(owner) || dots.has(repo) || !/^[\w.-]+\/[\w.-]+$/.test(`${owner}/${repo}`)
    ? undefined
    : `${owner}/${repo}`
}
