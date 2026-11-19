import { Clock, Effect, Random, Schema } from "effect"

const identifier = (kind: string) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^${kind}-[a-z0-9]+(?:-[a-z0-9]+)*$`)))

/** The id of an Intent. It names a directory, so it is lower-case ASCII with hyphens only. */
export const IntentId = identifier("intent")

/** The id of an Assignment. It names a file; the same character rules as an Intent id. */
export const AssignmentId = identifier("assignment")

/** The id of a branch record: one commit an Intent made on a branch. It names a file. */
export const BranchId = identifier("branch")

/** The id of a pull request record: one `vcs pr` call for an Intent. It names a file. */
export const PullId = identifier("pull")

/** The id of a launched specialist, as the host reports it. Opaque, but never blank. */
export const AgentId = Schema.String.check(Schema.isPattern(/\S/))

/** A kind of record that has a generated id. */
export type IdKind = "intent" | "assignment" | "branch" | "pull"

/**
 * A new id: the kind, the creation time as 9 base36 digits and 4 random base36 digits, as in
 * `intent-0mg8k2x1a-7f3q`. The time comes first at a fixed width, so plain string order among
 * generated ids is creation order, and clones creating at once rarely collide.
 */
export const newId = (kind: IdKind) =>
  Effect.gen(function* () {
    const time = (yield* Clock.currentTimeMillis).toString(36).padStart(9, "0")
    const digits = yield* Effect.forEach([0, 1, 2, 3], () => Random.nextIntBetween(0, 35))
    return `${kind}-${time}-${digits.map((digit) => digit.toString(36)).join("")}`
  })
