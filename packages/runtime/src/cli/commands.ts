import { VCS_COMMANDS } from "../vcs/commands.ts"
import { ASSIGNMENT_COMMANDS } from "./assignment.ts"
import { HOOK_COMMANDS } from "./hook.ts"
import { INTENT_COMMANDS } from "./intent.ts"
import { MIGRATE_COMMANDS } from "./migrate.ts"
import { OVERVIEW_COMMANDS } from "./overview.ts"
import { SETUP_COMMANDS } from "./setup.ts"
import { STATE_COMMANDS } from "./state.ts"
import { TOOL_COMMANDS } from "./tools.ts"
import type { Command } from "./types.ts"

/** Every command, in the order the help lists them. */
export const COMMANDS: ReadonlyArray<Command> = [
  ...INTENT_COMMANDS,
  ...ASSIGNMENT_COMMANDS,
  ...OVERVIEW_COMMANDS,
  ...MIGRATE_COMMANDS,
  ...SETUP_COMMANDS,
  ...STATE_COMMANDS,
  ...TOOL_COMMANDS,
  ...VCS_COMMANDS,
  ...HOOK_COMMANDS,
]
