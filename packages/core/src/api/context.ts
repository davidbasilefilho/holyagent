import { Data, Effect, type Schema } from "effect"

import type { ExecutionConfig } from "../domain/directive.ts"
import type { AgentHost } from "../domain/host.ts"
import { decodeInput } from "../domain/input.ts"
import type { Intent } from "../domain/intent.ts"
import type { RoleTask } from "../domain/route.ts"
import { WorkTree } from "../state/local.ts"
import { readState, type Snapshot, type StateChange, updateState } from "../state/store.ts"
import { type Ensure, resolveState } from "../state/tree.ts"

/** The named action a trusted host must explicitly authorize. */
export type Capability =
  | "intent.create"
  | "intent.show"
  | "intent.list"
  | "intent.update"
  | "intent.close"
  | "intent.reopen"
  | "intent.use"
  | "assignment.create"
  | "assignment.dispatch"
  | "assignment.record"
  | "assignment.close"
  | "assignment.accept"
  | "assignment.reports"
  | "assignment.show"
  | "assignment.list"
  | "plan"
  | "status"
  | "reconcile"
  | "handoff"
  | "migrate"
  | "state.initialize"
  | "stateMode.read"
  | "stateMode.write"
  | "vcs.commit"
  | "vcs.identity"
  | "vcs.pr"
  | "setup"
  | "doctor.read"
  | "doctor.fix"

/** Authority and host settings constructed by the host adapter, never from model input. */
export interface Context {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly host: AgentHost
  readonly execution: ExecutionConfig
  readonly authorize: (capability: Capability) => boolean
  /** Host-provided prompt text assets; missing Pi first-pass templates fail closed. */
  readonly firstPass?: Readonly<Partial<Record<RoleTask, string>>>
}

/** A host did not establish authority for an operation. */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly capability: Capability
}> {}

/** Checks current host authority at an operation boundary. */
export const requireCapability = (context: Context, capability: Capability) =>
  Effect.suspend(() =>
    context.authorize(capability) === true
      ? Effect.void
      : Effect.fail(new Unauthorized({ capability })),
  )

/** No unambiguous active open Intent was found. */
export class NoActiveIntent extends Data.TaggedError("NoActiveIntent")<{
  readonly open: ReadonlyArray<{ readonly id: string; readonly objective: string }>
}> {
  /** Explains which open records need an explicit selection. */
  override get message() {
    return this.open.length === 0
      ? "No Intent is open"
      : `${this.open.length} Intents are open and none is in use: ${this.open.map(({ id, objective }) => `${id} (${objective})`).join("; ")}`
  }
}

/** Decodes one operation input with strict excess-property checking. */
export const decode = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
  decodeInput(schema, input)

/** Resolves state after checking current host authority, and scopes the worktree for the operation. */
export const withState = <A, E, R>(
  context: Context,
  capability: Capability,
  ensure: Ensure,
  use: (state: {
    readonly root: string
    readonly directory: string
    readonly read: typeof readState
    readonly update: <B extends StateChange, F>(
      transition: (snapshot: Snapshot) => Effect.Effect<B, F>,
      after?: (result: B) => Effect.Effect<void>,
    ) => ReturnType<typeof updateState<B, F | Unauthorized>>
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (context.authorize(capability) !== true) return yield* new Unauthorized({ capability })
    const readOnly = [
      "intent.show",
      "intent.list",
      "assignment.show",
      "assignment.list",
      "assignment.reports",
      "plan",
      "status",
      "reconcile",
      "handoff",
    ].includes(capability)
    const canInitialize = context.authorize("state.initialize") === true
    if (!canInitialize && !readOnly && ensure !== "peek")
      return yield* new Unauthorized({ capability: "state.initialize" })
    const authorizeInitialization = requireCapability(context, capability).pipe(
      Effect.andThen(requireCapability(context, "state.initialize")),
    )
    const state = yield* resolveState(
      context.cwd,
      context.env,
      canInitialize ? ensure : "peek",
      capability !== "handoff",
      undefined,
      authorizeInitialization,
    )
    return yield* use({
      root: state.root,
      directory: state.directory,
      read: readState,
      update: (transition, after) =>
        updateState(
          state.directory,
          (snapshot) =>
            Effect.gen(function* () {
              if (context.authorize(capability) !== true)
                return yield* new Unauthorized({ capability })
              const result = yield* transition(snapshot)
              yield* requireCapability(context, capability)
              return result
            }),
          context.env,
          undefined,
          state.resolved,
          after,
        ),
    }).pipe(Effect.provideService(WorkTree, state.root))
  })

/** Resolves the active open Intent without guessing among several open records. */
export const resolveIntent = (snapshot: Snapshot): Effect.Effect<Intent, NoActiveIntent> => {
  const open = snapshot.project.intents
    .filter((item) => item.state === "Open")
    .toSorted((a, b) => a.id.localeCompare(b.id))
  const chosen =
    open.find((item) => item.id === snapshot.activeIntent) ??
    (open.length === 1 ? open[0] : undefined)
  return chosen === undefined
    ? Effect.fail(
        new NoActiveIntent({ open: open.map(({ id, objective }) => ({ id, objective })) }),
      )
    : Effect.succeed(chosen)
}
