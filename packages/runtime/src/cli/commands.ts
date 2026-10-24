import { ASSIGNMENT_COMMANDS } from "./assignment.ts"
import { INTENT_COMMANDS } from "./intent.ts"
import { OVERVIEW_COMMANDS } from "./overview.ts"
import type { Command } from "./types.ts"

/** Every command, in the order the help lists them. */
export const COMMANDS: ReadonlyArray<Command> = [
  ...INTENT_COMMANDS,
  ...ASSIGNMENT_COMMANDS,
  ...OVERVIEW_COMMANDS,
]
