import { expect, test } from "bun:test"

import { Effect } from "effect"

import { executePreview, type PreviewExecution } from "./npm-preview-execute.ts"
import { type PreviewEvidence, previewVersion } from "./npm-preview.ts"

const head = "1".repeat(40)
const source = "2".repeat(40)
const time = "2026-11-27T13:18:42Z"
const archive = new Uint8Array([1, 2, 3])
const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(archive).digest("base64")}`
const version = previewVersion("0.4.0", 172, time, head)
const stage = { op: "stage", source, number: 172, head } as const
const promote = { op: "tag", source, change: { op: "add", tag: "pr-172", version } } as const

const fixture = () => {
  let evidence: PreviewEvidence = {
    repository: "davidbasilefilho/holyagent",
    source: { sha: source, checkout: source, protected: true },
    complete: true,
    trustedReviewers: ["owner"],
    tags: { latest: "0.3.4", dev: "0.4.0-dev.1" },
    candidates: [
      {
        number: 172,
        open: true,
        draft: false,
        base: "dev",
        head: "fix/setup",
        sha: head,
        sameRepository: true,
        author: "contributor",
        committerUtc: time,
        baseVersion: "0.4.0",
        controls: { source, sha: head, unchanged: true },
        reviews: [{ reviewer: "owner", sha: head, state: "APPROVED" }],
        validation: { sha: head, state: "success" },
        artifact: { sha: head, expectedIntegrity: integrity, registryIntegrity: null },
      },
    ],
  }
  const calls: string[] = []
  const change = (update: (current: PreviewEvidence) => PreviewEvidence) => {
    evidence = update(evidence)
  }
  const io: PreviewExecution = {
    evidence: () => Effect.succeed(evidence),
    pack: (number, sha, utc) =>
      Effect.sync(() => {
        calls.push(`pack ${number} ${sha} ${utc}`)
        return { version, archive }
      }),
    publish: (published, bytes, tag) =>
      Effect.sync(() => {
        expect(bytes).toEqual(archive)
        expect(tag).toBe(`pr-staged-172-${head}`)
        calls.push(`publish ${published}`)
        change((snapshot) => ({
          ...snapshot,
          tags: { ...snapshot.tags, [tag]: published },
          candidates: snapshot.candidates.map((candidate) => ({
            ...candidate,
            artifact: { sha: head, expectedIntegrity: integrity, registryIntegrity: integrity },
          })),
        }))
      }),
    tag: (operation) =>
      Effect.sync(() => {
        calls.push(`tag ${operation.tag}`)
        const tags = { ...evidence.tags }
        if (operation.op === "add") tags[operation.tag] = operation.version
        else delete tags[operation.tag]
        change((previous) => ({ ...previous, tags }))
      }),
  }
  return { io, calls, change, observed: () => evidence }
}

test("immutable publication and verified promotion are separate and isolated from dev/latest", async () => {
  const x = fixture()
  expect(await Effect.runPromise(executePreview(stage, x.io))).toBe("stage-verified")
  expect(x.observed().tags).not.toHaveProperty("pr")
  expect(x.observed().tags).not.toHaveProperty("pr-172")
  expect(await Effect.runPromise(executePreview(stage, x.io))).toBe("already-staged")
  expect(await Effect.runPromise(executePreview(promote, x.io))).toBe("tag-verified")
  expect(
    await Effect.runPromise(
      executePreview({ ...promote, change: { ...promote.change, tag: "pr" } }, x.io),
    ),
  ).toBe("tag-verified")
  expect(x.observed().tags).toMatchObject({
    pr: version,
    "pr-172": version,
    latest: "0.3.4",
    dev: "0.4.0-dev.1",
  })
  expect(x.calls.map((line) => line.split(" ")[0])).toEqual(["pack", "publish", "tag", "tag"])
})

test("a stale force-push or modified archive never reaches a writer", async () => {
  const x = fixture()
  const original = x.io.pack
  const race = {
    ...x.io,
    pack: (...args: Parameters<PreviewExecution["pack"]>) =>
      original(...args).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            x.change((before) => ({
              ...before,
              candidates: before.candidates.map((candidate) => ({
                ...candidate,
                sha: "3".repeat(40),
              })),
            })),
          ),
        ),
      ),
  }
  const altered = { ...x.io, pack: () => Effect.succeed({ version, archive: new Uint8Array([0]) }) }
  await expect(Effect.runPromise(executePreview(stage, altered))).rejects.toMatchObject({
    detail: expect.stringContaining("not the reviewed"),
  })
  await expect(Effect.runPromise(executePreview(stage, race))).rejects.toMatchObject({
    detail: expect.stringContaining("moved while staging"),
  })
  expect(x.calls).toHaveLength(1)
  expect(x.observed().tags).toEqual({ latest: "0.3.4", dev: "0.4.0-dev.1" })
})

test("pending packages and arbitrary tag names cannot be requested for promotion", async () => {
  const x = fixture()
  await expect(Effect.runPromise(executePreview(promote, x.io))).rejects.toMatchObject({
    detail: expect.stringContaining("no longer matches"),
  })
  await Effect.runPromise(executePreview(stage, x.io))
  for (const tag of ["latest", "dev", "pr-171", "arbitrary"]) {
    const request = { ...promote, change: { ...promote.change, tag } }
    await expect(Effect.runPromise(executePreview(request, x.io))).rejects.toMatchObject({
      detail: expect.stringContaining("no longer matches"),
    })
  }
  expect(x.calls.some((line) => line.startsWith("tag "))).toBe(false)
})

test("a failed or misdirected registry write is reported rather than retried or treated as success", async () => {
  const x = fixture()
  const noWrite = { ...x.io, publish: () => Effect.void }
  await expect(Effect.runPromise(executePreview(stage, noWrite))).rejects.toMatchObject({
    detail: expect.stringContaining("readback disagreed"),
  })
  await Effect.runPromise(executePreview(stage, x.io))
  const wrongTag = {
    ...x.io,
    tag: () =>
      Effect.sync(() =>
        x.change((snapshot) => ({ ...snapshot, tags: { ...snapshot.tags, "pr-171": version } })),
      ),
  }
  await expect(Effect.runPromise(executePreview(promote, wrongTag))).rejects.toMatchObject({
    _tag: "PreviewBlocked",
  })
  expect(x.observed().tags["pr-172"]).toBeUndefined()
})
