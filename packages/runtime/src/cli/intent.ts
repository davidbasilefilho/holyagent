import { Effect } from "effect"

import type { Intent } from "../domain/intent.ts"
import type { Snapshot } from "../state/store.ts"
import { coreCommand } from "./core.ts"
import { NoActiveIntent } from "./errors.ts"
import type { Command } from "./types.ts"
import { byId, oneLine } from "./views.ts"

const openIntents = (snapshot: Snapshot) =>
  byId(snapshot.project.intents.filter((intent) => intent.state === "Open"))

/**
 * The open Intent a command works on: the one this work tree put in use, else the only open one;
 * undefined when neither holds.
 */
const chosenIntent = (snapshot: Snapshot): Intent | undefined => {
  const open = openIntents(snapshot)
  return (
    open.find((intent) => intent.id === snapshot.activeIntent) ??
    (open.length === 1 ? open[0] : undefined)
  )
}

/** The id of the Intent in use, as {@link resolveIntent} would pick it. */
export const intentInUse = (snapshot: Snapshot): string | undefined => chosenIntent(snapshot)?.id

/**
 * The Intent a command works on: the one in use in this work tree, else the only open one. With
 * none open, or several open and none in use, the command fails listing the open ones, so it never
 * guesses.
 */
export const resolveIntent = (snapshot: Snapshot): Effect.Effect<Intent, NoActiveIntent> => {
  const chosen = chosenIntent(snapshot)
  return chosen === undefined
    ? Effect.fail(
        new NoActiveIntent({
          open: openIntents(snapshot).map(({ id, objective }) => ({
            id,
            objective: oneLine(objective),
          })),
        }),
      )
    : Effect.succeed(chosen)
}

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
    core: true,
    run: coreCommand("intent create"),
  },
  {
    path: ["intent", "show"],
    usage: "intent show [id]",
    summary: "Show an Intent: the one named, else the one in use",
    flags: {},
    positionals: 1,
    optional: true,
    core: true,
    run: coreCommand("intent show"),
  },
  {
    path: ["intent", "list"],
    usage: "intent list",
    summary: "List every Intent",
    flags: {},
    positionals: 0,
    core: true,
    run: coreCommand("intent list"),
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
    core: true,
    run: coreCommand("intent update"),
  },
  {
    path: ["intent", "close"],
    usage: "intent close --reason <text> [--drop <reason>]",
    summary: "Close the Intent in use; --drop cancels its Ready and Running Assignments",
    notes: ["pull before closing: another clone may hold work this one cannot see"],
    flags: { reason: "string", drop: "string" },
    positionals: 0,
    core: true,
    run: coreCommand("intent close"),
  },
  {
    path: ["intent", "reopen"],
    usage: "intent reopen [id]",
    summary: "Reopen a closed Intent at the next revision and put it in use",
    flags: {},
    positionals: 1,
    optional: true,
    core: true,
    run: coreCommand("intent reopen"),
  },
  {
    path: ["intent", "use"],
    usage: "intent use <id>",
    summary: "Put an open Intent in use in this work tree",
    flags: {},
    positionals: 1,
    core: true,
    run: coreCommand("intent use"),
  },
]
