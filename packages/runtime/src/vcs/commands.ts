import { join } from "node:path"

import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { type Call, type Command } from "../cli/types.ts"
import { present } from "../cli/views.ts"
import { STATE_DIRECTORY } from "../state/layout.ts"
import { type FlagShape, readArguments, requiredValue, valueOf } from "./arguments.ts"
import { commit } from "./commit.ts"
import { prepareMessage } from "./message.ts"
import { pullRequest } from "./pr.ts"
import { recordBranch } from "./record.ts"
import { readSettings } from "./settings.ts"

/** The state folders that may hold the config file: the state worktree's, then the work tree's. */
const settingsFolders = (call: Call) => [call.directory, join(call.root, STATE_DIRECTORY)]

/** Reads the raw arguments of a command against its flags, refusing more positionals than it takes. */
const arguments_ = (
  call: Call,
  usage: string,
  spec: Readonly<Record<string, FlagShape>>,
  positionals: number | "any",
) =>
  readArguments(call.args.positionals, spec, usage).pipe(
    Effect.filterOrFail(
      (args) => positionals === "any" || args.positionals.length === positionals,
      (args) =>
        new Usage({
          message: `Expected ${positionals} argument(s), got ${args.positionals.length}`,
          hint: `Usage: holyagent ${usage}`,
        }),
    ),
  )

const short = (sha: string) => sha.slice(0, 7)

const COMMIT_USAGE = "vcs commit -m <headline> [-m <body>] -- <paths…>"
const PR_USAGE = "vcs pr --base <b> --title <t> [--body-file <f>] [--update <n>]"

/**
 * The `vcs` commands: the two steps that carry a rule of their own. Branches, pushes, merges and CI
 * are plain git and gh.
 */
export const VCS_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["vcs", "commit"],
    usage: COMMIT_USAGE,
    summary:
      "Commit exactly the named paths with the configured git identity, after the message check, and record the branch and commit on the Intent in use",
    notes: [
      "Intent state is never part of the commit: it is committed on the state branch as it changes, and a path under .holyagent/ is refused",
      "the message is cleaned of agent attribution and refused when it talks about the user or the agent; an identity that looks like an agent's is refused",
      "the repository's own hooks run, a commit-msg hook that runs `holyagent hook commit-msg` included",
    ],
    flags: {},
    raw: true,
    positionals: 0,
    run: (call) =>
      Effect.gen(function* () {
        const args = yield* arguments_(
          call,
          COMMIT_USAGE,
          { message: { kind: "many", short: "m" } },
          "any",
        )
        const messages = args.values["message"] ?? []
        if (messages.length === 0 || args.positionals.length === 0)
          return yield* new Usage({
            message:
              messages.length === 0 ? "Missing -m <headline>" : "Name the paths to commit after --",
            hint: `Usage: holyagent ${COMMIT_USAGE}`,
          })
        const settings = yield* readSettings(settingsFolders(call))
        const message = yield* prepareMessage(messages, settings.allowWords ?? [])
        const done = yield* commit({ message, paths: args.positionals })
        return present({
          branch: done.branch,
          commit: short(done.commit),
          files: done.files,
          ...(yield* recordBranch(call, done)),
        })
      }).pipe(Effect.provide(call.vcs)),
  },
  {
    path: ["vcs", "pr"],
    usage: PR_USAGE,
    summary:
      "Create a pull request from the current branch, or update one, through the REST API, and record it on the Intent in use",
    notes: ["the title and body get the same message check as a commit"],
    flags: {},
    raw: true,
    positionals: 0,
    run: (call) =>
      Effect.gen(function* () {
        const args = yield* arguments_(
          call,
          PR_USAGE,
          {
            base: { kind: "one" },
            title: { kind: "one" },
            "body-file": { kind: "one" },
            update: { kind: "one" },
          },
          0,
        )
        const updating = valueOf(args, "update")
        const update = updating === undefined ? undefined : Number(updating)
        if (updating !== undefined && !/^[1-9]\d*$/.test(updating))
          return yield* new Usage({
            message: `--update needs a pull request number, not "${updating}"`,
            hint: `Usage: holyagent ${PR_USAGE}`,
          })
        if (update === undefined) {
          yield* requiredValue(args, "base", PR_USAGE)
          yield* requiredValue(args, "title", PR_USAGE)
        }
        const settings = yield* readSettings(settingsFolders(call))
        return yield* pullRequest({
          state: call,
          root: call.root,
          base: valueOf(args, "base"),
          title: valueOf(args, "title"),
          bodyFile: valueOf(args, "body-file"),
          update,
          allowWords: settings.allowWords ?? [],
        })
      }).pipe(Effect.provide(call.vcs)),
  },
]
