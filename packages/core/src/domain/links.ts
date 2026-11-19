import { Effect, Schema } from "effect"

import { BranchId, IntentId, PullId } from "./ids.ts"
import { decodeInput } from "./input.ts"
import { Text, Timestamp } from "./primitives.ts"
import { type Change, findIntent, type Project } from "./project.ts"

// An Intent's links to version control are records of their own, one file each with a generated
// id, and never edited afterwards. Two lines of state that record different commits or pull
// requests therefore add different files, and merging them cannot conflict.

/**
 * One commit an Intent made on a branch, recorded by `vcs commit`. The branch list of an Intent is
 * the distinct branches of its records.
 */
export const BranchRecord = Schema.Struct({
  id: BranchId,
  intentId: IntentId,
  branch: Text,
  commit: Text,
  committedAt: Timestamp,
})
/** One commit an Intent made on a branch. */
export type BranchRecord = typeof BranchRecord.Type

/**
 * One `vcs pr` call for an Intent: a pull request it created or updated. The pull requests of an
 * Intent are the latest record of each number.
 */
export const PullRecord = Schema.Struct({
  id: PullId,
  intentId: IntentId,
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  url: Text,
  branch: Text,
  base: Schema.optionalKey(Text),
  created: Schema.Boolean,
  recordedAt: Timestamp,
})
/** One pull request an Intent created or updated. */
export type PullRecord = typeof PullRecord.Type

/** Every branch and pull request record of the project, as the store loads them. */
export interface Links {
  readonly branches: ReadonlyArray<BranchRecord>
  readonly pulls: ReadonlyArray<PullRecord>
}

/** A branch record for an Intent of the project. */
export const linkBranch = (project: Project, input: BranchRecord) =>
  Effect.gen(function* () {
    const record = yield* decodeInput(BranchRecord, input)
    yield* findIntent(project, record.intentId)
    return { branches: [record], record } satisfies Change & { record: BranchRecord }
  })

/** A pull request record for an Intent of the project. */
export const linkPull = (project: Project, input: PullRecord) =>
  Effect.gen(function* () {
    const record = yield* decodeInput(PullRecord, input)
    yield* findIntent(project, record.intentId)
    return { pulls: [record], record } satisfies Change & { record: PullRecord }
  })

/** The distinct branches an Intent committed on, in the order of the first commit on each. */
export const branchesOf = (links: Links, intentId: string): ReadonlyArray<string> => [
  ...new Set(
    links.branches
      .filter((record) => record.intentId === intentId)
      .toSorted((a, b) => (a.id < b.id ? -1 : 1))
      .map((record) => record.branch),
  ),
]

/**
 * The pull requests an Intent created or updated: the latest record of each number, keeping the
 * base from an earlier record when the latest (an update that did not name one) has none.
 */
export const pullsOf = (links: Links, intentId: string): ReadonlyArray<PullRecord> => {
  const latest = new Map<number, PullRecord>()
  for (const record of links.pulls
    .filter((candidate) => candidate.intentId === intentId)
    .toSorted((a, b) => (a.id < b.id ? -1 : 1))) {
    const base = record.base ?? latest.get(record.number)?.base
    latest.set(record.number, base === undefined ? record : { ...record, base })
  }
  return [...latest.values()].toSorted((a, b) => a.number - b.number)
}
