import { booleanFlag } from "./args.ts"
import { coreCommand } from "./core.ts"
import type { Command } from "./types.ts"
export {
  MigrationRefused,
  MigrationUnverified,
  NothingToMigrate,
} from "@holyagent/core/api/migrate.ts"

const NOTES: ReadonlyArray<string> = [
  "reads .holyclaude/ and .holycodex/ at the state root, whichever exist, and writes .holyagent/ records the CLI loads. It deletes nothing: the records are written where the state mode keeps them, on the state branch in the branch mode (the legacy folders are read at the work tree root, the records written in the state worktree) and in the work tree's .holyagent/ otherwise, and removing the legacy folders is left to the root. It lists the project files that name a legacy folder (lint and format ignore lists, for example) without editing them, so the root can point them at .holyagent/",
  "--dry-run prints the counts per source (intents, assignments, notes), every record it cannot convert with the reason, and everything a real run would refuse; it writes nothing. A real run first checks the same things and writes nothing unless all are clear: every record converts, no target file or id exists in .holyagent/ (nothing is overwritten), no Assignment is Running (holyclaude) or executing (holycodex) and no holycodex transaction is pending. A Running or executing Assignment is named with how to settle it: finish or cancel it with the legacy tool, then migrate again. It then reloads .holyagent/ and fails if any record does not decode",
  "records are decoded strictly: a field the legacy schema does not list makes the record unconvertible, and every record is written through the holyagent schemas, so one that breaks a holyagent rule is reported with that rule. Files ending in .tmp are skipped",
  "holyclaude, Intent: the id and revision are kept; the slug comes from the objective; requirements become one entry (none when blank); the state is Open, or Closed with its close_reason (closed_at is dropped); createdAt is the time in the id (the epoch for an early counter id such as intent-0001, which carries none). Notes in the Intent folder (resume-notes.md, notes/) are copied unchanged",
  "holyclaude, Assignment: the role becomes the roleTask and the slug comes from the objective; each acceptance criterion becomes a blocking criterion of dimension behavior (the objective when there are none); required_evidence becomes the evidence labels; a path in ownership_paths that is not portable (absolute, with .., a trailing dot and so on) moves into scope as text and is not enforced, so a Ready writer left without a portable path needs paths before it can be dispatched; related_assignments move into scope as text; dependencies and independent_from keep only the ids of Assignments migrated for the same Intent (the others move into scope as text); symbols, domains, clone_id and mutability (the route decides it) are dropped; a state other than Ready gets the legacy result or a placeholder text; a Succeeded Assignment keeps its acceptance (rationale, criteria_evidence, required_evidence) at its intent_revision, so it needs no new acceptance; createdAt is the time in the id",
  "holyclaude, not migrated: local/ (agent ids, workers, observations), state.json* and the legacy .gitignore; the CLI makes its own .holyagent/local/.gitignore",
  "holycodex, Intent: the id and revision are kept (an id not shaped intent-* gets the prefix); objective is the title; requirements are the goal followed by each acceptance criterion; complete and abandoned become Closed with a closeReason naming the state, every other state becomes Open (the exact state, blockers, gates, evidence, baseline and plan pointers are dropped); createdAt is created_at and updated_at is dropped. intent.toon of schema holycodex-intent-0 is read too",
  "holycodex, Assignment: roleTask is owner.role.owner.task, and an owner holyagent has no route for (Reviewer.plan) is unconvertible; pending becomes Ready, completed Succeeded (with no acceptance, so the root still accepts it), failed Failed, blocked and needs_root_input Failed, superseded Cancelled; the result is the last invocation summary, then the blocker, then the holycodex status for blocked, needs_root_input and superseded, or a placeholder; intentRevision is the revision of the Intent (the Assignment's own revision, invocations, evidence, supersession links and remaining risk are dropped); acceptance criteria become blocking behavior criteria (the objective when there are none); scope is kept as text and, for a writing route only, its portable entries are also the ownership paths; constraints are followed by the exclusions, each prefixed Exclusion:; dependencies that name an Assignment migrated for the same Intent are kept (an id not shaped assignment-* gets the prefix) and the others move into scope as text; createdAt is created_at",
  "holycodex, notes: plan.toon, plan.old-NNN.toon and every other file of an Intent folder are copied unchanged. Not migrated: the current pointer and .intent-store. A pending .holycodex-transaction.toon stops the run: run a holycodex-agent command that reads the work state (for example holycodex-agent intent current) so it recovers the write, then migrate again",
]

/** The `migrate` command. */
export const MIGRATE_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["migrate"],
    usage: "migrate [--dry-run]",
    summary:
      "Convert the legacy .holyclaude/ and .holycodex/ state of the project into .holyagent/ records",
    notes: NOTES,
    flags: { "dry-run": "boolean" },
    positionals: 0,
    state: (args) => (booleanFlag(args, "dry-run") ? "ifPresent" : "create"),
    core: true,
    run: coreCommand("migrate"),
  },
]
