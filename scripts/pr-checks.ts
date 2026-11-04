import { Console, Data, Effect, Option } from "effect"

import {
  compareVersions,
  type InvalidVersion,
  type ManifestError,
  parseVersion,
  readVersion,
} from "./bump-version.ts"

/** A pull request breaks the release-branch model of this repository (see AGENTS.md). */
export class BranchModelViolation extends Data.TaggedError("BranchModelViolation")<{
  readonly rule: "main-base" | "branch-version" | "release-base"
  readonly base: string
  readonly head: string
  readonly detail: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.rule}: ${this.detail} (base ${this.base}, head ${this.head})`
  }
}

/** The head of a pull request into `main` does not carry a strictly newer version than `main`. */
export class VersionNotNewer extends Data.TaggedError("VersionNotNewer")<{
  readonly main: string
  readonly head: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `The head version ${this.head} must be strictly greater than the version ${this.main} on main; bump it with mise run bump:patch or bump:minor`
  }
}

/** The command line arguments are not one of the commands. */
export class Usage extends Data.TaggedError("Usage")<{ readonly args: ReadonlyArray<string> }> {
  /** The description shown to the user. */
  override get message() {
    return `Expected "branch-model <base> <head> [root]" or "version <main-root> <head-root>"; got ${this.args.join(" ") || "nothing"}`
  }
}

/** The pull request's base and head branches and the version its head carries. */
export interface PullRequest {
  readonly base: string
  readonly head: string
  readonly version: string
}

/** `release/<v>/<rest>`: the release a branch belongs to and the rest of its name. */
const RELEASE_BRANCH = /^release\/([^/]+)\/(.+)$/

/**
 * Checks a pull request against the release-branch model: into `main` only from
 * `release/<v>/integration`, a release branch's `<v>` equal to the version of its head, and into a
 * `release/<v>/...` branch only from a branch of the same release. Fails with the first rule
 * broken.
 */
export const checkBranchModel = ({
  base,
  head,
  version,
}: PullRequest): Effect.Effect<void, BranchModelViolation | InvalidVersion> => {
  const violation = (rule: BranchModelViolation["rule"], detail: string) =>
    Effect.fail(new BranchModelViolation({ rule, base, head, detail }))
  const headRelease = RELEASE_BRANCH.exec(head)
  const baseRelease = RELEASE_BRANCH.exec(base)
  return Effect.gen(function* () {
    if (headRelease !== null) {
      // Compared as versions, not strings, so `0.02.1` or a legacy `-Z` suffix is not a mismatch
      // by spelling alone and a malformed package.json fails here rather than on `main` only.
      const headVersion = yield* parseVersion(version)
      const named = yield* Effect.option(parseVersion(headRelease[1] ?? ""))
      if (Option.isNone(named) || compareVersions(named.value, headVersion) !== 0)
        return yield* violation(
          "branch-version",
          `the branch names release ${headRelease[1]} but the head carries version ${version}`,
        )
    }
    if (base === "main" && !(headRelease !== null && headRelease[2] === "integration"))
      return yield* violation(
        "main-base",
        "only release/<v>/integration may open a pull request into main",
      )
    if (baseRelease !== null && headRelease?.[1] !== baseRelease[1])
      return yield* violation(
        "release-base",
        `a pull request into a release/${baseRelease[1]}/... branch must come from a branch of release ${baseRelease[1]}`,
      )
  })
}

/** Fails unless `head` is strictly greater than `main` (ZeroVer: compared by minor, then patch). */
export const checkVersionNewer = (
  main: string,
  head: string,
): Effect.Effect<void, VersionNotNewer | InvalidVersion> =>
  Effect.gen(function* () {
    const [mainVersion, headVersion] = yield* Effect.all([parseVersion(main), parseVersion(head)])
    if (compareVersions(headVersion, mainVersion) <= 0)
      return yield* new VersionNotNewer({ main, head })
  })

/**
 * Runs `branch-model <base> <head> [root]` (the head's version is read from the root `package.json`
 * under `root`, the current directory by default) or `version <main-root> <head-root>`, prints the
 * failure and sets a failing exit code.
 */
export const main = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [command, first, second, third] = args
    if (command === "branch-model" && first !== undefined && second !== undefined) {
      const version = yield* readVersion(third ?? ".", "package.json")
      yield* checkBranchModel({ base: first, head: second, version })
    } else if (command === "version" && first !== undefined && second !== undefined) {
      const [mainVersion, headVersion] = yield* Effect.all([
        readVersion(first, "package.json"),
        readVersion(second, "package.json"),
      ])
      yield* checkVersionNewer(mainVersion, headVersion)
    } else return yield* new Usage({ args })
    yield* Console.log("ok")
  }).pipe(
    Effect.catch(
      (error: BranchModelViolation | VersionNotNewer | InvalidVersion | ManifestError | Usage) =>
        Console.error(`error: ${error._tag}: ${error.message}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1
            }),
          ),
        ),
    ),
  )

if (import.meta.main) await Effect.runPromise(main(Bun.argv.slice(2)))
