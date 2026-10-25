import { dirname } from "node:path"

import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { type Call, type Command, Streamed } from "../cli/types.ts"
import { present } from "../cli/views.ts"
import { type FlagShape, readArguments, requiredValue, valueOf } from "./arguments.ts"
import { branch } from "./branch.ts"
import { ciLine, parseTarget, summarize, watchCi } from "./ci.ts"
import { commit } from "./commit.ts"
import { detect } from "./detect.ts"
import { RemoteMismatch } from "./errors.ts"
import { originUrl, repoSlug } from "./git.ts"
import { prepareMessage } from "./message.ts"
import type { Detection } from "./model.ts"
import { pullRequest } from "./pr.ts"
import { push } from "./push.ts"
import { readSettings } from "./settings.ts"

const rootOf = (call: Call) => dirname(call.directory)

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

const person = (detection: Detection) =>
  detection.owner === undefined ? undefined : detection.owner.login

const short = (sha: string) => sha.slice(0, 7)

const DETECT_USAGE = "vcs detect [--refresh]"
const COMMIT_USAGE = "vcs commit -m <headline> [-m <body>] -- <paths…>"
const PUSH_USAGE = "vcs push [<branch>…]"
const BRANCH_USAGE = "vcs branch <name> [--from <ref>]"
const PR_USAGE = "vcs pr --base <b> --title <t> [--body-file <f>] [--update <n>]"
const CI_USAGE = "vcs ci <pr-number|sha> [--watch [--timeout <s>]]"

const POLL_MILLIS = 15_000
const NO_CHECKS_GRACE_MILLIS = 60_000
const DEFAULT_TIMEOUT_SECONDS = 1800

/** The `vcs` commands: every commit, branch, push, pull request and CI step of a change. */
export const VCS_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["vcs", "detect"],
    usage: DETECT_USAGE,
    summary: "Choose how commits are made (git, api or git-owner) and cache it for the session",
    flags: {},
    raw: true,
    positionals: 0,
    run: (call) =>
      Effect.gen(function* () {
        const args = yield* arguments_(call, DETECT_USAGE, { refresh: { kind: "switch" } }, 0)
        const { detection, cached } = yield* detect(
          call.directory,
          rootOf(call),
          args.switches.has("refresh"),
        )
        return present({
          path: detection.path,
          signed: detection.signed,
          owner: person(detection),
          identity: `${detection.identity.name} <${detection.identity.email}>`,
          repo: repoSlug(detection.remote),
          reason: detection.reason,
          cached,
        })
      }).pipe(Effect.provide(call.vcs)),
  },
  {
    path: ["vcs", "commit"],
    usage: COMMIT_USAGE,
    summary:
      "Commit exactly the named paths (plus the Intent state folder when it changed) as the GitHub owner, with no attribution",
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
        const root = rootOf(call)
        const settings = yield* readSettings(root)
        const message = yield* prepareMessage(messages, settings.allowWords ?? [])
        const done = yield* commit({
          directory: call.directory,
          root,
          message,
          paths: args.positionals,
        })
        return present({
          path: done.detection.path,
          signed: done.detection.signed,
          branch: done.branch,
          commit: done.commits.length === 1 ? short(done.commits[0] ?? "") : undefined,
          commits: done.commits.length > 1 ? done.commits.map(short) : undefined,
          files: done.files,
          state: done.state,
          ...done.extra,
        })
      }).pipe(Effect.provide(call.vcs)),
  },
  {
    path: ["vcs", "push"],
    usage: PUSH_USAGE,
    summary: "Push branches in one `git push -u origin` (never forced); a no-op on the api path",
    flags: {},
    raw: true,
    positionals: 0,
    run: (call) =>
      Effect.gen(function* () {
        const args = yield* arguments_(call, PUSH_USAGE, {}, "any")
        const done = yield* push(call.directory, rootOf(call), args.positionals)
        return present({ ...done })
      }).pipe(Effect.provide(call.vcs)),
  },
  {
    path: ["vcs", "branch"],
    usage: BRANCH_USAGE,
    summary: "Create a branch (on GitHub too on the api path) and switch to it",
    flags: {},
    raw: true,
    positionals: 0,
    run: (call) =>
      Effect.gen(function* () {
        const args = yield* arguments_(call, BRANCH_USAGE, { from: { kind: "one" } }, 1)
        const name = args.positionals[0] ?? ""
        return yield* branch(call.directory, rootOf(call), name, valueOf(args, "from"))
      }).pipe(Effect.provide(call.vcs)),
  },
  {
    path: ["vcs", "pr"],
    usage: PR_USAGE,
    summary: "Create a pull request from the current branch, or update one, through the REST API",
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
        const root = rootOf(call)
        const settings = yield* readSettings(root)
        return yield* pullRequest({
          directory: call.directory,
          root,
          base: valueOf(args, "base"),
          title: valueOf(args, "title"),
          bodyFile: valueOf(args, "body-file"),
          update,
          allowWords: settings.allowWords ?? [],
        })
      }).pipe(Effect.provide(call.vcs)),
  },
  {
    path: ["vcs", "ci"],
    usage: CI_USAGE,
    summary:
      "Print one line of CI state for a PR or commit; --watch prints on change and exits 0 green, 1 red, 124 on timeout",
    output: "`sha=<short> failed=N pending=N passed=N mergeable=<v> state=<s>` lines, not TOON",
    flags: {},
    raw: true,
    positionals: 0,
    run: (call) =>
      Effect.gen(function* () {
        const args = yield* arguments_(
          call,
          CI_USAGE,
          { watch: { kind: "switch" }, timeout: { kind: "one" } },
          1,
        )
        const target = yield* parseTarget(args.positionals[0] ?? "")
        const seconds = Number(valueOf(args, "timeout") ?? DEFAULT_TIMEOUT_SECONDS)
        if (!Number.isFinite(seconds) || seconds < 0)
          return yield* new Usage({
            message: `--timeout needs a number of seconds, not "${valueOf(args, "timeout")}"`,
            hint: `Usage: holyagent ${CI_USAGE}`,
          })
        const repo = repoSlug(yield* originUrl)
        if (repo === undefined)
          return yield* new RemoteMismatch({
            reason: "origin is not set or does not name a GitHub repository",
          })
        if (args.switches.has("watch"))
          return new Streamed(
            yield* watchCi(repo, target, {
              timeoutMillis: seconds * 1000,
              intervalMillis: POLL_MILLIS,
              graceMillis: NO_CHECKS_GRACE_MILLIS,
              emit: call.emit,
            }),
          )
        yield* call.emit(`${ciLine(yield* summarize(repo, target))}\n`)
        return new Streamed(0)
      }).pipe(Effect.provide(call.vcs)),
  },
]
