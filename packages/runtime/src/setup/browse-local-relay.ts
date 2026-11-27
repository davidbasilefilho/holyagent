import { get } from "node:http"
import { posix, win32 } from "node:path"

import { Effect, Option, Schema } from "effect"

import { fileSystem } from "../../../core/src/ports/filesystem.ts"
import { readJsonObjectSnapshot } from "../../../core/src/setup/json-file.ts"
import { type Env, firstNonEmpty } from "./environment.ts"
import { SetupFailure } from "./errors.ts"

const DEFAULT_PORT = 19988
const validPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535
const RelayVersion = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String, runtime: Schema.optionalKey(Schema.String) }),
)

/** A read-only, bounded probe of a fixed loopback endpoint. No relay is started. */
export type BrowseRelayProbe = (port: number) => Effect.Effect<boolean>

/** OpenCode Browse 0.1.5 can replace a TypeScript relay when it runs `pair`. Do not do that. */
export const browseRelaySafe: BrowseRelayProbe = (port) =>
  Effect.callback<boolean>((resume) => {
    const request = get({ host: "127.0.0.1", port, path: "/version", agent: false }, (reply) => {
      if (reply.statusCode !== 200) {
        reply.destroy()
        resume(Effect.succeed(false))
        return
      }
      let body = ""
      reply.setEncoding("utf8")
      reply.on("data", (part: string) => {
        body += part
        if (body.length > 16_384) {
          reply.destroy()
          resume(Effect.succeed(false))
        }
      })
      reply.once("error", () => resume(Effect.succeed(false)))
      reply.once("end", () => {
        const decoded = Schema.decodeUnknownOption(RelayVersion)(body)
        resume(Effect.succeed(Option.isSome(decoded) && decoded.value.runtime === "rust"))
      })
    })
    request.once("error", (error: NodeJS.ErrnoException) =>
      resume(Effect.succeed(error.code === "ECONNREFUSED")),
    )
    return Effect.sync(() => {
      request.destroy()
    })
  }).pipe(Effect.timeoutOption(800), Effect.map(Option.getOrElse(() => false)))

/** Refuse desktop pairing when the official CLI may affect a remote or legacy relay. */
export const checkLocalBrowseRelay = Effect.fn("checkBrowseDesktopRelay")(function* (
  env: Env,
  probe: BrowseRelayProbe,
  platform: NodeJS.Platform = process.platform,
) {
  const refuse = (message: string) => new SetupFailure({ message })
  const windows = platform === "win32"
  const path = windows ? win32 : posix
  const absolute = (candidate: string) => {
    if (!path.isAbsolute(candidate)) return false
    if (!windows || /^[a-z]:[\\/]/i.test(candidate)) return true
    if (candidate.startsWith("\\\\?\\"))
      return /^(?:[a-z]:\\|unc\\[^\\]+\\[^\\]+(?:\\|$))/i.test(candidate.slice(4))
    return /^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+(?:[\\/]|$)/.test(candidate)
  }
  const custom = firstNonEmpty(env.OPENCODE_BROWSER_HOME)
  if (custom !== undefined && !absolute(custom))
    return yield* refuse("OPENCODE_BROWSER_HOME must be fully qualified for automatic pairing")
  // Match the npm package's native relay path resolution, not a Windows/Unix shell fallback.
  const home = env.HOME ?? env.USERPROFILE
  const xdgDirectories = [env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_DATA_HOME]
  if (
    custom === undefined &&
    windows &&
    xdgDirectories.some((dir) => dir !== undefined && path.isAbsolute(dir) && !absolute(dir))
  )
    return yield* refuse(
      "Browse cannot verify a Windows XDG path without a complete drive or UNC share",
    )
  const root = (xdg: string | undefined, folder: string) =>
    custom ??
    (xdg !== undefined && absolute(xdg)
      ? path.join(xdg, "browse")
      : home !== undefined && absolute(home)
        ? path.join(home, folder, "browse")
        : undefined)
  const config = root(env.XDG_CONFIG_HOME, ".config")
  const state = root(env.XDG_STATE_HOME, ".local/state")
  const data = root(env.XDG_DATA_HOME, ".local/share")
  if (config === undefined || state === undefined || data === undefined)
    return yield* refuse(
      "the Browse relay folders could not be verified; use Browse's own pairing instructions",
    )
  const { value } = yield* readJsonObjectSnapshot(path.join(config, "config.json"))
  const hostname = value.hostname
  if (
    hostname !== undefined &&
    (typeof hostname !== "string" ||
      !["127.0.0.1", "::1", "[::1]", "localhost"].includes(hostname.trim().toLowerCase()))
  )
    return yield* refuse(
      "the existing Browse relay is configured for remote access. Use Browse's own instructions instead of this local handoff",
    )
  const rawPort = env.OPENCODE_BROWSER_PORT?.trim() ?? ""
  const pinned = /^\+?\d+$/.test(rawPort) ? Number(rawPort) : NaN
  const port = validPort(pinned) ? pinned : DEFAULT_PORT
  // The native relay cleans up these old files on startup. Check only metadata and do not remove
  // or read them. An unreadable entry is not proof it is safe to start the relay.
  const fs = yield* fileSystem
  const legacyPaths = [
    path.join(data, "site-secrets"),
    path.join(data, "secrets"),
    path.join(data, "relays", String(port), "sessions.json"),
  ]
  for (const entry of legacyPaths) {
    const missing = yield* Effect.tryPromise(() => fs.lstat(entry)).pipe(
      Effect.match({
        onSuccess: () => false,
        onFailure: ({ cause }) =>
          cause instanceof Error && "code" in cause && cause.code === "ENOENT",
      }),
    )
    if (!missing)
      return yield* refuse(
        "Browse has legacy data or an unreadable data folder; use Browse's own instructions so setup does not change it",
      )
  }
  const ports = new Set([port])
  if (!validPort(pinned)) {
    const { value: receipt } = yield* readJsonObjectSnapshot(
      path.join(state, "relays", String(port), "relay.json"),
    )
    if (receipt.configuredPort === port && validPort(receipt.port)) ports.add(receipt.port)
  }
  for (const endpoint of ports) {
    if (!(yield* probe(endpoint)))
      return yield* refuse(
        "an existing listener could not be verified as a native Browse relay; use Browse's own instructions so setup does not replace it",
      )
  }
})
