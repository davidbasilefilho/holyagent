import { describe, expect, test } from "bun:test"
import { mkdtempSync as createTemp, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Effect, Exit } from "effect"

import { type NpmResult, type NpmRunner, publishArtifact, PublishError } from "./npm-publishing.ts"
import { DevPublicationError, type verifyDevPublication } from "./verify-dev-publication.ts"

// Refuse fixtures under an existing repository, even when the system temp directory is overridden.
const mkdtempSync = (prefix: string) => {
  const dir = createTemp(prefix)
  const probe = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (probe.exitCode !== 128) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error("Fixture temp directory is inside a Git repository or Git is unavailable")
  }
  return dir
}

const ok = (stdout = "{}"): NpmResult => ({ exitCode: 0, stdout, stderr: "" })
const fail = (stdout: string, stderr = ""): NpmResult => ({ exitCode: 1, stdout, stderr })
const commit = "a".repeat(40)
const other = "b".repeat(40)
const context = {
  repository: "owner/repo",
  tag: "holyagent-1.2.3-dev-0123456",
  commit,
  token: "test",
}
const object = (type: string, sha: string) => Response.json({ object: { type, sha } })
const devHead = (sha = commit, isProtected = true) =>
  Response.json({ name: "dev", protected: isProtected, commit: { sha } })
const devTag = (dev = "1.2.3-dev-0123456") => Response.json({ dev })

describe("packed npm publication", () => {
  test("rejects absent or mismatched repository metadata before network or npm operations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "npm-metadata-"))
    try {
      const valid = {
        type: "git",
        url: "https://github.com/owner/repo",
        directory: "packages/integrations/pi/dist",
      }
      for (const repository of [
        undefined,
        "https://github.com/owner/repo",
        { ...valid, type: "svn" },
        { ...valid, url: "https://github.com/other/repo" },
        { ...valid, directory: "other" },
      ]) {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "x", version: "1.0.0", repository }),
        )
        expect(
          Bun.spawnSync(["bun", "pm", "pack", "--destination", dir], { cwd: dir }).exitCode,
        ).toBe(0)
        let called = false
        const result = await Effect.runPromiseExit(
          publishArtifact(
            join(dir, "x-1.0.0.tgz"),
            "dev",
            context,
            () => {
              called = true
              return Effect.succeed(ok())
            },
            () => {
              called = true
              return Promise.resolve(new Response("{}"))
            },
          ),
        )
        expect(Exit.isFailure(result)).toBe(true)
        expect(called).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("preflights the exact tag and rejects unsafe registry states without publishing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "npm-publish-test-"))
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "test-publish-artifact",
          version: "1.2.3-dev-0123456",
          repository: {
            type: "git",
            url: "https://github.com/owner/repo",
            directory: "packages/integrations/pi/dist",
          },
        }),
      )
      expect(
        Bun.spawnSync(["bun", "pm", "pack", "--destination", dir], { cwd: dir }).exitCode,
      ).toBe(0)
      const path = join(dir, "test-publish-artifact-1.2.3-dev-0123456.tgz")
      const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(await Bun.file(path).arrayBuffer()).digest("base64")}`
      const existing = ok(
        JSON.stringify({
          name: "test-publish-artifact",
          version: "1.2.3-dev-0123456",
          dist: { integrity },
        }),
      )
      const missing = fail(JSON.stringify({ error: { code: "E404" } }))
      const exercise = async (github: Response[], responses: NpmResult[], tag = "dev") => {
        const calls: string[][] = []
        const urls: string[] = []
        const run: NpmRunner = (args) => {
          calls.push([...args])
          return Effect.succeed(responses.shift() ?? fail("", "unexpected command"))
        }
        const request = (input: string) => {
          urls.push(input)
          return Promise.resolve(github.shift() ?? new Response("", { status: 500 }))
        }
        const result = await Effect.runPromiseExit(
          publishArtifact(path, tag, context, run, request, Effect.void),
        )
        return { result, calls, urls }
      }
      const absent = () => [new Response("{}"), new Response("", { status: 404 })]
      const callsAfterNetworkError: string[][] = []
      const networkError = await Effect.runPromiseExit(
        publishArtifact(
          path,
          "dev",
          context,
          (args) => {
            callsAfterNetworkError.push([...args])
            return Effect.succeed(ok())
          },
          () => Promise.reject(new Error("network error")),
        ),
      )
      expect(Exit.isFailure(networkError)).toBe(true)
      expect(callsAfterNetworkError).toEqual([])
      for (const github of [
        absent(),
        [new Response("{}"), object("commit", commit)],
        [new Response("{}"), object("tag", other), object("commit", commit)],
      ]) {
        const result = await exercise([...github, devHead(), devTag(), devHead()], [missing, ok()])
        expect(Exit.isSuccess(result.result)).toBe(true)
        expect(result.urls[1]).toEndWith(`/git/ref/tags/${context.tag}`)
        expect(result.calls).toEqual([
          ["view", "test-publish-artifact@1.2.3-dev-0123456", "--json"],
          ["publish", path, "--tag", "dev", "--provenance", "--ignore-scripts"],
        ])
        expect(result.urls.at(-3)).toEndWith("/branches/dev")
        expect(result.urls.at(-2)).toEndWith("/dist-tags")
        expect(result.urls.at(-1)).toEndWith("/branches/dev")
      }
      for (const stale of [
        devHead(other),
        devHead(commit, false),
        new Response("", { status: 403 }),
      ]) {
        const result = await exercise([...absent(), stale], [missing, ok()])
        expect(Exit.isFailure(result.result)).toBe(true)
        expect(result.calls).toEqual([
          ["view", "test-publish-artifact@1.2.3-dev-0123456", "--json"],
        ])
      }
      for (const after of [
        [devTag("unexpected"), devHead()],
        [devTag(), devHead(other)],
      ]) {
        const result = await exercise([...absent(), devHead(), ...after], [missing, ok()])
        expect(Exit.isFailure(result.result)).toBe(true)
        expect(result.calls.map(([command]) => command)).toEqual(["view", "publish"])
      }
      const propagated = await exercise(
        [...absent(), devHead(), devTag("previous"), devHead(), devTag(), devHead()],
        [missing, ok()],
      )
      expect(Exit.isSuccess(propagated.result)).toBe(true)
      expect(propagated.calls.map(([command]) => command)).toEqual(["view", "publish"])
      for (const github of [
        [new Response("{}"), object("commit", other)],
        [new Response("{}"), object("tag", other), object("commit", other)],
        [new Response("{}"), object("tag", other), new Response("", { status: 500 })],
        [new Response("{}"), new Response("", { status: 500 })],
        [new Response("", { status: 404 })],
        [new Response("{}"), new Response("invalid")],
      ]) {
        const result = await exercise(github, [missing, ok()])
        expect(Exit.isFailure(result.result)).toBe(true)
        expect(result.calls).toEqual([])
      }
      const nested = await exercise(
        [
          new Response("{}"),
          object("tag", other),
          object("tag", "c".repeat(40)),
          object("commit", commit),
        ],
        [missing, ok()],
      )
      expect(nested.calls.some(([command]) => command === "publish")).toBe(false)
      expect(nested.calls).toEqual([])
      expect(Exit.isFailure(nested.result)).toBe(true)
      for (const tag of ["dev", "latest", "custom"]) {
        const result = await exercise(absent(), [existing], tag)
        expect(Exit.isFailure(result.result)).toBe(true)
        if (Exit.isFailure(result.result)) {
          const error = Cause.squash(result.result.cause)
          expect(error).toBeInstanceOf(PublishError)
          if (error instanceof PublishError)
            expect(error.detail).toContain("trusted provenance cannot currently be established")
        }
        expect(result.calls).toEqual([
          ["view", "test-publish-artifact@1.2.3-dev-0123456", "--json"],
        ])
      }
      for (const response of [
        ok("not json"),
        ok(JSON.stringify({ name: 42 })),
        fail(JSON.stringify({ error: { code: "E401" } })),
        fail("", "network error"),
        fail("not json"),
      ]) {
        const result = await exercise(absent(), [response])
        expect(Exit.isFailure(result.result)).toBe(true)
        expect(result.calls).toHaveLength(1)
      }
      expect(
        Exit.isFailure(
          (await exercise([...absent(), devHead()], [missing, fail("", "publish denied")])).result,
        ),
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("protected dev publication recovery", () => {
  const version = "0.4.0-dev.2026-11-27.20-54-33.ga371bbd"
  const devCommit = `a371bbd${"a".repeat(33)}`
  const devContext = {
    repository: "davidbasilefilho/holyagent",
    tag: `holyagent-${version}`,
    commit: devCommit,
    token: "test",
  }
  const staged = (
    value = version,
    code = "E409",
    registry = "https://registry.npmjs.org/holyagent",
  ) =>
    fail(
      "",
      `npm error code ${code}\nnpm error 409 Conflict - PUT ${registry} - Cannot publish over previously staged version "${value}".\nnpm error A complete log of this run can be found in: /tmp/npm-debug.log\n`,
    )
  const missing = fail(JSON.stringify({ error: { code: "E404" } }))

  test("only resumes an exact immutable dev publication on the current protected head", async () => {
    const dir = mkdtempSync(join(tmpdir(), "npm-dev-recovery-"))
    try {
      const manifest = {
        name: "holyagent",
        version,
        repository: {
          type: "git",
          url: `https://github.com/${devContext.repository}`,
          directory: "packages/integrations/pi/dist",
        },
      }
      writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
      expect(
        Bun.spawnSync(["bun", "pm", "pack", "--destination", dir], { cwd: dir }).exitCode,
      ).toBe(0)
      const path = join(dir, `holyagent-${version}.tgz`)
      const contents = await Bun.file(path).arrayBuffer()
      const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(contents).digest("base64")}`
      const metadata = { name: manifest.name, version, dist: { integrity } }
      const existing = ok(JSON.stringify(metadata))
      type Scenario = {
        responses?: NpmResult[]
        channels?: string[]
        branches?: Response[]
        refs?: Response[]
        errors?: DevPublicationError[]
        tag?: string
        context?: typeof devContext
      }
      const exercise = async ({
        responses = [existing],
        channels = [],
        branches = [],
        refs = [],
        errors = [],
        tag = "dev",
        context: target = devContext,
      }: Scenario = {}) => {
        const calls: string[][] = []
        const requests: string[] = []
        const verified: Parameters<typeof verifyDevPublication>[] = []
        let waits = 0
        const run: NpmRunner = (args) => {
          calls.push([...args])
          return Effect.succeed(responses.shift() ?? fail("", "unexpected command"))
        }
        const request = (url: string, init: RequestInit) => {
          expect(init.method ?? "GET").toBe("GET")
          requests.push(url)
          if (url.endsWith("/branches/dev"))
            return Promise.resolve(branches.shift() ?? devHead(devCommit))
          if (url.endsWith("/dist-tags"))
            return Promise.resolve(devTag(channels.shift() ?? version))
          if (url.includes("/git/ref/tags/"))
            return Promise.resolve(refs.shift() ?? new Response("", { status: 404 }))
          if (url === `https://api.github.com/repos/${target.repository}`)
            return Promise.resolve(new Response("{}"))
          return Promise.reject(new Error(`Unexpected request ${url}`))
        }
        const verify: typeof verifyDevPublication = (file, identity) => {
          verified.push([file, identity])
          const error = errors.shift()
          return error === undefined
            ? Effect.succeed({ runId: 123, attempt: 1, sha256: "0".repeat(64) })
            : Effect.fail(error)
        }
        const exit = await Effect.runPromiseExit(
          publishArtifact(
            path,
            tag,
            target,
            run,
            request,
            Effect.sync(() => {
              waits++
            }),
            verify,
          ),
        )
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        return { calls, error, requests, verified, waits }
      }
      const view = ["view", `holyagent@${version}`, "--json"]
      const publish = ["publish", path, "--tag", "dev", "--provenance", "--ignore-scripts"]
      const verification: Parameters<typeof verifyDevPublication> = [
        path,
        { repository: devContext.repository, commit: devCommit, version },
      ]
      const retained = await exercise()
      expect(retained.error).toBeUndefined()
      expect(retained.calls).toEqual([view])
      expect(retained.waits).toBe(0)
      expect(retained.verified).toEqual([verification])
      expect(
        retained.requests.filter((url) => url.endsWith(`/git/ref/tags/${devContext.tag}`)),
      ).toHaveLength(2)
      expect(retained.requests.at(-1)).toEndWith("/branches/dev")

      const delayed = await exercise({
        responses: [missing, staged()],
        channels: ["old", version, version, version],
        errors: [
          new DevPublicationError({
            detail: "Exact version still returning HTTP 404",
            pending: true,
          }),
        ],
        refs: [object("commit", devCommit), object("commit", devCommit)],
      })
      expect(delayed.error).toBeUndefined()
      expect(delayed.calls).toEqual([view, publish])
      expect(delayed.verified).toEqual([verification, verification])
      expect(delayed.waits).toBe(2)

      const invisible = await exercise({
        responses: [missing, staged()],
        channels: Array<string>(17).fill("old"),
      })
      expect(invisible.error).toMatchObject({
        detail: expect.stringContaining("within the readback window"),
      })
      expect(invisible.calls).toEqual([view, publish])
      expect(invisible.verified).toEqual([])
      expect(invisible.waits).toBe(16)

      for (const rejected of [
        staged(`${version}-other`),
        staged(version, "E403"),
        staged(version, "E409", "https://other.example/holyagent"),
        fail("", "npm error code E409\nnpm error 409 arbitrary conflict"),
      ]) {
        const result = await exercise({ responses: [missing, rejected] })
        expect(result.error).toMatchObject({
          detail: expect.stringContaining("npm publish failed"),
        })
        expect(result.calls).toEqual([view, publish])
        expect(result.verified).toEqual([])
        expect(result.requests.filter((url) => url.endsWith("/branches/dev"))).toHaveLength(1)
      }

      for (const candidate of [
        { ...metadata, name: "other" },
        { ...metadata, version: `${version}-other` },
        { ...metadata, dist: { integrity: "sha512-something-else" } },
      ]) {
        const result = await exercise({ responses: [ok(JSON.stringify(candidate))] })
        expect(result.error).toBeInstanceOf(PublishError)
        expect(result.calls).toEqual([view])
        expect(result.verified).toEqual([])
      }

      for (const scenario of [
        { tag: "latest" },
        { tag: "custom" },
        { context: { ...devContext, tag: "holyagent-other-version" } },
        { context: { ...devContext, commit: other } },
      ]) {
        const result = await exercise(scenario)
        expect(result.error).toMatchObject({
          detail: expect.stringContaining("trusted provenance cannot currently be established"),
        })
        expect(result.calls).toEqual([view])
        expect(result.verified).toEqual([])
      }

      const unaudited = await exercise({
        errors: [
          new DevPublicationError({ detail: "signed provenance commit mismatch", pending: false }),
        ],
      })
      expect(unaudited.error).toMatchObject({
        detail: expect.stringContaining("signed provenance commit mismatch"),
      })
      expect(unaudited.calls).toEqual([view])
      expect(unaudited.waits).toBe(0)
      expect(unaudited.verified).toEqual([verification])

      for (const branches of [[devHead(other)], [devHead(devCommit, false)]]) {
        const result = await exercise({ branches })
        expect(result.error).toBeDefined()
        expect(result.calls).toEqual([view])
        expect(result.verified).toEqual([])
      }

      for (const scenario of [
        { branches: [devHead(devCommit), devHead(other)], detail: "The dev head moved" },
        {
          refs: [object("commit", devCommit), object("commit", other)],
          detail: "conflicts with expected commit",
        },
        { channels: [version, "other"], detail: "The npm dev channel moved" },
      ]) {
        const result = await exercise(scenario)
        expect(result.error).toMatchObject({ detail: expect.stringContaining(scenario.detail) })
        expect(result.calls).toEqual([view])
        expect(result.verified).toEqual([verification])
      }

      const drift = await exercise({
        responses: [missing, staged()],
        channels: ["old"],
        branches: [devHead(devCommit), devHead(devCommit), devHead(other)],
      })
      expect(drift.error).toMatchObject({ detail: expect.stringContaining("The dev head moved") })
      expect(drift.calls).toEqual([view, publish])
      expect(drift.verified).toEqual([])
      expect(drift.waits).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
