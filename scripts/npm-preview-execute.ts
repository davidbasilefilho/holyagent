import { Effect } from "effect"

import {
  planPreview,
  PreviewBlocked,
  type PreviewChange,
  type PreviewEvidence,
  verifyPreviewTransition,
} from "./npm-preview.ts"

/** The exact protected source and one operation reviewed by a preview operator. */
export type PreviewOperation =
  | {
      readonly op: "stage"
      readonly source: string
      readonly number: number
      readonly head: string
    }
  | { readonly op: "tag"; readonly source: string; readonly change: PreviewChange }

/** These ports must run under a trusted caller. There is deliberately no live adapter here. */
export interface PreviewExecution {
  readonly evidence: () => Effect.Effect<PreviewEvidence, PreviewBlocked>
  readonly pack: (
    number: number,
    head: string,
    utc: string,
  ) => Effect.Effect<{ readonly version: string; readonly archive: Uint8Array }, PreviewBlocked>
  readonly publish: (
    version: string,
    archive: Uint8Array,
    stagingTag: string,
  ) => Effect.Effect<void, PreviewBlocked>
  readonly tag: (change: PreviewChange) => Effect.Effect<void, PreviewBlocked>
}

const deny = (detail: string) => new PreviewBlocked({ detail })
const signature = (archive: Uint8Array) =>
  `sha512-${new Bun.CryptoHasher("sha512").update(archive).digest("base64")}`
const sameTags = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean =>
  [...new Set([...Object.keys(left), ...Object.keys(right)])].every(
    (key) => left[key] === right[key],
  )

/** Execute one reviewed operation. Staging immutable bytes never promotes a user-facing tag. */
export const executePreview = Effect.fn("executeOneReviewedPreview")(function* (
  operation: PreviewOperation,
  io: PreviewExecution,
) {
  const first = yield* io.evidence()
  const plan = yield* planPreview(first)
  if (plan.sourceSha !== operation.source) return yield* deny("The protected preview source moved")
  if (operation.op === "tag") {
    // No mutable parameters or caller-provided authorization can escape the current plan.
    if (!plan.changes.some((change) => JSON.stringify(change) === JSON.stringify(operation.change)))
      return yield* deny("The tag operation no longer matches current preview evidence")
    yield* io.tag(operation.change)
    const readback = yield* io.evidence()
    yield* verifyPreviewTransition(first, readback, operation.change)
    return "tag-verified" as const
  }

  const exact = plan.candidates.find(
    ({ number, sha }) => number === operation.number && sha === operation.head,
  )
  const evidence = first.candidates.find(
    ({ number, sha }) => number === operation.number && sha === operation.head,
  )
  const identity = evidence?.artifact
  if (
    exact?.version == null ||
    evidence === undefined ||
    identity?.sha !== operation.head ||
    identity.expectedIntegrity === undefined ||
    (exact.status !== "waiting-artifact" && exact.status !== "ready")
  )
    return yield* deny("The exact PR head is not approved and validated for staging")
  if (exact.status === "ready") return "already-staged" as const

  const archive = yield* io.pack(operation.number, operation.head, evidence.committerUtc)
  if (
    archive.version !== exact.version ||
    signature(archive.archive) !== identity.expectedIntegrity
  )
    return yield* deny("The staged archive is not the reviewed immutable package")

  const before = yield* io.evidence()
  const fresh = yield* planPreview(before)
  const current = before.candidates.find(({ number }) => number === operation.number)
  const staging = `pr-staged-${operation.number}-${operation.head}`
  if (
    fresh.sourceSha !== plan.sourceSha ||
    JSON.stringify(fresh.candidates) !== JSON.stringify(plan.candidates) ||
    current?.artifact?.expectedIntegrity !== identity.expectedIntegrity ||
    !sameTags(first.tags, before.tags) ||
    Object.hasOwn(before.tags, staging)
  )
    return yield* deny("Preview evidence moved while staging the archive")

  yield* io.publish(exact.version, archive.archive, staging)
  const after = yield* io.evidence()
  const observed = yield* planPreview(after)
  const expected = fresh.candidates.map((candidate) =>
    candidate.number === exact.number ? { ...candidate, status: "ready" } : candidate,
  )
  if (
    observed.sourceSha !== fresh.sourceSha ||
    JSON.stringify(observed.candidates) !== JSON.stringify(expected) ||
    after.candidates.find(({ number }) => number === exact.number)?.artifact?.registryIntegrity !==
      identity.expectedIntegrity ||
    !sameTags({ ...before.tags, [staging]: exact.version }, after.tags)
  )
    return yield* deny(
      "Preview staging readback disagreed. Inspect registry state before any retry.",
    )
  return "stage-verified" as const
})
