import { expect } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"
import { Effect, Layer, Schema } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { Vcs } from "../src/state/local.ts"
import { GitHubFailed } from "../src/vcs/errors.ts"
import { gitLive } from "../src/vcs/git.ts"
import { GitHub, type RestRequest } from "../src/vcs/github.ts"

/** Environment that keeps git off the machine's own configuration. */
export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
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

/** A bare repository standing in for GitHub's storage; `seedFrom` pushes a clone's main into it. */
export const initBare = async () => {
  const dir = await scratch("holyagent-vcs-remote-")
  const bare = join(dir, "remote.git")
  await sh(dir, ["git", "init", "-q", "--bare", "-b", "main", bare])
  return bare
}

/** The commit a branch of a repository points at, or undefined. */
export const headOf = async (repo: string, branch = "HEAD") => {
  const out = await $`git rev-parse -q --verify ${branch}`
    .cwd(repo)
    .env({ ...process.env, ...GIT_ENV })
    .quiet()
    .nothrow()
  return out.exitCode === 0 ? out.text().trim() : undefined
}

/** What a recorded call to the fake GitHub looked like. */
export interface Recorded {
  readonly kind: "rest" | "graphql"
  /** `METHOD path` for REST, `graphql` for GraphQL. */
  readonly route: string
  readonly body?: unknown
  readonly variables?: Readonly<Record<string, unknown>>
}

/** Builds a failure the way the live layer reports one. */
export const failure = (status: number, reason: string) =>
  new GitHubFailed({ what: "fake", status, reason })

/**
 * A GitHub that records every call. `rest` and `graphql` answer by route; an answer that is a
 * GitHubFailed fails the call, a function is called with the request, anything else is the body.
 */
export const fakeGitHub = (
  options: {
    rest?: (request: RestRequest) => unknown
    graphql?: (query: string, variables: Readonly<Record<string, unknown>>) => unknown
  } = {},
) => {
  const calls: Array<Recorded> = []
  const settle = (answer: unknown) =>
    Effect.promise(() => Promise.resolve(answer)).pipe(
      Effect.flatMap((value) =>
        value instanceof GitHubFailed ? Effect.fail(value) : Effect.succeed(value),
      ),
    )
  const layer = Layer.succeed(GitHub, {
    rest: (request) => {
      calls.push({
        kind: "rest",
        route: `${request.method} ${request.path}`,
        body: request.body,
      })
      const answer = options.rest?.(request)
      return answer === undefined ? Effect.fail(failure(404, "Not Found")) : settle(answer)
    },
    graphql: (query, variables) => {
      calls.push({ kind: "graphql", route: "graphql", variables })
      return settle(
        options.graphql === undefined
          ? failure(403, "no graphql")
          : options.graphql(query, variables),
      )
    },
  })
  return { layer, calls, routes: () => calls.map((call) => call.route) }
}

/** The answer of `GET user`. */
export const user = (over: Record<string, unknown> = {}) => ({
  login: "octo",
  id: 42,
  name: "Octo Cat",
  email: null,
  ...over,
})

/** The answer of `GET commits/{sha}`. */
export const commitView = (over: { login?: string | null; verified?: boolean } = {}) => ({
  sha: "ignored",
  author: over.login === null ? null : { login: over.login ?? "octo" },
  commit: {
    verification: {
      verified: over.verified ?? true,
      reason: over.verified === false ? "unsigned" : "valid",
    },
  },
})

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

/** Builds the change a fake createCommitOnBranch applies to a bare repository. */
const bareCommit = async (
  bare: string,
  parent: string | undefined,
  branch: string,
  message: string,
  additions: ReadonlyArray<{ path: string; contents: string }>,
  deletions: ReadonlyArray<{ path: string }>,
) => {
  const index = join(bare, "fake.index")
  const env = {
    GIT_DIR: bare,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "Octo Cat",
    GIT_AUTHOR_EMAIL: "octo@users.noreply.github.com",
    GIT_COMMITTER_NAME: "GitHub",
    GIT_COMMITTER_EMAIL: "noreply@github.com",
  }
  await rm(index, { force: true })
  if (parent !== undefined) await sh(bare, ["git", "read-tree", parent], env)
  for (const { path, contents } of additions) {
    const blob = (
      await $`git hash-object -w --stdin < ${new Response(Buffer.from(contents, "base64"))}`
        .cwd(bare)
        .env({ ...process.env, ...GIT_ENV, ...env })
        .quiet()
        .text()
    ).trim()
    await sh(bare, ["git", "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env)
  }
  for (const { path } of deletions)
    await $`git update-index --index-info < ${new Response(`0 ${"0".repeat(40)}\t${path}\n`)}`
      .cwd(bare)
      .env({ ...process.env, ...GIT_ENV, ...env })
      .quiet()
  const tree = (await sh(bare, ["git", "write-tree"], env)).trim()
  const commit = (
    await sh(
      bare,
      ["git", "commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", message],
      env,
    )
  ).trim()
  await sh(bare, ["git", "update-ref", `refs/heads/${branch}`, commit], env)
  return commit
}

/**
 * GitHub's side of the API commit endpoints, backed by a bare repository: branches, refs, the
 * contents endpoint for an empty repository and createCommitOnBranch with its expectedHeadOid
 * check.
 */
export const bareBackedGitHub = (bare: string, view: () => unknown = () => commitView()) =>
  fakeGitHub({
    rest: async (request) => {
      const [, route = ""] = /^repos\/[^/]+\/[^/]+\/(.*)$/.exec(request.path) ?? []
      if (request.path === "user") return user()
      const ref = /^git\/ref\/heads\/(.+)$/.exec(route)
      if (ref?.[1] !== undefined) {
        const sha = await headOf(bare, `refs/heads/${ref[1]}`)
        return sha === undefined ? failure(404, "Not Found") : { object: { sha } }
      }
      if (route.startsWith("branches"))
        return (await sh(bare, ["git", "branch", "--list"])).trim() === "" ? [] : [{}]
      if (request.method === "POST" && route === "git/refs") {
        const body = request.body as { ref: string; sha: string }
        await sh(bare, ["git", "update-ref", body.ref, body.sha])
        return {}
      }
      const put = /^contents\/(.+)$/.exec(route)
      if (request.method === "PUT" && put?.[1] !== undefined) {
        const body = request.body as { message: string; content: string; branch: string }
        const commit = await bareCommit(
          bare,
          undefined,
          body.branch,
          body.message,
          [{ path: decodeURIComponent(put[1]), contents: body.content }],
          [],
        )
        return { commit: { sha: commit } }
      }
      if (route.startsWith("commits/")) return view()
      return undefined
    },
    graphql: async (query, variables) => {
      if (!query.includes("createCommitOnBranch")) return { viewer: { login: "octo" } }
      const input = variables["input"] as {
        branch: { branchName: string }
        expectedHeadOid: string
        message: { headline: string; body?: string }
        fileChanges: {
          additions: Array<{ path: string; contents: string }>
          deletions: Array<{ path: string }>
        }
      }
      const head = await headOf(bare, `refs/heads/${input.branch.branchName}`)
      if (head !== input.expectedHeadOid)
        return failure(422, "Expected branch to point to the expected head")
      const message = [input.message.headline, input.message.body].filter(Boolean).join("\n\n")
      const oid = await bareCommit(
        bare,
        head,
        input.branch.branchName,
        message,
        input.fileChanges.additions,
        input.fileChanges.deletions,
      )
      return { createCommitOnBranch: { commit: { oid } } }
    },
  })

/** The per-clone `vcs.json` of a project, decoded. */
export const readVcs = async (dir: string) =>
  Schema.decodeUnknownSync(Vcs)(await Bun.file(join(dir, ".holyagent/local/vcs.json")).json())
