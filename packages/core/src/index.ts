/** Typed Assignment application operations. */
export * as assignment from "./api/assignment.ts"
/** Typed Intent application operations. */
export * as intent from "./api/intent.ts"
/** Typed version-control application operations. */
export * as vcs from "./api/vcs.ts"
/** Typed installation and diagnostics operations. */
export * as setup from "./api/setup.ts"
export { Shell, type ShellResult, type WhichOptions } from "./setup/shell.ts"
export { FileSystem, nodeFileSystem } from "./ports/filesystem.ts"
export { Git, gitLive, type GitResult } from "./vcs/git.ts"
export { GitHub, githubLive, type RestRequest } from "./vcs/github.ts"
export { type Capability, type Context, NoActiveIntent, Unauthorized } from "./api/context.ts"

export { handoff, plan, reconcile, stateMode, status } from "./api/overview.ts"
/** Strict overview operation schemas. */
export { schemas as overviewSchemas } from "./api/overview.ts"

export { migrate, schema as migrationSchema } from "./api/migrate.ts"

export {
  executionConfig,
  makeContext,
  workflowAvailability,
  type ContextOptions,
} from "./api/construct.ts"
export { loadConfig as loadHolyagentConfig, loadConfigWithSource } from "./config/load.ts"
export { stateDirectory } from "./state/layout.ts"
export { resolveState } from "./state/tree.ts"
