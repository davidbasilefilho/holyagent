import { expect } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"
import { Effect, Layer } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { GitHubFailed } from "../src/vcs/errors.ts"
import { gitLive } from "../src/vcs/git.ts"
import { GitHub, type RestRequest } from "../src/vcs/github.ts"

/** Environment that keeps git off the machine's own configuration. */
export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  // Sandboxes may inject url rewrites through the environment; tests talk to local repositories only.
  GIT_CONFIG_COUNT: "0",
} as const

/** Runs a command in a directory with the hermetic git environment and returns its text. */
export const sh = (cwd: string, command: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  $`${command}`
    .cwd(cwd)
    .env({ ...process.env, ...GIT_ENV, ...env })
    .quiet()
    .text()

/** Scratch directories, removed by `cleanup`. */
const made: Array<string> = []

/** A new empty directory. */
export const scratch = async (prefix = "holyagent-vcs-") => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** Removes every scratch directory. */
export const cleanup = async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** A repository on `main` with a committer identity; returns its directory. */
export const initRepo = async (
  identity: { name: string; email: string } = { name: "Octo Cat", email: "octo@example.com" },
) => {
  const dir = await scratch()
  await sh(dir, ["git", "init", "-q", "-b", "main", "."])
  await sh(dir, ["git", "config", "user.name", identity.name])
  await sh(dir, ["git", "config", "user.email", identity.email])
  return dir
}

/** Writes files (path to content) below a directory. */
export const put = async (dir: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true })
    await writeFile(join(dir, path), content)
  }
}

/** Commits everything with a fixed message and returns the new HEAD. */
export const seed = async (dir: string, files: Record<string, string>) => {
  await put(dir, files)
  await sh(dir, ["git", "add", "-A"])
  await sh(dir, ["git", "commit", "-q", "-m", "seed"])
  return (await sh(dir, ["git", "rev-parse", "HEAD"])).trim()
}

/** What a recorded call to the fake GitHub looked like. */
export interface Recorded {
  /** `METHOD path`. */
  readonly route: string
  readonly body?: unknown
}

/** Builds a failure the way the live layer reports one. */
export const failure = (status: number, reason: string) =>
  new GitHubFailed({ what: "fake", status, reason })

/**
 * A GitHub that records every call. `rest` answers by route; an answer that is a GitHubFailed fails
 * the call, anything else is the body, and none is a 404.
 */
export const fakeGitHub = (options: { rest?: (request: RestRequest) => unknown } = {}) => {
  const calls: Array<Recorded> = []
  const layer = Layer.succeed(GitHub, {
    rest: (request) => {
      calls.push({ route: `${request.method} ${request.path}`, body: request.body })
      const answer = options.rest?.(request)
      return answer === undefined
        ? Effect.fail(failure(404, "Not Found"))
        : answer instanceof GitHubFailed
          ? Effect.fail(answer)
          : Effect.succeed(answer)
    },
  })
  return { layer, calls, routes: () => calls.map((call) => call.route) }
}

/** Runs one command line in `cwd` against the given GitHub layer, collecting what it printed. */
export const vcs = async (
  cwd: string,
  argv: ReadonlyArray<string>,
  github: Layer.Layer<GitHub>,
  stdin?: unknown,
) => {
  const env = {}
  const written: Array<string> = []
  const result = await Effect.runPromise(
    run(argv, {
      cwd,
      env: { HOME: cwd, ...GIT_ENV, ...env },
      stdin:
        stdin === undefined
          ? Effect.fail(new StdinMissing({ reason: "no stdin in this test" }))
          : Effect.succeed(JSON.stringify(stdin)),
      vcs: Layer.merge(gitLive(cwd, { HOME: cwd, ...GIT_ENV, ...env }), github),
      emit: (text) => Effect.sync(() => void written.push(text)),
    }),
  )
  return { ...result, stdout: written.join("") + result.stdout }
}

/** Decodes the TOON a successful command printed. */
export const toon = (result: { stdout: string; stderr: string; code: number }) => {
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  return decode(result.stdout) as Record<string, unknown>
}
