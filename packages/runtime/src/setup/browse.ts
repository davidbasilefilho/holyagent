import { isAbsolute, join } from "node:path"

import { Effect, Schema } from "effect"

import { BROWSE_PACKAGE } from "../config/capabilities.ts"
import { PI_PACKAGE_VERSIONS } from "../config/pi-packages.ts"
import { type Env, firstNonEmpty, homeDirectory } from "./environment.ts"
import type { SetupFailure } from "./errors.ts"
import { readJsonText } from "./json-file.ts"

/** The release of opencode browse the `browser-use` capability runs, from the pin table. */
export const BROWSE_VERSION = PI_PACKAGE_VERSIONS[BROWSE_PACKAGE]

/** The command that sets browse up, at the pinned release: `npx -y @opencode/browse@<pin>`. */
export const BROWSE_COMMAND = `npx -y ${BROWSE_PACKAGE}@${BROWSE_VERSION}`

/**
 * What the person does when no browser is paired. Browse's `install` opens the extension's Chrome
 * Web Store page when no browser has it, pairs the browser it finds, and waits for the connection;
 * `pair` prints a one-time code to enter in the extension's options instead.
 */
export const BROWSE_PAIR_FIX = `run \`${BROWSE_COMMAND} install\`, which opens the browse extension's Chrome Web Store page when no browser has it and pairs the browser (\`${BROWSE_COMMAND} pair\` prints a code to enter in the extension's options instead)`

/**
 * The folder where browse keeps what it stores per user, as its own `dataRoot` resolves it:
 * `OPENCODE_BROWSER_HOME` when set, else `browse` in `XDG_DATA_HOME` (when absolute), else in
 * `.local/share` of the home directory, on every platform.
 */
export const browseDataDirectory = (env: Env): string => {
  const home = firstNonEmpty(env["OPENCODE_BROWSER_HOME"])
  if (home !== undefined) return home
  const data = firstNonEmpty(env["XDG_DATA_HOME"])
  return join(
    data !== undefined && isAbsolute(data) ? data : join(homeDirectory(env), ".local", "share"),
    "browse",
  )
}

/** The file where browse records each browser it paired with, as a record by profile key. */
export const browsePairingFile = (env: Env): string =>
  join(browseDataDirectory(env), "browser-tokens.json")

const Open = Schema.Record(Schema.String, Schema.Unknown)

// One pairing record. Browse keeps an entry only with a 43-character base64url token (it drops any
// other when it reads the file), and adds fields of its own over time, which the open rest allows.
const Pairing = Schema.StructWithRest(
  Schema.Struct({
    token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
    pairedAt: Schema.optionalKey(Schema.Number),
    lastSeen: Schema.optionalKey(Schema.Number),
    id: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
  }),
  [Open],
)

const PairingFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** One browser paired with browse. The token never leaves the file. */
export interface PairedBrowser {
  /** The browser profile's key in browse's file. */
  readonly key: string
  /** The id the browser connected under, once it has connected. */
  readonly id?: string
  /** The name the browser connected under, once it has connected. */
  readonly name?: string
  /** When the browser was last seen connected, in milliseconds since the epoch. */
  readonly lastSeen?: number
}

/** Whether browse holds a pairing, as far as its stored state tells. */
export type BrowsePairing =
  | { readonly state: "paired"; readonly browsers: ReadonlyArray<PairedBrowser> }
  | { readonly state: "unpaired" }

/**
 * Reads which browsers are paired with browse from the file browse itself keeps (the list `browse
 * pair --list` prints), without starting browse or its relay and without the network. A pairing
 * exists only after the extension connected and redeemed a code, so a pairing means the extension
 * is installed and paired; no pairing means either that the extension is not installed or that it
 * is not paired, which browse cannot tell apart before a browser connects. Whether a paired browser
 * is open right now is the relay's to say (`browse status`) and is not read here. A missing file,
 * empty or not an object, and entries browse itself would drop, count as no pairing; a file that
 * cannot be read is a {@link SetupFailure}.
 */
export const readBrowsePairing = (env: Env): Effect.Effect<BrowsePairing, SetupFailure> =>
  Effect.gen(function* () {
    const text = yield* readJsonText(browsePairingFile(env))
    if (text === undefined || text.trim() === "") return { state: "unpaired" } as const
    const entries = yield* Schema.decodeUnknownEffect(PairingFile)(text, {
      onExcessProperty: "error",
    }).pipe(Effect.orElseSucceed((): Record<string, unknown> => ({})))
    const browsers = Object.entries(entries).flatMap(([key, value]) => {
      const entry = Schema.decodeUnknownOption(Pairing)(value, { onExcessProperty: "error" })
      return entry._tag === "None"
        ? []
        : [
            {
              key,
              ...(entry.value.id === undefined ? {} : { id: entry.value.id }),
              ...(entry.value.name === undefined ? {} : { name: entry.value.name }),
              ...(entry.value.lastSeen === undefined ? {} : { lastSeen: entry.value.lastSeen }),
            } satisfies PairedBrowser,
          ]
    })
    return browsers.length === 0
      ? ({ state: "unpaired" } as const)
      : ({ state: "paired", browsers } as const)
  })

const seen = (browser: PairedBrowser): string =>
  browser.lastSeen === undefined
    ? "not connected yet"
    : `last seen ${new Date(browser.lastSeen).toISOString()}`

/**
 * One phrase on what the pairing state says, for a doctor or setup line: how many browsers are
 * paired and under what name, or that none is.
 */
export const describePairing = (pairing: BrowsePairing): string =>
  pairing.state === "unpaired"
    ? "no browser is paired with browse (the extension is not installed or not paired; browse cannot tell which)"
    : `${pairing.browsers.length === 1 ? "1 browser" : `${pairing.browsers.length} browsers`} paired with browse (the extension is installed): ${pairing.browsers
        .map((browser) => `${browser.name ?? browser.id ?? browser.key}, ${seen(browser)}`)
        .join("; ")}`
