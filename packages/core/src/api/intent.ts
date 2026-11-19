import { rm } from "node:fs/promises"

import { Clock, Effect, Schema } from "effect"

import { IntentId, newId } from "../domain/ids.ts"
import {
  closeIntent,
  createIntent,
  IntentClosing,
  IntentDraft,
  IntentUpdate,
  reopenIntent,
  updateIntent,
} from "../domain/intent.ts"
import { findIntent, requireOpen } from "../domain/project.ts"
import { io } from "../state/files.ts"
import { artifactFile } from "./artifacts.ts"
import { type Context, decode, resolveIntent, withState } from "./context.ts"

/** Strict operation inputs for the Intent API. */
export const schemas = {
  create: Schema.Struct({
    objective: IntentDraft.fields.objective,
    requirements: IntentDraft.fields.requirements,
  }),
  show: Schema.Struct({ id: Schema.optionalKey(IntentId) }),
  list: Schema.Struct({}),
  update: Schema.Struct({ ...IntentUpdate.fields, material: Schema.optionalKey(Schema.Boolean) }),
  close: IntentClosing,
  reopen: Schema.Struct({ id: Schema.optionalKey(IntentId) }),
  use: Schema.Struct({ id: IntentId }),
} as const

const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()))

/** Creates and selects a new Intent. */
export const create = (context: Context, input: typeof schemas.create.Encoded) =>
  Effect.gen(function* () {
    const draft = yield* decode(schemas.create, input)
    const id = yield* newId("intent")
    const at = yield* now
    return yield* withState(context, "intent.create", "create", ({ update }) =>
      update(({ project }) =>
        createIntent(project, { ...draft, id, now: at }).pipe(
          Effect.map((change) => ({ ...change, activeIntent: id })),
        ),
      ).pipe(Effect.map(({ intent }) => intent)),
    )
  })

/** Reads an Intent by id or the unambiguous active Intent. */
export const show = (context: Context, input: typeof schemas.show.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.show, input)
    return yield* withState(context, "intent.show", "ifPresent", ({ read, directory }) =>
      Effect.gen(function* () {
        const snapshot = yield* read(directory)
        const found =
          request.id === undefined
            ? yield* resolveIntent(snapshot)
            : yield* findIntent(snapshot.project, request.id)
        return { ...found, links: snapshot.links }
      }),
    )
  })

/** Lists recorded Intents and the selected active id. */
export const list = (context: Context, input: typeof schemas.list.Encoded) =>
  Effect.gen(function* () {
    yield* decode(schemas.list, input)
    return yield* withState(context, "intent.list", "ifPresent", ({ read, directory }) =>
      read(directory).pipe(
        Effect.flatMap((snapshot) =>
          resolveIntent(snapshot).pipe(
            Effect.map((current) => ({
              intents: snapshot.project.intents,
              activeIntent: current.id,
            })),
            Effect.orElseSucceed(() => ({
              intents: snapshot.project.intents,
              activeIntent: undefined,
            })),
          ),
        ),
      ),
    )
  })

/** Updates the active Intent, advancing the revision for material changes. */
export const update = (context: Context, input: typeof schemas.update.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.update, input)
    return yield* withState(context, "intent.update", "ifPresent", ({ update: apply }) =>
      apply((snapshot) =>
        resolveIntent(snapshot).pipe(
          Effect.flatMap((current) =>
            updateIntent(snapshot.project, current.id, {
              ...request,
              material: request.material ?? false,
            }),
          ),
        ),
      ).pipe(Effect.map(({ intent }) => intent)),
    )
  })

/** Closes the active Intent and optionally drops its open work. */
export const close = (context: Context, input: typeof schemas.close.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.close, input)
    const at = yield* now
    return yield* withState(
      context,
      "intent.close",
      "ifPresent",
      ({ root, directory, update: apply }) =>
        Effect.gen(function* () {
          const unremoved: Array<string> = []
          const change = yield* apply(
            (snapshot) =>
              resolveIntent(snapshot).pipe(
                Effect.flatMap((current) =>
                  closeIntent(snapshot.project, snapshot.specialists, current.id, request, at).pipe(
                    Effect.map((closed) => ({
                      ...closed,
                      owned: snapshot.project.assignments
                        .filter((row) => row.intentId === current.id)
                        .map((row) => row.id),
                    })),
                  ),
                ),
              ),
            (closed) =>
              Effect.forEach(closed.owned, (id) =>
                Effect.forEach(["briefs", "reports"] as const, (kind) =>
                  artifactFile(context, root, directory, kind, id).pipe(
                    Effect.flatMap((path) =>
                      io(path, () => rm(path, { force: true })).pipe(
                        Effect.catch((error) =>
                          Effect.sync(() => {
                            unremoved.push(error.message)
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              ).pipe(Effect.asVoid),
          )
          return { ...change, unremoved }
        }),
    )
  })

/** Reopens an Intent and makes it active. */
export const reopen = (context: Context, input: typeof schemas.reopen.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.reopen, input)
    return yield* withState(context, "intent.reopen", "ifPresent", ({ update: apply }) =>
      apply((snapshot) =>
        Effect.gen(function* () {
          const id = request.id ?? snapshot.activeIntent
          if (id === undefined) return yield* new NoReopenTarget({ reason: "missing" })
          return { ...(yield* reopenIntent(snapshot.project, id)), activeIntent: id }
        }),
      ).pipe(Effect.map(({ intent }) => intent)),
    )
  })

import { Data } from "effect"
/** No explicit or active Intent was provided for reopening. */
export class NoReopenTarget extends Data.TaggedError("NoReopenTarget")<{
  readonly reason: "missing"
}> {}

/** Selects an open Intent for this worktree. */
export const use = (context: Context, input: typeof schemas.use.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.use, input)
    return yield* withState(context, "intent.use", "ifPresent", ({ update: apply }) =>
      apply(({ project }) =>
        Effect.gen(function* () {
          const found = yield* findIntent(project, request.id)
          yield* requireOpen(found)
          return { intent: found, activeIntent: found.id }
        }),
      ).pipe(Effect.map(({ intent }) => intent)),
    )
  })
