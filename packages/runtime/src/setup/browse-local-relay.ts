import { get } from "node:http"
import { isAbsolute, join } from "node:path"

import { Effect, Option, Schema } from "effect"

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
) {
  const refuse = (message: string) => new SetupFailure({ message })
  const custom = firstNonEmpty(env.OPENCODE_BROWSER_HOME)
  if (custom !== undefined && !isAbsolute(custom))
    return yield* refuse("OPENCODE_BROWSER_HOME must be absolute for automatic pairing")
  // Match the npm package's native relay path resolution, not a Windows/Unix shell fallback.
  const home = env.HOME ?? env.USERPROFILE
  const root = (xdg: string | undefined, folder: string) =>
    custom ??
    (xdg !== undefined && isAbsolute(xdg)
      ? join(xdg, "browse")
      : home !== undefined && isAbsolute(home)
        ? join(home, folder, "browse")
        : undefined)
  const config = root(env.XDG_CONFIG_HOME, ".config")
  const state = root(env.XDG_STATE_HOME, ".local/state")
  if (
    config === undefined ||
    state === undefined ||
    root(env.XDG_DATA_HOME, ".local/share") === undefined
  )
    return yield* refuse(
      "the Browse relay folders could not be verified; use Browse's own pairing instructions",
    )
  const { value } = yield* readJsonObjectSnapshot(join(config, "config.json"))
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
  const ports = new Set([port])
  if (!validPort(pinned)) {
    const { value: receipt } = yield* readJsonObjectSnapshot(
      join(state, "relays", String(port), "relay.json"),
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
