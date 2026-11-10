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
 * What the person does when the browse extension is in no browser: `install` opens the extension's
 * Chrome Web Store page and pairs the browser once the extension is added.
 */
export const BROWSE_INSTALL_FIX = `run \`${BROWSE_COMMAND} install\`, which opens the browse extension's Chrome Web Store page, and add it to your browser`

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

/**
 * The ids of the browse extension that browse itself looks for in a browser's profiles: its Chrome
 * Web Store item and the unpacked build of a source checkout (`STORE_IDS` and `unpackedExtensionId`
 * of `@opencode/browse` 0.0.15).
 */
export const BROWSE_EXTENSION_IDS: ReadonlyArray<string> = [
  "mfnicocicmmlkpjnaffgihfjhdgjkdjg",
  "afeafocngkodbmaipcngoamamfmekgfo",
]

/** A browser the extension check scans: its name and the folder that holds its profiles. */
interface BrowserDirectory {
  readonly name: string
  readonly directory: string
}

/**
 * The user-data folders of the Chromium-family browsers browse sets up, per platform, as browse
 * itself lays them out (a subset of its own table: Chrome and its channels, Chromium, Edge, Brave,
 * Opera and Vivaldi, and Arc on macOS). A browser that is not here is not scanned, and the report
 * says it scanned these.
 */
export const browserDirectories = (
  env: Env,
  platform: string = process.platform,
): ReadonlyArray<BrowserDirectory> => {
  const home = homeDirectory(env)
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support")
    return [
      ["Google Chrome", "Google/Chrome"],
      ["Google Chrome Beta", "Google/Chrome Beta"],
      ["Google Chrome Canary", "Google/Chrome Canary"],
      ["Chromium", "Chromium"],
      ["Microsoft Edge", "Microsoft Edge"],
      ["Brave", "BraveSoftware/Brave-Browser"],
      ["Opera", "com.operasoftware.Opera"],
      ["Vivaldi", "Vivaldi"],
      ["Arc", "Arc/User Data"],
    ].map(([name = "", folder = ""]) => ({ name, directory: join(support, folder) }))
  }
  if (platform === "win32") {
    const local = firstNonEmpty(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local")
    const roaming = firstNonEmpty(env["APPDATA"]) ?? join(home, "AppData", "Roaming")
    return [
      { name: "Google Chrome", directory: join(local, "Google", "Chrome", "User Data") },
      { name: "Microsoft Edge", directory: join(local, "Microsoft", "Edge", "User Data") },
      { name: "Brave", directory: join(local, "BraveSoftware", "Brave-Browser", "User Data") },
      { name: "Vivaldi", directory: join(local, "Vivaldi", "User Data") },
      { name: "Opera", directory: join(roaming, "Opera Software", "Opera Stable") },
    ]
  }
  const configured = firstNonEmpty(env["XDG_CONFIG_HOME"])
  const config =
    configured !== undefined && isAbsolute(configured) ? configured : join(home, ".config")
  return [
    ["Google Chrome", "google-chrome"],
    ["Google Chrome Beta", "google-chrome-beta"],
    ["Google Chrome Unstable", "google-chrome-unstable"],
    ["Chromium", "chromium"],
    ["Microsoft Edge", "microsoft-edge"],
    ["Brave", "BraveSoftware/Brave-Browser"],
    ["Opera", "opera"],
    ["Vivaldi", "vivaldi"],
  ].map(([name = "", folder = ""]) => ({ name, directory: join(config, folder) }))
}

const LocalState = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      profile: Schema.optionalKey(
        Schema.StructWithRest(
          Schema.Struct({ info_cache: Schema.optionalKey(Schema.Record(Schema.String, Open)) }),
          [Open],
        ),
      ),
    }),
    [Open],
  ),
)

const Preferences = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      extensions: Schema.optionalKey(
        Schema.StructWithRest(
          Schema.Struct({ settings: Schema.optionalKey(Schema.Record(Schema.String, Open)) }),
          [Open],
        ),
      ),
    }),
    [Open],
  ),
)

// A file that is missing, unreadable or not what Chromium writes tells nothing, so it reads as
// absent: the scan only ever finds the extension, and never fails the step that reports it.
const readOptional = (file: string) =>
  readJsonText(file).pipe(Effect.orElseSucceed((): string | undefined => undefined))

// Chromium records an extension it disabled with `disable_reasons`, an array or a bit set.
const isDisabled = (setting: Record<string, unknown>): boolean => {
  const reasons = setting["disable_reasons"]
  return Array.isArray(reasons) ? reasons.length > 0 : typeof reasons === "number" && reasons !== 0
}

/** One browser profile that has the browse extension. */
export interface ExtensionInstall {
  /** The browser's name. */
  readonly browser: string
  /** The profile's folder name in the browser's user-data folder (`Default`, `Profile 1`). */
  readonly profile: string
  /** Whether the browser has the extension switched on in that profile. */
  readonly enabled: boolean
}

/**
 * Finds the browse extension in the browsers {@link browserDirectories} lists, the way browse's own
 * setup does: it reads each profile's `Secure Preferences` and `Preferences` for an
 * {@link BROWSE_EXTENSION_IDS} entry under `extensions.settings`. Read only, no browser is started
 * and nothing is written; a folder or file that is missing or unreadable counts as nothing found.
 */
export const findBrowseExtension = (
  env: Env,
  platform: string = process.platform,
): Effect.Effect<ReadonlyArray<ExtensionInstall>> =>
  Effect.forEach(browserDirectories(env, platform), ({ name, directory }) =>
    Effect.gen(function* () {
      const state = yield* readOptional(join(directory, "Local State"))
      const decoded =
        state === undefined
          ? undefined
          : Schema.decodeUnknownOption(LocalState)(state, { onExcessProperty: "error" })
      const cached = decoded?._tag === "Some" ? decoded.value.profile?.info_cache : undefined
      const profiles = cached === undefined ? ["Default"] : Object.keys(cached)
      const found = yield* Effect.forEach(profiles, (profile) =>
        Effect.gen(function* () {
          const settings = yield* Effect.forEach(["Secure Preferences", "Preferences"], (file) =>
            readOptional(join(directory, profile, file)).pipe(
              Effect.map((text) => {
                const parsed =
                  text === undefined
                    ? undefined
                    : Schema.decodeUnknownOption(Preferences)(text, {
                        onExcessProperty: "error",
                      })
                return parsed?._tag === "Some" ? (parsed.value.extensions?.settings ?? {}) : {}
              }),
            ),
          )
          const entry = settings.flatMap((entries) =>
            BROWSE_EXTENSION_IDS.flatMap((id) => (entries[id] === undefined ? [] : [entries[id]])),
          )[0]
          return entry === undefined
            ? []
            : [{ browser: name, profile, enabled: !isDisabled(entry) } satisfies ExtensionInstall]
        }),
      )
      return found.flat()
    }),
  ).pipe(Effect.map((installs) => installs.flat()))

/**
 * Where setup and doctor find browse: a browser is paired with it (its extension is installed and
 * paired), the extension is installed in some browser but nothing is paired, or no scanned browser
 * has the extension and nothing is paired.
 */
export type BrowseState =
  | { readonly state: "paired"; readonly browsers: ReadonlyArray<PairedBrowser> }
  | { readonly state: "installed"; readonly installs: ReadonlyArray<ExtensionInstall> }
  | { readonly state: "missing"; readonly scanned: ReadonlyArray<string> }

/**
 * Reads where browse stands, from what the package leaves on the machine and without starting it:
 * the pairing file ({@link readBrowsePairing}) and, with no pairing, the profiles of the browsers
 * ({@link findBrowseExtension}), which tell an installed extension that is not paired apart from
 * one that is not installed. A pairing file that cannot be read is a {@link SetupFailure}.
 */
export const readBrowseState = (
  env: Env,
  platform: string = process.platform,
): Effect.Effect<BrowseState, SetupFailure> =>
  Effect.gen(function* () {
    const pairing = yield* readBrowsePairing(env)
    if (pairing.state === "paired") return pairing
    const installs = yield* findBrowseExtension(env, platform)
    return installs.length > 0
      ? ({ state: "installed", installs } as const)
      : ({
          state: "missing",
          scanned: browserDirectories(env, platform).map(({ name }) => name),
        } as const)
  })

/**
 * One phrase for a doctor or setup line on {@link BrowseState}, and the fix when there is one: a
 * paired state says which browsers ({@link describePairing}); an installed extension that is not
 * paired and a missing extension are told apart, each with its own next step.
 */
export const describeBrowseState = (
  state: BrowseState,
): { readonly text: string; readonly fix?: string } => {
  if (state.state === "paired") return { text: describePairing(state) }
  if (state.state === "installed")
    return {
      text: `the browse extension is installed (${state.installs
        .map(
          ({ browser, profile, enabled }) =>
            `${browser}, profile ${profile}${enabled ? "" : ", disabled"}`,
        )
        .join("; ")}) but no browser is paired with browse`,
      fix: BROWSE_PAIR_FIX,
    }
  return {
    text: `the browse extension is not installed in any browser this check scans (${state.scanned.join(", ")}) and no browser is paired with browse`,
    fix: BROWSE_INSTALL_FIX,
  }
}
