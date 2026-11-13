import { describe, expect, test } from "bun:test"
import { mkdtempSync as createTemp, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Effect, Exit } from "effect"

import { type NpmResult, type NpmRunner, publishArtifact, PublishError } from "./npm-publishing.ts"

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
          publishArtifact(path, tag, context, run, request),
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
        const result = await exercise(github, [missing, ok()])
        expect(Exit.isSuccess(result.result)).toBe(true)
        expect(result.urls[1]).toEndWith(`/git/ref/tags/${context.tag}`)
        expect(result.calls).toEqual([
          ["view", "test-publish-artifact@1.2.3-dev-0123456", "--json"],
          ["publish", path, "--tag", "dev", "--provenance"],
        ])
      }
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
        Exit.isFailure((await exercise(absent(), [missing, fail("", "publish denied")])).result),
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
