import { randomUUID } from "node:crypto"

import { Data, Effect } from "effect"

import {
  advanceMigrationJournal,
  beginMigrationJournal,
  finishMigrationJournal,
  type MigrationJournal,
  type MigrationJournalFile,
  type MigrationJournalLocation,
  type MigrationJournalSource,
  readMigrationJournal,
} from "./migration-journal.ts"

/** The private index helper's commit facts, plus the caller's source preimages. */
export interface MigrationPreparation {
  readonly parent: string
  readonly commit: string
  readonly tree: string
  readonly indexBefore: string
  readonly indexAfter: string
  readonly files: ReadonlyArray<MigrationJournalFile>
  readonly source: ReadonlyArray<MigrationJournalSource>
}

/** A conflict needs inspection; the runner never resets the ref or guesses a rollback. */
export class MigrationRunnerConflict extends Data.TaggedError("MigrationRunnerConflict")<{
  readonly reason: string
}> {
  /** An actionable recovery diagnostic. */
  override get message() {
    return `Migration needs recovery: ${this.reason}`
  }
}

/**
 * Trusted services used while the caller holds the initialization and state locks.
 *
 * `sourceRoot` and `targetRoot` in the journal are canonical project and state Git worktree roots.
 * All journal file and source paths are relative to those roots, including `.holyagent/`. `readRef`
 * and `compareAndSwapRef` address exactly the supplied, trusted branch. The CAS service must use
 * expected-old-value semantics and remain interruptible; its failure is not proof that the ref did
 * not advance. Each mutating service must recheck the supplied live authorization immediately
 * before its own mutations after asynchronous reads or waits.
 *
 * Publication services accept a mixture of recorded preimages and postimages, do not touch unowned
 * entries, and fail on any other state. `verifyTarget` checks all target file and index postimages
 * without mutation. Cleanup is idempotent, preserves tracked edits, and fails on unexpected source
 * conflicts; it may deliberately retain unchanged tracked files. Errors must not include journal
 * payload contents. `verifyCommit` checks the immutable commit object's recorded parent and tree
 * before any ref, file, index, or source publication.
 */
export interface MigrationRunnerServices<E, F, R = never> {
  readonly prepare: (
    authorize: Effect.Effect<void, F>,
  ) => Effect.Effect<MigrationPreparation, E | F, R>
  readonly readRef: (branch: string) => Effect.Effect<string, E, R>
  readonly verifyCommit: (journal: MigrationJournal) => Effect.Effect<void, E, R>
  readonly compareAndSwapRef: (
    branch: string,
    parent: string,
    commit: string,
    authorize: Effect.Effect<void, F>,
  ) => Effect.Effect<void, E | F, R>
  readonly publishFiles: (
    journal: MigrationJournal,
    authorize: Effect.Effect<void, F>,
  ) => Effect.Effect<void, E | F, R>
  readonly publishIndex: (
    journal: MigrationJournal,
    authorize: Effect.Effect<void, F>,
  ) => Effect.Effect<void, E | F, R>
  readonly verifyTarget: (journal: MigrationJournal) => Effect.Effect<void, E, R>
  readonly cleanupSource: (
    journal: MigrationJournal,
    authorize: Effect.Effect<void, F>,
  ) => Effect.Effect<void, E | F, R>
}

/** Inputs and trusted services for a migration transaction. */
export interface MigrationRunnerOptions<E, F, R = never> {
  readonly location: MigrationJournalLocation
  /** Branch name from trusted configuration, never from a journal. */
  readonly branch: string
  readonly authorize: Effect.Effect<void, F>
  readonly services: MigrationRunnerServices<E, F, R>
}

/**
 * Resume a journal or prepare and begin one before publishing. The caller owns the encompassing
 * locks and checks for journals belonging to other worktrees before invoking this operation. Only
 * journal metadata writes are uninterruptible; all supplied operations remain interruptible.
 */
export const runMigrationTransaction = <E, F, R>(options: MigrationRunnerOptions<E, F, R>) =>
  Effect.gen(function* () {
    const { location, branch, authorize, services } = options
    let journal = yield* readMigrationJournal(location)
    if (journal === undefined) {
      yield* authorize
      const prepared = yield* services.prepare(authorize)
      journal = {
        version: 1,
        transaction: randomUUID(),
        sourceRoot: location.sourceRoot,
        targetRoot: location.targetRoot,
        branch,
        parent: prepared.parent,
        commit: prepared.commit,
        tree: prepared.tree,
        indexBefore: prepared.indexBefore,
        indexAfter: prepared.indexAfter,
        files: prepared.files,
        source: prepared.source,
        phase: "prepared",
      }
      // begin rechecks the authority after all preparation and writes durably before any ref CAS.
      yield* beginMigrationJournal(location, journal, authorize)
    }
    if (journal.branch !== branch)
      return yield* new MigrationRunnerConflict({
        reason: "journal names another state branch; inspect it before retrying",
      })
    yield* services.verifyCommit(journal)

    const checkCommitted = (record: MigrationJournal) =>
      services.readRef(branch).pipe(
        Effect.flatMap((actual) =>
          actual === record.commit
            ? Effect.void
            : Effect.fail(
                new MigrationRunnerConflict({
                  reason: "state branch changed during migration; inspect it before retrying",
                }),
              ),
        ),
      )

    if (journal.phase === "prepared") {
      const actual = yield* services.readRef(branch)
      if (actual !== journal.commit) {
        if (actual !== journal.parent)
          return yield* new MigrationRunnerConflict({
            reason: "state branch is neither the recorded parent nor migration commit",
          })
        yield* authorize
        const record = journal
        yield* services.compareAndSwapRef(branch, record.parent, record.commit, authorize).pipe(
          // A nonzero return may still follow a successful ref update. Interruption is not caught.
          Effect.catch((error) =>
            services.readRef(branch).pipe(
              Effect.flatMap((after): Effect.Effect<void, E | F | MigrationRunnerConflict> =>
                after === record.commit
                  ? Effect.void
                  : after === record.parent
                    ? Effect.fail(error)
                    : Effect.fail(
                        new MigrationRunnerConflict({
                          reason: "state branch changed while publishing the ref",
                        }),
                      ),
              ),
            ),
          ),
        )
      }
      yield* checkCommitted(journal)
      journal = yield* advanceMigrationJournal(
        location,
        journal.transaction,
        "prepared",
        "ref-published",
        authorize,
      )
    }
    if (journal.phase === "ref-published") {
      yield* checkCommitted(journal)
      yield* authorize
      yield* services.publishFiles(journal, authorize)
      yield* checkCommitted(journal)
      yield* authorize
      yield* services.publishIndex(journal, authorize)
      yield* checkCommitted(journal)
      yield* services.verifyTarget(journal)
      yield* checkCommitted(journal)
      journal = yield* advanceMigrationJournal(
        location,
        journal.transaction,
        "ref-published",
        "target-published",
        authorize,
      )
    }
    if (journal.phase === "target-published") {
      yield* checkCommitted(journal)
      yield* services.verifyTarget(journal)
      yield* checkCommitted(journal)
      yield* authorize
      yield* services.cleanupSource(journal, authorize)
      yield* checkCommitted(journal)
      yield* services.verifyTarget(journal)
      journal = yield* advanceMigrationJournal(
        location,
        journal.transaction,
        "target-published",
        "source-cleaned",
        authorize,
      )
    }
    if (journal.phase === "source-cleaned") {
      yield* checkCommitted(journal)
      yield* services.verifyTarget(journal)
      yield* checkCommitted(journal)
      yield* finishMigrationJournal(location, journal.transaction, authorize)
    }
  })
