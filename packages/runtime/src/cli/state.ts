import { Effect, Schema } from "effect"

import { StateMode } from "../state/mode.ts"
import { readStateMode, setStateMode } from "../state/tree.ts"
import { Usage } from "./errors.ts"
import type { Command } from "./types.ts"
import { present } from "./views.ts"

/** The `state` commands. */
export const STATE_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["state", "mode"],
    usage: "state mode [branch|work|local]",
    summary:
      "Show where this clone keeps Intent, Assignment and state records, or set it: branch (the holyagent/state branch, the default, for projects whose PRs stack), work (the work tree's .holyagent/, committed with the work) or local (the same folder, kept out of git)",
    notes: [
      "the mode is stored in this clone's git config (holyagent.stateMode), never in a file of the repository; unset means branch",
      "branch: every transition is committed on the state branch in one shared worktree, and the root pushes that branch; work: `vcs commit` stages the changed .holyagent/ files with the work; local: .holyagent/ is added to .git/info/exclude (not .gitignore), so no commit and no PR carries it",
      "set the mode before the first Intent of a project. Records are never moved or deleted: changing away from branch is refused once the state branch exists, changing onto it is refused while the work tree's .holyagent/ holds records, and local is refused while git tracks .holyagent/ (use work). work and local switch freely",
    ],
    flags: {},
    stateless: true,
    positionals: 1,
    optional: true,
    run: ({ args, cwd, env }) =>
      Effect.gen(function* () {
        const [given] = args.positionals
        if (given === undefined) return present({ ...(yield* readStateMode(cwd, env)) })
        const mode = yield* Schema.decodeUnknownEffect(StateMode)(given).pipe(
          Effect.mapError(
            () =>
              new Usage({
                message: `"${given}" is not a state mode`,
                hint: "Usage: holyagent state mode [branch|work|local]",
              }),
          ),
        )
        const { previous } = yield* setStateMode(cwd, env, mode)
        return present({ ...(yield* readStateMode(cwd, env)), previous })
      }),
  },
]
