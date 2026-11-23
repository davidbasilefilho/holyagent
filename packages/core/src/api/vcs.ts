import { Effect, Schema } from "effect"

import { stateDirectory } from "../state/layout.ts"
import { setAuthor } from "../vcs/author.ts"
import { commit as commitGit } from "../vcs/commit.ts"
import { inCloudSession } from "../vcs/identity.ts"
import { prepareMessage } from "../vcs/message.ts"
import { pullRequest } from "../vcs/pr.ts"
import { recordBranch, type VcsState } from "../vcs/record.ts"
import { readSettings } from "../vcs/settings.ts"
import { type Capability, type Context, decode, requireCapability } from "./context.ts"
import { Usage } from "./usage.ts"

/** Strict inputs shared by host adapters. */
export const schemas = {
  commit: Schema.Struct({
    messages: Schema.Array(Schema.String),
    paths: Schema.Array(Schema.String),
  }),
  identity: Schema.Struct({ name: Schema.String, email: Schema.String }),
  pr: Schema.Struct({
    base: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    bodyFile: Schema.optional(Schema.String),
    update: Schema.optional(Schema.Int),
  }),
}

const guardedState = (context: Context, capability: Capability, state: VcsState): VcsState => ({
  ...state,
  update: (transition) =>
    state.update((snapshot) =>
      Effect.gen(function* () {
        yield* requireCapability(context, capability)
        const change = yield* transition(snapshot)
        yield* requireCapability(context, capability)
        return change
      }),
    ),
})

/** Prepares a message, commits the requested paths and records the resulting branch. */
export const commit = (
  context: Context,
  root: string,
  state: VcsState,
  input: typeof schemas.commit.Encoded,
) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.commit, input)
    yield* requireCapability(context, "vcs.commit")
    if (request.messages.length === 0 || request.paths.length === 0)
      return yield* new Usage({
        message:
          request.messages.length === 0
            ? "Missing -m <headline>"
            : "Name the paths to commit after --",
        hint: "Usage: holyagent vcs commit -m <headline> [-m <body>] -- <paths…>",
      })
    const settings = yield* readSettings([stateDirectory(root)], context.env)
    const message = yield* prepareMessage(request.messages, settings.allowWords ?? [])
    yield* requireCapability(context, "vcs.commit")
    const done = yield* commitGit({
      message,
      paths: request.paths,
      cloud: inCloudSession(context.env),
    })
    return { ...done, ...(yield* recordBranch(guardedState(context, "vcs.commit", state), done)) }
  })

/** Sets the local Git author using a trusted host's Git service. */
export const identity = (context: Context, input: typeof schemas.identity.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.identity, input)
    yield* requireCapability(context, "vcs.identity")
    return yield* setAuthor(request)
  })

/** Creates or updates a pull request and records the result in the active Intent. */
export const pr = (
  context: Context,
  root: string,
  state: VcsState,
  input: typeof schemas.pr.Encoded,
) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.pr, input)
    yield* requireCapability(context, "vcs.pr")
    const usage = "vcs pr --base <b> --title <t> [--body-file <f>] [--update <n>]"
    if (request.update !== undefined && request.update < 1)
      return yield* new Usage({
        message: `--update needs a pull request number, not "${request.update}"`,
        hint: `Usage: holyagent ${usage}`,
      })
    if (request.update === undefined && request.base === undefined)
      return yield* new Usage({ message: "Missing --base", hint: `Usage: holyagent ${usage}` })
    if (request.update === undefined && request.title === undefined)
      return yield* new Usage({ message: "Missing --title", hint: `Usage: holyagent ${usage}` })
    const settings = yield* readSettings([stateDirectory(root)], context.env)
    yield* requireCapability(context, "vcs.pr")
    return yield* pullRequest({
      state: guardedState(context, "vcs.pr", state),
      root,
      base: request.base,
      title: request.title,
      bodyFile: request.bodyFile,
      update: request.update,
      allowWords: settings.allowWords ?? [],
    })
  })
