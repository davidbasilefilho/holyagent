// Bun has no `realpath` or `readlink`, so those two stay on node:fs; the file reads and writes use Bun.
import { readlink, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { Type } from "typebox"

import type { Config } from "../../../runtime/src/config/schema.ts"
import { RoleTask, routeFor } from "../../../runtime/src/domain/route.ts"
import type { PiFamily } from "../../../runtime/src/instructions/families.ts"
import {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_TOOL,
  applyPatch,
  PatchFileError,
  type PatchFs,
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
import { providerProfile } from "../../../runtime/src/pi/provider.ts"
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
  if (config.pi.provider !== "openai-codex") return undefined
  const profile = providerProfile(config)
  return {
    family: profile.family,
    contextManagement: contextManagementOn(config),
    lunaReserve: config.pi.features.lunaReserve,
    applyPatchAgents: RoleTask.literals.flatMap((roleTask) =>
      toolArgs(config, roleTask, profile).tools.includes(APPLY_PATCH_TOOL)
        ? [routeFor(roleTask).agent]
        : [],
    ),
  }
}

const fileFailure = (path: string) => (cause: unknown) =>
  new PatchFileError({ path, reason: cause instanceof Error ? cause.message : String(cause) })

const isMissing = (error: PatchFileError): boolean => /ENOENT|ENOTDIR/.test(error.reason)

// The path with its links resolved. A path that is not there yet is its nearest existing ancestor,
// resolved, and the rest; a link whose target is missing still decides where a write lands, so it
// is followed by hand.
const realPath = (path: string): Effect.Effect<string, PatchFileError> =>
  Effect.tryPromise({ try: () => realpath(path), catch: fileFailure(path) }).pipe(
    Effect.catch((error) =>
      isMissing(error)
        ? Effect.tryPromise({ try: () => readlink(path), catch: fileFailure(path) }).pipe(
            Effect.matchEffect({
              onFailure: () =>
                realPath(dirname(path)).pipe(Effect.map((parent) => join(parent, basename(path)))),
              onSuccess: (target) => realPath(resolve(dirname(path), target)),
            }),
          )
        : Effect.fail(error),
    ),
  )

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
  remove: (path) =>
    Effect.tryPromise({ try: () => Bun.file(path).delete(), catch: fileFailure(path) }),
  real: realPath,
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
 *   changed under it.
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
  // A new session starts on the regular model: the reserve of the one before does not carry over.
  pi.on("session_start", () => {
    forget()
    reserve = false
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
    if (host.settings()?.lunaReserve !== true || !reserve) return undefined
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
