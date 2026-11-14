// Bun has no `realpath`, `readlink`, `lstat`, `chmod` or `symlink`, so those stay on node:fs; the
// file reads, writes and deletes use Bun.
import { chmod, lstat, readlink, realpath, symlink } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { Type } from "typebox"

import type { Config } from "../../../runtime/src/config/schema.ts"
import { agentFor, RoleTask, routeFor } from "../../../runtime/src/domain/route.ts"
import type { PiFamily } from "../../../runtime/src/instructions/families.ts"
import {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_TOOL,
  applyPatch,
  PatchFileError,
  type PatchFs,
  type Snapshot,
} from "../../../runtime/src/pi/codex/apply-patch.ts"
import {
  compactThreshold,
  contextManagementOn,
  isCodexProvider,
  NO_COMPACTION,
  observeStreamEvent,
  prepareRequest,
} from "../../../runtime/src/pi/codex/context-management.ts"
import {
  endedOnUsageLimit,
  ENTER_NOTICE,
  EXIT_NOTICE,
  type Fetch,
  fetchReserveOffered,
  toReserve,
  UsageStatusUnavailable,
} from "../../../runtime/src/pi/codex/luna-reserve.ts"
import { CODEX_PROVIDER_ID } from "../../../runtime/src/pi/codex/routes.ts"
import { PROVIDERS } from "../../../runtime/src/pi/provider.ts"
import { toolArgs } from "../../../runtime/src/pi/tools.ts"

/**
 * What a config decides for the Codex provider's module: nothing at all (`undefined`) unless the
 * config selects the Codex provider. The extension reads this from the config it collects, for
 * every session, so each of the module's behaviors is one of these fields.
 */
export interface CodexSettings {
  /** The instruction family the root and the specialists run on. */
  readonly family: PiFamily
  /** Whether requests carry `context_management` (the provider selected, Billion Context off). */
  readonly contextManagement: boolean
  /** Whether the Luna Reserve fallback is on (`pi.features.lunaReserve`). */
  readonly lunaReserve: boolean
  /** The specialists (by agent name) that have `apply_patch` beside Pi's own write tools. */
  readonly applyPatchAgents: ReadonlyArray<string>
}

/**
 * The module's settings for a config, or `undefined` when the provider is not Codex, so every other
 * provider runs exactly as before.
 */
export const codexSettings = (config: Config): CodexSettings | undefined => {
  if (
    config.pi.provider !== "openai-codex" &&
    !Object.values(config.pi.routes).some((row) => row.provider === "openai-codex")
  )
    return undefined
  const profile = PROVIDERS["openai-codex"]
  return {
    family: profile.family,
    contextManagement: contextManagementOn(config),
    lunaReserve: config.pi.features.lunaReserve,
    applyPatchAgents: RoleTask.literals.flatMap((roleTask) =>
      toolArgs(config, roleTask, profile).tools.includes(APPLY_PATCH_TOOL)
        ? [
            agentFor(routeFor(roleTask), false),
            agentFor(routeFor(roleTask), true, "normal"),
            agentFor(routeFor(roleTask), true, "headless"),
          ]
        : [],
    ),
  }
}

const fileFailure = (path: string) => (cause: unknown) =>
  new PatchFileError({ path, reason: cause instanceof Error ? cause.message : String(cause) })

const isMissing = (error: PatchFileError): boolean => /ENOENT|ENOTDIR/.test(error.reason)

// What `readlink` answers for a path that is no link: nothing there, or something else there.
const isNoLink = (error: PatchFileError): boolean => isMissing(error) || /EINVAL/.test(error.reason)

// The links one resolution may follow, as many as the kernel allows a single lookup.
const MAX_LINKS = 40

const linkTarget = (path: string) =>
  Effect.tryPromise({ try: () => readlink(path), catch: fileFailure(path) })

// The path with its links resolved. A path that is not there yet is its nearest existing ancestor,
// resolved, and the rest. A link whose target is missing still decides where a write lands, so it
// is followed by hand: its target is read against the folder the link really sits in (the
// resolved parent, not the written one, since `..` climbs from where a link is), and the result
// is resolved in turn, which follows a chain of links one by one. The kernel reports links that
// lead back to each other through a missing folder (`m -> nosuch/../l`, `l -> nosuch/../m`) as
// missing, so the hand-followed links are counted, and more than `MAX_LINKS` fail the lookup.
const realPath = (path: string): Effect.Effect<string, PatchFileError> =>
  Effect.suspend(() => {
    let followed = 0
    const resolveLinks = (current: string): Effect.Effect<string, PatchFileError> =>
      Effect.tryPromise({ try: () => realpath(current), catch: fileFailure(current) }).pipe(
        Effect.catch((error) =>
          isMissing(error)
            ? linkTarget(current).pipe(
                Effect.matchEffect({
                  onFailure: (failure) =>
                    isNoLink(failure)
                      ? resolveLinks(dirname(current)).pipe(
                          Effect.map((parent) => join(parent, basename(current))),
                        )
                      : Effect.fail(failure),
                  onSuccess: (target) =>
                    ++followed > MAX_LINKS
                      ? Effect.fail(
                          new PatchFileError({
                            path,
                            reason: `ELOOP: too many levels of symbolic links, resolving ${path}`,
                          }),
                        )
                      : resolveLinks(dirname(current)).pipe(
                          Effect.flatMap((parent) => resolveLinks(resolve(parent, target))),
                        ),
                }),
              )
            : Effect.fail(error),
        ),
      )
    return resolveLinks(path)
  })

// The stats of what sits at the path itself, a final link not followed, or `undefined` for nothing.
const statsOf = (path: string) =>
  Effect.tryPromise({ try: () => lstat(path), catch: fileFailure(path) }).pipe(
    Effect.catch((error) => (isMissing(error) ? Effect.succeed(undefined) : Effect.fail(error))),
  )

// Whether a link or something else sits at the path itself, without reading it.
const kindOf = (path: string): Effect.Effect<"link" | "file" | undefined, PatchFileError> =>
  statsOf(path).pipe(
    Effect.map((stats) =>
      stats === undefined ? undefined : stats.isSymbolicLink() ? "link" : "file",
    ),
  )

// What sits at the path itself: a link with its target, else the file's exact bytes and mode, else
// nothing. Only a link is passed to `readlink`, so its failures are real failures.
const snapshotOf = (path: string): Effect.Effect<Snapshot | undefined, PatchFileError> =>
  Effect.gen(function* () {
    const stats = yield* statsOf(path)
    if (stats === undefined) return undefined
    if (stats.isSymbolicLink()) return { kind: "link", target: yield* linkTarget(path) }
    const bytes = yield* Effect.tryPromise({
      try: () => Bun.file(path).bytes(),
      catch: fileFailure(path),
    })
    return { kind: "file", bytes, mode: stats.mode & 0o7777 }
  })

/** The patch's file system over the disk, through Bun's file API: what the tool runs on. */
export const nodePatchFs: PatchFs = {
  read: (path) =>
    Effect.tryPromise({ try: () => Bun.file(path).text(), catch: fileFailure(path) }).pipe(
      Effect.catch((error) => (isMissing(error) ? Effect.succeed(undefined) : Effect.fail(error))),
    ),
  // `Bun.write` creates the folders above the file.
  write: (path, text) =>
    Effect.tryPromise({ try: () => Bun.write(path, text), catch: fileFailure(path) }).pipe(
      Effect.asVoid,
    ),
  // Deleting a link unlinks the link and leaves its target.
  remove: (path) =>
    Effect.tryPromise({ try: () => Bun.file(path).delete(), catch: fileFailure(path) }),
  real: realPath,
  kind: kindOf,
  snapshot: snapshotOf,
  restore: (path, saved) =>
    saved.kind === "link"
      ? // A file written over the link's name goes first, since `symlink` refuses a name in use.
        Effect.tryPromise({ try: () => Bun.file(path).delete(), catch: fileFailure(path) }).pipe(
          Effect.catch((error) => (isMissing(error) ? Effect.void : Effect.fail(error))),
          Effect.andThen(
            Effect.tryPromise({ try: () => symlink(saved.target, path), catch: fileFailure(path) }),
          ),
        )
      : Effect.tryPromise({
          try: () => Bun.write(path, saved.bytes),
          catch: fileFailure(path),
        }).pipe(
          // `Bun.write` makes a deleted file with the default mode, so the mode is set back.
          Effect.andThen(
            Effect.tryPromise({ try: () => chmod(path, saved.mode), catch: fileFailure(path) }),
          ),
        ),
}

/** What the Codex module needs from the extension that hosts it. */
export interface CodexHost {
  /** The settings of the session, or `undefined` before the config is read or for another provider. */
  readonly settings: () => CodexSettings | undefined
  /** Tells the user something, to be shown with the next run. */
  readonly notify: (text: string) => void
  /** The file system `apply_patch` writes to; `node:fs` by default. A test passes its own. */
  readonly fs?: PatchFs
  /** The request function of the usage status call; the global `fetch` by default. */
  readonly fetcher?: Fetch
}

// The provider a finished assistant message came from, which Pi records on the message.
const turnProvider = (message: object): string | undefined =>
  "provider" in message && typeof message.provider === "string" ? message.provider : undefined

const asReserveFailure = (): UsageStatusUnavailable =>
  new UsageStatusUnavailable({ reason: "no credentials" })

/**
 * Registers the Codex provider's behavior on Pi: the `apply_patch` tool, `context_management` with
 * its compaction replay, and the Luna Reserve fallback. The module is inert (every handler returns
 * at once without touching the context) while `host.settings()` is `undefined`, so under any other
 * provider nothing changes; `apply_patch` is registered inactive and a specialist's session
 * activates it only for a config that selects Codex.
 *
 * - `before_provider_request`: for Codex requests, adds `context_management` and replays the last
 *   compaction when the settings say so, and sends the request to the reserve while it is in use.
 * - `provider_stream_event`: keeps the compaction item the server emits.
 * - `message_end` and `before_agent_start`: a turn that ended on a usage limit asks the backend
 *   whether Luna Reserve is offered and opens it; each later run asks whether ordinary usage is
 *   back and closes it.
 * - `session_start`, `session_compact` and `session_tree`: forget the compaction, since Pi's history
 *   changed under it; a new session also leaves the reserve.
 */
export const registerCodex = (pi: ExtensionAPI, host: CodexHost): void => {
  const fs = host.fs ?? nodePatchFs
  let compaction = NO_COMPACTION
  let reserve = false

  pi.registerTool({
    name: APPLY_PATCH_TOOL,
    label: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    promptSnippet: "Edit files with a patch",
    parameters: Type.Object({
      input: Type.String({ description: "The whole patch, from *** Begin Patch to *** End Patch" }),
    }),
    defaultActive: false,
    execute: async (_id, params, _signal, _update, ctx) => {
      const result = await Effect.runPromise(
        applyPatch(params.input, ctx.cwd, fs).pipe(
          Effect.mapError((error) => new Error(error.message)),
        ),
      )
      return { content: [{ type: "text", text: result.summary }], details: result.changes }
    },
  })

  const forget = () => {
    compaction = NO_COMPACTION
  }
  // The history behind the compaction is another one on every start. The reserve is a state of the
  // account, not of a session, so only a new session starts on the regular model; a resumed or
  // forked one keeps it (and `before_agent_start` closes it once ordinary usage is back), because
  // dropping it would send the next turn to the exhausted model. A reload builds this module anew,
  // so it starts on the regular model and the usage limit sends it back to the reserve.
  pi.on("session_start", (event) => {
    forget()
    if (event.reason === "new") reserve = false
  })
  pi.on("session_compact", forget)
  pi.on("session_tree", forget)

  pi.on("before_provider_request", (event, ctx) => {
    const settings = host.settings()
    if (settings === undefined || !isCodexProvider(ctx.model?.provider)) return undefined
    let payload = event.payload
    if (settings.contextManagement) {
      const prepared = prepareRequest(
        payload,
        compaction,
        compactThreshold(ctx.model?.contextWindow),
      )
      payload = prepared.payload
      compaction = prepared.state
    }
    if (settings.lunaReserve && reserve) payload = toReserve(payload)
    return payload === event.payload ? undefined : payload
  })

  pi.on("provider_stream_event", (event) => {
    if (host.settings()?.contextManagement === true && isCodexProvider(event.provider))
      compaction = observeStreamEvent(compaction, event.data)
  })

  // Whether the backend offers the reserve now, asked with the session's own access token; any
  // failure (no credentials, a refused or timed-out request) reads as "not offered".
  const offered = (ctx: ExtensionContext) =>
    Effect.tryPromise({
      try: () => ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER_ID),
      catch: asReserveFailure,
    }).pipe(
      Effect.flatMap((token) =>
        token === undefined
          ? Effect.fail(asReserveFailure())
          : fetchReserveOffered(token, host.fetcher),
      ),
      Effect.orElseSucceed(() => undefined),
      Effect.runPromise,
    )

  pi.on("message_end", async (event, ctx) => {
    // Only a turn that ran on Codex can have hit Codex's limit, and only Codex's token is sent on.
    if (
      host.settings()?.lunaReserve !== true ||
      reserve ||
      !isCodexProvider(turnProvider(event.message)) ||
      !endedOnUsageLimit(event.message)
    )
      return undefined
    if ((await offered(ctx)) === true) {
      reserve = true
      forget()
      host.notify(ENTER_NOTICE)
    }
    return undefined
  })

  pi.on("before_agent_start", async (_event, ctx) => {
    // The check sends Codex's token, so it runs only for a run that is about to use Codex.
    if (host.settings()?.lunaReserve !== true || !reserve || !isCodexProvider(ctx.model?.provider))
      return undefined
    // Only a clear "no longer offered" closes the reserve; a failed check keeps it, so a bad
    // connection never flips a session between the two.
    if ((await offered(ctx)) === false) {
      reserve = false
      forget()
      host.notify(EXIT_NOTICE)
    }
    return undefined
  })
}
