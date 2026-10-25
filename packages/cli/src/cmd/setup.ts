import { Command } from "effect/cli"

import { setupClaudeCommand } from "./setup-claude.ts"

/** The `holyagent setup` command; its subcommand names the harness to set up. */
export const setupCommand = Command.make("setup")
  .pipe(
    Command.withDescription(
      "Install and configure HolyAgent for a coding harness. Name the harness: `holyagent setup claude`.",
    ),
  )
  .pipe(Command.withShortDescription("Set up HolyAgent for a harness (claude)"))
  .pipe(Command.withSubcommands([setupClaudeCommand]))
