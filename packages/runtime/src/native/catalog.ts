import {
  assignment,
  type Context,
  handoff,
  intent,
  migrate,
  migrationSchema,
  overviewSchemas,
  plan,
  reconcile,
  stateMode,
  status,
} from "@holyagent/core"
import { reconcileRows, statusFrom } from "@holyagent/core/api/status-views.ts"
import { wordsFor } from "@holyagent/core/domain/host.ts"
import { Data, Effect, type Schema } from "effect"

/** Native operation availability; privilege is supplied only by the host adapter. */
export type Capability =
  | {
      readonly kind: "supported"
      readonly schema: Schema.Top
      readonly run: (context: Context, input: unknown) => Effect.Effect<unknown, unknown>
    }
  | { readonly kind: "unsupported"; readonly reason: string }

const supported = <A>(
  schema: Schema.Top,
  run: (context: Context, input: A) => Effect.Effect<unknown, unknown>,
): Capability => ({ kind: "supported", schema, run: (context, input) => run(context, input as A) })
const hook = {
  kind: "unsupported",
  reason: "Host hook payloads require the host lifecycle, not a model tool call.",
} as const

/** Every CLI identity is classified, with unknown operations denied. */
export const CAPABILITIES: Readonly<Record<string, Capability>> = {
  "intent create": supported(intent.schemas.create, intent.create),
  "intent show": supported(intent.schemas.show, intent.show),
  "intent list": supported(intent.schemas.list, intent.list),
  "intent update": supported(intent.schemas.update, intent.update),
  "intent close": supported(intent.schemas.close, intent.close),
  "intent reopen": supported(intent.schemas.reopen, intent.reopen),
  "intent use": supported(intent.schemas.use, intent.use),
  "assignment create": supported(assignment.schemas.create, assignment.create),
  "assignment dispatch": supported(assignment.schemas.dispatch, assignment.dispatch),
  "assignment record": supported(assignment.schemas.record, assignment.record),
  "assignment close": supported(assignment.schemas.close, assignment.close),
  "assignment accept": supported(assignment.schemas.accept, assignment.accept),
  "assignment reports": supported(assignment.schemas.reports, assignment.reports),
  "assignment show": supported(assignment.schemas.show, assignment.show),
  "assignment list": supported(assignment.schemas.list, assignment.list),
  plan: supported(overviewSchemas.plan, plan),
  status: supported(
    overviewSchemas.status,
    (context, input: typeof overviewSchemas.status.Encoded) =>
      status(context, input).pipe(Effect.map(statusFrom)),
  ),
  reconcile: supported(
    overviewSchemas.reconcile,
    (context, input: typeof overviewSchemas.reconcile.Encoded) =>
      reconcile(context, input).pipe(
        Effect.map((rows) => reconcileRows(rows, wordsFor(context.host))),
      ),
  ),
  handoff: supported(overviewSchemas.handoff, handoff),
  migrate: supported(migrationSchema, migrate),
  "state mode": supported(overviewSchemas.stateMode, stateMode),
  setup: {
    kind: "unsupported",
    reason: "Interactive setup and installation changes require terminal and approval contracts.",
  },
  doctor: {
    kind: "unsupported",
    reason:
      "Doctor --fix changes installation settings without an equivalent native approval contract.",
  },
  rg: { kind: "unsupported", reason: "Raw ripgrep passthrough is not a typed native tool." },
  fd: { kind: "unsupported", reason: "Raw fd passthrough is not a typed native tool." },
  "browser-server": {
    kind: "unsupported",
    reason: "A long-lived stdio server is not a model tool call.",
  },
  "vcs commit": {
    kind: "unsupported",
    reason: "Writing repository history lacks a proven equivalent native approval contract.",
  },
  "vcs identity": {
    kind: "unsupported",
    reason: "Changing Git identity lacks a proven equivalent native approval contract.",
  },
  "vcs pr": {
    kind: "unsupported",
    reason: "Remote publication lacks a proven equivalent native approval contract.",
  },
  "hook session-start": hook,
  "hook root-rules": hook,
  "hook agent-launch": hook,
  "hook subagent-start": hook,
  "hook vcs-reminder": hook,
  "hook commit-msg": hook,
  "hook workflow": hook,
}

/** A denied or unknown native operation. */
export class NativeDenied extends Data.TaggedError("NativeDenied")<{
  readonly command: string
  readonly reason: string
}> {
  /** The supported host action and why this call is unavailable. */
  override get message() {
    return this.reason
  }
}

/** Returns supported identities only for the host-established root capability. */
export const inventory = (root: boolean): ReadonlyArray<string> =>
  root
    ? Object.entries(CAPABILITIES).flatMap(([name, capability]) =>
        capability.kind === "supported" ? [name] : [],
      )
    : []

/** Runs a classified operation directly with its shared core decoder. */
export const executeNative = (
  context: Context,
  command: string,
  input: unknown,
): Effect.Effect<unknown, unknown> => {
  const capability = CAPABILITIES[command]
  if (capability?.kind !== "supported")
    return new NativeDenied({ command, reason: capability?.reason ?? "Unknown operation" })
  if (command === "state mode" && typeof input === "object" && input !== null && "mode" in input)
    return new NativeDenied({
      command,
      reason:
        "Changing Git state mode requires an approval contract unavailable to this native host; use the CLI.",
    })
  return capability.run(context, input)
}
