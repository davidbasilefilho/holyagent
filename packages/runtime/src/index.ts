export * from "./config/index.ts"
export * from "./domain/acceptance.ts"
export * from "./domain/assignment.ts"
export * from "./domain/directive.ts"
export * from "./domain/errors.ts"
export * from "./domain/host.ts"
export * from "./domain/ids.ts"
export * from "./domain/input.ts"
export * from "./domain/intent.ts"
export * from "./domain/lifecycle.ts"
export * from "./domain/paths.ts"
export * from "./domain/plan.ts"
export * from "./domain/primitives.ts"
export * from "./domain/readiness.ts"
export * from "./domain/project.ts"
export * from "./domain/route.ts"
export * from "./domain/slug.ts"
export * from "./domain/specialists.ts"
export * from "./instructions/coverage.ts"
export * from "./instructions/families.ts"
export * from "./state/errors.ts"
export * from "./state/layout.ts"
export * from "./state/local.ts"
export * from "./state/store.ts"

// What `hook session-start` builds its context from, for a host that does not run the Claude hook:
// the status and reconcile result, the core of the root rules, and the context builders.
export { hasStateFolder, RESUMED, requirementsOf } from "./cli/hook.ts"
export { resumeOf, statusOf } from "./cli/overview.ts"
export {
  bareContext,
  CLOUD_IDENTITY,
  CONTEXT_BUDGET,
  type IntentRequirements,
  legacyContext,
  ROOT_TAKEOVER,
  SESSION_REMINDER,
  sessionContext,
} from "./cli/sessioncontext.ts"
export { ROOT_CORE } from "./instructions/claude-5.5/root-core.ts"
