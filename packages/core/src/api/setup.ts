import { Effect, Schema } from "effect"

import { doctor as runDoctor } from "../setup/doctor.ts"
import { FORM_CHOICES } from "../setup/form.ts"
import { SCOPES } from "../setup/scope.ts"
import { CACHE_TTLS } from "../setup/settings.ts"
import { setup as runSetup } from "../setup/steps.ts"
import { type Context, decode, requireCapability } from "./context.ts"
import { Usage } from "./usage.ts"

const Form = Schema.Struct({
  form: Schema.Literals(FORM_CHOICES),
  source: Schema.Literals(["flag", "detected", "default"]),
  reason: Schema.String,
})
const Choices = Schema.Struct({
  subagents: Schema.optionalKey(Schema.Boolean),
  contextCompression: Schema.optionalKey(Schema.Boolean),
  todo: Schema.optionalKey(Schema.Boolean),
  ask: Schema.optionalKey(Schema.Boolean),
  processes: Schema.optionalKey(Schema.Boolean),
  mcp: Schema.optionalKey(Schema.Boolean),
  computerUse: Schema.optionalKey(Schema.Boolean),
  browserUse: Schema.optionalKey(Schema.Boolean),
  lunaReserve: Schema.optionalKey(Schema.Boolean),
  contextManagement: Schema.optionalKey(Schema.Boolean),
  autoReview: Schema.optionalKey(Schema.Boolean),
  justBash: Schema.optionalKey(Schema.Boolean),
  fff: Schema.optionalKey(Schema.Boolean),
})

/** Strict operation inputs; host environment and process access remain trusted services. */
export const schemas = {
  setup: Schema.Struct({
    subagentCacheTtl: Schema.Literals(CACHE_TTLS),
    dryRun: Schema.Boolean,
    skipCtx7: Schema.Boolean,
    scope: Schema.optionalKey(Schema.Literals(SCOPES)),
    undo: Schema.optionalKey(Schema.Boolean),
    worktrees: Schema.optionalKey(Schema.Boolean),
    deviceAccess: Schema.optionalKey(Schema.Boolean),
    capabilities: Schema.optionalKey(Choices),
    form: Schema.optionalKey(Form),
  }),
  doctor: Schema.Struct({
    fix: Schema.Boolean,
    scope: Schema.optionalKey(Schema.Literals(SCOPES)),
    form: Schema.optionalKey(Form),
  }),
}

/** Runs setup against the host-supplied process service and working directory. */
export const setup = (context: Context, input: typeof schemas.setup.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.setup, input)
    yield* requireCapability(context, "setup")
    if (
      request.undo === true &&
      (Object.keys(request.capabilities ?? {}).length > 0 || request.form?.source === "flag")
    )
      return yield* new Usage({
        message: "--undo takes no capability flag and no --form",
        hint: "Choose undo without capability or form overrides.",
      })
    return yield* runSetup(context.env, { ...request, cwd: context.cwd })
  })

/** Runs diagnostics, optionally applying fixes only when the host authorizes them. */
export const doctor = (context: Context, input: typeof schemas.doctor.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.doctor, input)
    yield* requireCapability(context, request.fix ? "doctor.fix" : "doctor.read")
    return yield* runDoctor(context.env, { ...request, cwd: context.cwd })
  })
