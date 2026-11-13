import { Console, Data, Effect, Schema } from "effect"

import {
  compareVersions,
  type InvalidVersion,
  type ManifestError,
  parseVersion,
  readVersion,
} from "./bump-version.ts"

/** A pull request breaks the release-branch model of this repository (see AGENTS.md). */
export class BranchModelViolation extends Data.TaggedError("BranchModelViolation")<{
  readonly rule: "main-base"
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
    return `Expected "branch-model <base> <head> [root]" or "version <main-root> <head-root> [head-ref]"; got ${this.args.join(" ") || "nothing"}`
  }
}

/** The pull request's base and head branches and the version its head carries. */
export interface PullRequest {
  readonly base: string
  readonly head: string
  readonly version: string
}

const REPAIR_BRANCH = /^release\/([^/]+)\/fix\/publication-repair$/

/** Requires pull requests into main to come from dev or the focused repair branch. */
export const checkBranchModel = ({
  base,
  head,
  version: _version,
}: PullRequest): Effect.Effect<void, BranchModelViolation | InvalidVersion> => {
  const violation = (rule: BranchModelViolation["rule"], detail: string) =>
    Effect.fail(new BranchModelViolation({ rule, base, head, detail }))
  return Effect.gen(function* () {
    if (base === "main" && head !== "dev" && !REPAIR_BRANCH.test(head))
      return yield* violation(
        "main-base",
        "only dev or a publication-repair branch may open a pull request into main",
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

/** The public registry could not establish whether a version was published. */
export class RegistryError extends Data.TaggedError("RegistryError")<{ readonly detail: string }> {
  /** The description shown to the user. */
  override get message() {
    return this.detail
  }
}

const Fields = Schema.Record(Schema.String, Schema.Unknown)
const open = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [Fields])
const RegistryVersion = open({ name: Schema.Literal("holyagent"), version: Schema.String })

/** Queries the exact public npm version and fails closed on unavailable or malformed metadata. */
export const lookupPublished = (
  version: string,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Effect.Effect<boolean, RegistryError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        request(`https://registry.npmjs.org/holyagent/${encodeURIComponent(version)}`, {
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        }),
      catch: (cause) =>
        new RegistryError({ detail: `Public npm registry request failed: ${String(cause)}` }),
    })
    if (response.status === 404) return false
    if (!response.ok)
      return yield* new RegistryError({ detail: `Public npm registry returned ${response.status}` })
    const body = yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: (cause) =>
        new RegistryError({ detail: `Invalid npm registry JSON: ${String(cause)}` }),
    })
    const metadata = yield* Schema.decodeUnknownEffect(RegistryVersion, {
      onExcessProperty: "error",
    })(body).pipe(
      Effect.mapError(
        (cause) => new RegistryError({ detail: `Invalid npm registry metadata: ${String(cause)}` }),
      ),
    )
    if (metadata.version !== version)
      return yield* new RegistryError({ detail: "Invalid npm registry version identity" })
    return true
  })

/** Allows an equal version only for the exact repair branch and an unpublished npm version. */
export const checkReleaseVersion = (
  main: string,
  head: string,
  headRef: string,
  lookup: (version: string) => Effect.Effect<boolean, RegistryError> = lookupPublished,
): Effect.Effect<void, VersionNotNewer | InvalidVersion | RegistryError> =>
  Effect.gen(function* () {
    const [mainVersion, headVersion] = yield* Effect.all([parseVersion(main), parseVersion(head)])
    const comparison = compareVersions(headVersion, mainVersion)
    const repair = REPAIR_BRANCH.exec(headRef)
    if (comparison > 0 && repair === null) return
    if (comparison !== 0 || main !== head || repair?.[1] !== head)
      return yield* new VersionNotNewer({ main, head })
    if (yield* lookup(head)) return yield* new VersionNotNewer({ main, head })
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
      yield* checkReleaseVersion(mainVersion, headVersion, third ?? "")
    } else return yield* new Usage({ args })
    yield* Console.log("ok")
  }).pipe(
    Effect.catch(
      (
        error:
          | BranchModelViolation
          | VersionNotNewer
          | InvalidVersion
          | ManifestError
          | RegistryError
          | Usage,
      ) =>
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
