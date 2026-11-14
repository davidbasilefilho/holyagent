import { Clock, Effect, Schema } from "effect"

import { loadConfigWithSource } from "../config/load.ts"
import { IntentId } from "../domain/ids.ts"
import { recommend } from "../domain/plan.ts"
import { findIntent } from "../domain/project.ts"
import { stateDirectory } from "../state/layout.ts"
import { workTreeKey } from "../state/local.ts"
import { StateMode } from "../state/mode.ts"
import { readOpenState } from "../state/store.ts"
import { readStateMode, requireHandoffState, setStateMode } from "../state/tree.ts"
import { type Context, decode, resolveIntent, withState } from "./context.ts"

/** Strict operation inputs for the overview and state-mode API. */
export const schemas = {
  plan: Schema.Struct({}),
  status: Schema.Struct({}),
  reconcile: Schema.Struct({}),
  handoff: Schema.Struct({ intent: Schema.optionalKey(IntentId) }),
  stateMode: Schema.Struct({ mode: Schema.optionalKey(StateMode) }),
} as const

/** Recommends how to launch currently Ready work. */
export const plan = (context: Context, input: typeof schemas.plan.Encoded) =>
  Effect.gen(function* () {
    yield* decode(schemas.plan, input)
    return yield* withState(context, "plan", "ifPresent", ({ root, directory }) =>
      Effect.gen(function* () {
        const snapshot = yield* readOpenState(directory)
        const intent = yield* resolveIntent(snapshot)
        const at = new Date(yield* Clock.currentTimeMillis).toISOString()
        const raw = context.env.HOLYAGENT_ROUTING_PROFILE?.trim()
        const requested =
          raw === undefined || raw === ""
            ? undefined
            : yield* decode(Schema.Literals(["normal", "fast"]), raw)
        const source =
          context.host === "pi"
            ? yield* loadConfigWithSource({
                projectDirectories: [stateDirectory(root)],
                env: context.env,
              })
            : undefined
        const active =
          source?.config.pi.enable === false
            ? false
            : requested !== undefined || source?.config.pi.profile !== undefined
        const execution = active
          ? {
              ...context.execution,
              profileRouting: true as const,
              workflowsAvailable:
                context.host === "pi" ? false : context.execution.workflowsAvailable,
            }
          : context.execution
        return (
          recommend(
            {
              intents: [intent],
              assignments: snapshot.project.assignments.filter((row) => row.intentId === intent.id),
            },
            snapshot.specialists,
            at,
            execution,
            workTreeKey(root),
          ) ?? { action: "none" as const, reason: "no Ready Assignment can start now" }
        )
      }),
    )
  })

/** Returns recorded open work and the local registry. */
export const status = (context: Context, input: typeof schemas.status.Encoded) =>
  Effect.gen(function* () {
    yield* decode(schemas.status, input)
    return yield* withState(context, "status", "ifPresent", ({ directory }) =>
      readOpenState(directory),
    )
  })

/** Lists the recorded Running Assignments for host reconciliation. */
export const reconcile = (context: Context, input: typeof schemas.reconcile.Encoded) =>
  Effect.gen(function* () {
    yield* decode(schemas.reconcile, input)
    return yield* withState(context, "reconcile", "ifPresent", ({ directory }) =>
      readOpenState(directory).pipe(
        Effect.map(({ project }) => project.assignments.filter((row) => row.state === "Running")),
      ),
    )
  })

/** Reads a handoff snapshot only when the recorded state is known to be complete. */
export const handoff = (context: Context, input: typeof schemas.handoff.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.handoff, input)
    return yield* withState(context, "handoff", "peek", ({ directory }) =>
      Effect.gen(function* () {
        yield* requireHandoffState(context.cwd, context.env, directory)
        const snapshot = yield* readOpenState(directory)
        const intents =
          request.intent === undefined
            ? snapshot.project.intents
            : [yield* findIntent(snapshot.project, request.intent)]
        return {
          source: "recorded local state; live PR and CI status unknown",
          intents: intents
            .toSorted((a, b) => a.id.localeCompare(b.id))
            .map((intent) => ({
              ...intent,
              assignments: snapshot.project.assignments
                .filter((row) => row.intentId === intent.id)
                .toSorted((a, b) => a.id.localeCompare(b.id)),
              recordedBranches: snapshot.links.branches
                .filter((row) => row.intentId === intent.id)
                .toSorted((a, b) => a.id.localeCompare(b.id)),
              recordedPullRequests: snapshot.links.pulls
                .filter((row) => row.intentId === intent.id)
                .toSorted((a, b) => a.id.localeCompare(b.id)),
            })),
        }
      }),
    )
  })

/** Reads or changes the state mode after checking its distinct host capability. */
export const stateMode = (context: Context, input: typeof schemas.stateMode.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.stateMode, input)
    return yield* withState(
      context,
      request.mode === undefined ? "stateMode.read" : "stateMode.write",
      "peek",
      () =>
        Effect.gen(function* () {
          if (request.mode === undefined) return yield* readStateMode(context.cwd, context.env)
          return yield* setStateMode(context.cwd, context.env, request.mode)
        }),
    )
  })
