import { Effect, Schema } from "effect"

import { newId } from "../domain/ids.ts"
import {
  closeIntent,
  createIntent,
  type Intent,
  IntentDraft,
  IntentUpdate,
  reopenIntent,
  updateIntent,
} from "../domain/intent.ts"
import { findIntent, requireOpen } from "../domain/project.ts"
import { readState, type Snapshot } from "../state/store.ts"
import { booleanFlag, requiredFlag, stringFlag } from "./args.ts"
import { nowIso } from "./context.ts"
import { NoActiveIntent, Usage } from "./errors.ts"
import type { Command } from "./types.ts"
import { byId, intentRow, intentView, oneLine, present } from "./views.ts"

const openIntents = (snapshot: Snapshot) =>
  byId(snapshot.project.intents.filter((intent) => intent.state === "Open"))

/** The id of the Intent in use, when it exists and is still open. */
export const intentInUse = (snapshot: Snapshot): string | undefined =>
  openIntents(snapshot).find((intent) => intent.id === snapshot.activeIntent)?.id

/**
 * The Intent a command works on: the one in use, else the only open one. With none open, or several
 * open and none in use, the command fails listing the open ones, so it never guesses.
 */
export const resolveIntent = (snapshot: Snapshot): Effect.Effect<Intent, NoActiveIntent> => {
  const open = openIntents(snapshot)
  const chosen =
    open.find((intent) => intent.id === snapshot.activeIntent) ??
    (open.length === 1 ? open[0] : undefined)
  return chosen === undefined
    ? Effect.fail(
        new NoActiveIntent({
          open: open.map(({ id, objective }) => ({
            id,
            objective: oneLine(objective),
          })),
        }),
      )
    : Effect.succeed(chosen)
}

const IntentInput = Schema.Struct({
  objective: IntentDraft.fields.objective,
  requirements: IntentDraft.fields.requirements,
})

const IntentEdit = Schema.Struct({
  objective: IntentUpdate.fields.objective,
  requirements: IntentUpdate.fields.requirements,
})

/** The `intent` commands. */
export const INTENT_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["intent", "create"],
    usage: "intent create [--input <json>]",
    summary: "Create an Intent and put it in use",
    input: "{objective, requirements?: [text]}",
    flags: { input: "string" },
    positionals: 0,
    state: "create",
    run: ({ update, input }) =>
      Effect.gen(function* () {
        const draft = yield* input(IntentInput)
        const id = yield* newId("intent")
        const now = yield* nowIso
        const { intent } = yield* update(({ project }) =>
          createIntent(project, { ...draft, id, now }).pipe(
            Effect.map((change) => ({ ...change, activeIntent: id })),
          ),
        )
        return intentView(intent)
      }),
  },
  {
    path: ["intent", "show"],
    usage: "intent show [id]",
    summary: "Show an Intent: the one named, else the one in use",
    flags: {},
    positionals: 1,
    optional: true,
    run: ({ directory, args }) =>
      Effect.gen(function* () {
        const snapshot = yield* readState(directory)
        const [id] = args.positionals
        const intent =
          id === undefined
            ? yield* resolveIntent(snapshot)
            : yield* findIntent(snapshot.project, id)
        return intentView(intent, snapshot.links)
      }),
  },
  {
    path: ["intent", "list"],
    usage: "intent list",
    summary: "List every Intent",
    flags: {},
    positionals: 0,
    run: ({ directory }) =>
      readState(directory).pipe(
        Effect.map((snapshot) => {
          const inUse = intentInUse(snapshot)
          return {
            intents: byId(snapshot.project.intents).map((i) => intentRow(i, i.id === inUse)),
          }
        }),
      ),
  },
  {
    path: ["intent", "update"],
    usage: "intent update [--input <json>] [--material]",
    summary: "Edit the Intent in use; --material moves its revision and makes open work stale",
    input: "{objective?, requirements?: [text]}",
    notes: [
      "--material when requirements, user-visible behavior, architecture, security, contracts, dependencies or deployment change; omit it for clarifications. Open work planned on the old revision is then stale",
    ],
    flags: { input: "string", material: "boolean" },
    positionals: 0,
    run: ({ update, args, input }) =>
      Effect.gen(function* () {
        const edit = yield* input(IntentEdit)
        const { intent } = yield* update((snapshot) =>
          resolveIntent(snapshot).pipe(
            Effect.flatMap((current) =>
              updateIntent(snapshot.project, current.id, {
                ...edit,
                material: booleanFlag(args, "material"),
              }),
            ),
          ),
        )
        return intentView(intent)
      }),
  },
  {
    path: ["intent", "close"],
    usage: "intent close --reason <text> [--drop <reason>]",
    summary: "Close the Intent in use; --drop cancels its Ready and Running Assignments",
    notes: ["pull before closing: another clone may hold work this one cannot see"],
    flags: { reason: "string", drop: "string" },
    positionals: 0,
    run: ({ update, args }) =>
      Effect.gen(function* () {
        const reason = yield* requiredFlag(args, "reason", "intent close --reason <text>")
        const drop = stringFlag(args, "drop")
        const now = yield* nowIso
        const closed = yield* update((snapshot) =>
          resolveIntent(snapshot).pipe(
            Effect.flatMap((current) =>
              closeIntent(
                snapshot.project,
                snapshot.specialists,
                current.id,
                { reason, ...(drop === undefined ? {} : { drop }) },
                now,
              ),
            ),
          ),
        )
        return present({
          ...intentView(closed.intent),
          dropped: closed.assignments.map((assignment) => assignment.id),
        })
      }),
  },
  {
    path: ["intent", "reopen"],
    usage: "intent reopen [id]",
    summary: "Reopen a closed Intent at the next revision and put it in use",
    flags: {},
    positionals: 1,
    optional: true,
    run: ({ update, args }) =>
      Effect.gen(function* () {
        const { intent } = yield* update((snapshot) =>
          Effect.gen(function* () {
            const id = args.positionals[0] ?? snapshot.activeIntent
            if (id === undefined)
              return yield* new Usage({
                message: "No id given and no Intent is in use",
                hint: "Usage: holyagent intent reopen <id>",
              })
            const change = yield* reopenIntent(snapshot.project, id)
            return { ...change, activeIntent: id }
          }),
        )
        return intentView(intent)
      }),
  },
  {
    path: ["intent", "use"],
    usage: "intent use <id>",
    summary: "Put an open Intent in use in this clone",
    flags: {},
    positionals: 1,
    run: ({ update, args }) =>
      Effect.gen(function* () {
        const { intent } = yield* update(({ project }) =>
          Effect.gen(function* () {
            const found = yield* findIntent(project, args.positionals[0] ?? "")
            yield* requireOpen(found)
            return { intent: found, activeIntent: found.id }
          }),
        )
        return intentView(intent)
      }),
  },
]
