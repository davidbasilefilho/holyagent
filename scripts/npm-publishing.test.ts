import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Exit } from "effect"

import { type NpmResult, type NpmRunner, publishArtifact } from "./npm-publishing.ts"

const ok = (stdout = "{}"): NpmResult => ({ exitCode: 0, stdout, stderr: "" })
const fail = (stdout: string, stderr = ""): NpmResult => ({ exitCode: 1, stdout, stderr })

describe("packed npm publication", () => {
  test("handles existing versions, errors, and tags using the actual packed identity and bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "npm-publish-test-"))
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-publish-artifact", version: "1.2.3-dev-0123456" }),
      )
      writeFileSync(join(dir, "index.js"), "export default 42\n")
      const packed = Bun.spawnSync(["bun", "pm", "pack", "--destination", dir], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(packed.exitCode).toBe(0)
      const path = join(dir, "test-publish-artifact-1.2.3-dev-0123456.tgz")
      const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(await Bun.file(path).arrayBuffer()).digest("base64")}`
      const identity = "test-publish-artifact@1.2.3-dev-0123456"
      const existing = ok(
        JSON.stringify({
          name: "test-publish-artifact",
          version: "1.2.3-dev-0123456",
          dist: { integrity },
        }),
      )
      const exercise = async (responses: NpmResult[], tag = "dev") => {
        const calls: string[][] = []
        const run: NpmRunner = (args) => {
          calls.push([...args])
          return Effect.succeed(responses.shift() ?? fail("", "unexpected command"))
        }
        const result = await Effect.runPromiseExit(publishArtifact(path, tag, run))
        return { result, calls }
      }
      const missing = await exercise([fail(JSON.stringify({ error: { code: "E404" } })), ok()])
      expect(Exit.isSuccess(missing.result)).toBe(true)
      expect(missing.calls).toEqual([
        ["view", identity, "--json"],
        ["publish", path, "--tag", "dev", "--provenance"],
      ])
      const same = await exercise([existing, ok(JSON.stringify({ dev: "1.2.3-dev-0123456" }))])
      expect(Exit.isSuccess(same.result)).toBe(true)
      expect(same.calls).toEqual([
        ["view", identity, "--json"],
        ["dist-tag", "ls", "test-publish-artifact", "--json"],
      ])
      const retag = await exercise([existing, ok(JSON.stringify({ dev: "1.2.2" }))])
      expect(Exit.isFailure(retag.result)).toBe(true)
      expect(retag.calls).toHaveLength(2)
      const newer = await exercise([
        existing,
        ok(JSON.stringify({ dev: "1.2.3-dev-abcdef0" })),
        ok(
          JSON.stringify({
            "1.2.3-dev-0123456": "2026-01-01T00:00:00Z",
            "1.2.3-dev-abcdef0": "2026-01-02T00:00:00Z",
          }),
        ),
      ])
      expect(Exit.isSuccess(newer.result)).toBe(true)
      expect(newer.calls.at(-1)).toEqual(["view", "test-publish-artifact", "time", "--json"])
      const timestamps = (theirs: string, ours = "2026-01-01T00:00:00Z") =>
        ok(JSON.stringify({ "1.2.3-dev-0123456": ours, "1.2.3-dev-abcdef0": theirs }))
      for (const [tags, time] of [
        ["{}", ok("{}")],
        ["not json", ok("{}")],
        [JSON.stringify({ dev: 42 }), ok("{}")],
        [
          JSON.stringify({ dev: "1.2.3" }),
          ok(
            JSON.stringify({
              "1.2.3-dev-0123456": "2026-01-01T00:00:00Z",
              "1.2.3": "2026-01-02T00:00:00Z",
            }),
          ),
        ],
        [
          JSON.stringify({ dev: "1.2.3-beta.1" }),
          ok(
            JSON.stringify({
              "1.2.3-dev-0123456": "2026-01-01T00:00:00Z",
              "1.2.3-beta.1": "2026-01-02T00:00:00Z",
            }),
          ),
        ],
        [JSON.stringify({ dev: "1.2.3-dev-abcdef0" }), ok("not json")],
        [JSON.stringify({ dev: "1.2.3-dev-abcdef0" }), ok("{}")],
        [JSON.stringify({ dev: "1.2.3-dev-abcdef0" }), timestamps("invalid")],
        [JSON.stringify({ dev: "1.2.3-dev-abcdef0" }), timestamps("2026-02-30T00:00:00Z")],
        [
          JSON.stringify({ dev: "1.2.3-dev-abcdef0" }),
          timestamps("2026-01-02T00:00:00Z", "invalid"),
        ],
        [JSON.stringify({ dev: "1.2.3-dev-abcdef0" }), timestamps("2026-01-01T00:00:00Z")],
        [JSON.stringify({ dev: "1.2.3-dev-abcdef0" }), timestamps("2025-12-31T00:00:00Z")],
        [JSON.stringify({ dev: "1.2.3-dev-abcdef0" }), fail("", "forbidden")],
      ] as const) {
        const rejected = await exercise([existing, ok(tags), time])
        expect(Exit.isFailure(rejected.result)).toBe(true)
        expect(rejected.calls.some((call) => call[0] === "publish" || call[0] === "add")).toBe(
          false,
        )
      }
      const wrongStable = await exercise(
        [
          existing,
          ok(JSON.stringify({ latest: "1.2.3-dev-abcdef0" })),
          timestamps("2026-01-02T00:00:00Z"),
        ],
        "latest",
      )
      expect(Exit.isFailure(wrongStable.result)).toBe(true)
      const unknownChannel = await exercise(
        [
          existing,
          ok(JSON.stringify({ custom: "1.2.3-dev-abcdef0" })),
          timestamps("2026-01-02T00:00:00Z"),
        ],
        "custom",
      )
      expect(Exit.isFailure(unknownChannel.result)).toBe(true)
      for (const [name, version] of [
        ["other", "1.2.3-dev-0123456"],
        ["test-publish-artifact", "1.2.3-dev-abcdef0"],
      ]) {
        const wrongIdentity = await exercise([
          ok(JSON.stringify({ name, version, dist: { integrity } })),
        ])
        expect(Exit.isFailure(wrongIdentity.result)).toBe(true)
      }
      const conflict = await exercise([
        ok(
          JSON.stringify({
            name: "test-publish-artifact",
            version: "1.2.3-dev-0123456",
            dist: { integrity: "sha512-different" },
          }),
        ),
      ])
      expect(Exit.isFailure(conflict.result)).toBe(true)
      expect(conflict.calls).toHaveLength(1)
      for (const response of [
        fail(JSON.stringify({ error: { code: "E401" } })),
        fail("", "network error"),
        fail(JSON.stringify({ error: { code: "E500" } })),
        fail("not json"),
      ]) {
        const error = await exercise([response])
        expect(Exit.isFailure(error.result)).toBe(true)
        expect(error.calls).toHaveLength(1)
      }
      expect(Exit.isFailure((await exercise([existing, fail("", "network error")])).result)).toBe(
        true,
      )
      expect(
        Exit.isFailure((await exercise([existing, ok("{}"), fail("", "forbidden")])).result),
      ).toBe(true)
      expect(
        Exit.isFailure(
          (
            await exercise([
              fail(JSON.stringify({ error: { code: "E404" } })),
              fail("", "publish denied"),
            ])
          ).result,
        ),
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("stable reruns only accept a later stable version with a later publication time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "npm-publish-stable-"))
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "test-stable", version: "1.2.3" }),
      )
      expect(
        Bun.spawnSync(["bun", "pm", "pack", "--destination", dir], { cwd: dir }).exitCode,
      ).toBe(0)
      const path = join(dir, "test-stable-1.2.3.tgz")
      const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(await Bun.file(path).arrayBuffer()).digest("base64")}`
      const existing = ok(
        JSON.stringify({ name: "test-stable", version: "1.2.3", dist: { integrity } }),
      )
      for (const [version, success] of [
        ["1.2.4", true],
        ["1.2.4-dev-abcdef0", false],
        ["1.2.2", false],
      ] as const) {
        const responses = [
          existing,
          ok(JSON.stringify({ latest: version })),
          ok(
            JSON.stringify({ "1.2.3": "2026-01-01T00:00:00Z", [version]: "2026-01-02T00:00:00Z" }),
          ),
        ]
        const calls: string[][] = []
        const run: NpmRunner = (args) => {
          calls.push([...args])
          return Effect.succeed(responses.shift() ?? fail("", "unexpected command"))
        }
        const result = await Effect.runPromiseExit(publishArtifact(path, "latest", run))
        expect(Exit.isSuccess(result)).toBe(success)
        expect(calls.some((call) => call[0] === "publish" || call[0] === "add")).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
