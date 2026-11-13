import { join } from "node:path"

import { Effect, Option, Schema } from "effect"

import manifest from "../../../../package.json" with { type: "json" }
import {
  type CapabilityDefinition,
  type CapabilityFeature,
  type CapabilityForm,
  enabledCapabilities,
  formContent,
  formNeeds,
  serversWithheld,
  type SystemNeed,
  unavailableIn,
} from "../config/capabilities.ts"
import { loadConfig } from "../config/load.ts"
import { piPackages } from "../config/packages.ts"
import { piPackageSource } from "../config/pi-packages.ts"
import type { Config } from "../config/schema.ts"
import { fileSystem } from "../ports/filesystem.ts"
import { stateDirectory } from "../state/layout.ts"
import { describeBrowseState, readBrowseState } from "./browse.ts"
import { chromiumFixWith, findChromiumWith } from "./chromium.ts"
import { type Env, firstNonEmpty, homeDirectory } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import { DEFAULT_FORM_CHOICE, describeForm, type FormChoice, hasDisplay } from "./form.ts"
import { fileOperation } from "./json-file.ts"
import { fail, hint, pass } from "./report.ts"
import type { Scope } from "./scope.ts"
import { Shell } from "./shell.ts"

/**
 * The Pi release HolyAgent is built and tested against: the `@earendil-works/pi-coding-agent`
 * release in `bun.lock`, which the documented install command names. A test keeps the two equal, so
 * a `mise run deps:update` that moves Pi fails it until this moves too.
 */
export const PI_HOST_VERSION = "1.5.0"

/** The oldest Node.js release Pi runs on (the `engines` field of `@earendil-works/pi-coding-agent`). */
export const PI_MINIMUM_NODE = "22.19.0"

const PI_INSTALL = `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_HOST_VERSION}`
const NODE_FIX = `install Node.js ${PI_MINIMUM_NODE} or newer (https://nodejs.org)`
const PI_FIX = `install Pi with \`${PI_INSTALL}\` (Node.js ${PI_MINIMUM_NODE} or newer), or with the official installer (https://pi.dev)`
const PACKAGE_COMMAND = `pi install git:github.com/davidbasilefilho/holyagent@holyagent-${manifest.version}`

/**
 * How a missing HolyAgent package is installed: for this project only (`-l`) when the scope counts
 * the project's file.
 */
const packageFix = (scope: Scope) =>
  scope === "user"
    ? `install it with \`${PACKAGE_COMMAND}\``
    : `install it with \`${PACKAGE_COMMAND}\` (add -l for this project only)`

const VERSION = /(\d+)\.(\d+)\.(\d+)/

/** The first `major.minor.patch` in a command's output, as numbers; `undefined` when there is none. */
const releaseIn = (text: string): readonly [number, number, number] | undefined => {
  const [, major, minor, patch] = VERSION.exec(text) ?? []
  return major === undefined || minor === undefined || patch === undefined
    ? undefined
    : [Number(major), Number(minor), Number(patch)]
}

/** Orders two releases: negative when `a` is older than `b`, zero when equal, positive when newer. */
const compareReleases = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

const PINNED_PI = releaseIn(PI_HOST_VERSION) ?? [0, 0, 0]
const MINIMUM_NODE = releaseIn(PI_MINIMUM_NODE) ?? [0, 0, 0]

/**
 * Checks a command that reports its version with `--version`, without installing anything: on PATH
 * (else it fails with the fix), reporting a release (else `unreadable`), then `judge` says how that
 * release reads: a detail for an `ok` line, or the reason it fails with the fix appended.
 */
const checkVersioned = (
  env: Env,
  name: string,
  command: string,
  texts: {
    readonly fix: string
    readonly judge: (
      release: readonly [number, number, number],
      shown: string,
      path: string,
    ) => { readonly ok: boolean; readonly detail: string }
  },
) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const found = yield* shell.which(command)
    if (Option.isNone(found)) return fail(name, `not found on PATH; ${texts.fix}`)
    const result = yield* shell.run(command, ["--version"], { cwd: homeDirectory(env) })
    const output = `${result.stdout}\n${result.stderr}`
    const release = result.exitCode === 0 ? releaseIn(output) : undefined
    if (release === undefined)
      return fail(
        name,
        `${found.value} did not report a version for --version (exit ${result.exitCode}); ${texts.fix}`,
      )
    const shown = release.join(".")
    const verdict = texts.judge(release, shown, found.value)
    return verdict.ok ? pass(name, verdict.detail) : fail(name, verdict.detail)
  })

const checkPi = (env: Env) =>
  checkVersioned(env, "pi", "pi", {
    fix: PI_FIX,
    judge: (release, shown, path) =>
      compareReleases(release, PINNED_PI) < 0
        ? {
            ok: false,
            detail: `${shown} at ${path} is older than ${PI_HOST_VERSION}, the release HolyAgent is built against; ${PI_FIX}`,
          }
        : {
            ok: true,
            detail:
              compareReleases(release, PINNED_PI) === 0
                ? `${shown} (${path})`
                : `${shown} (${path}; newer than the ${PI_HOST_VERSION} HolyAgent is built against)`,
          },
  })

const checkNode = (env: Env) =>
  checkVersioned(env, "node", "node", {
    fix: NODE_FIX,
    judge: (release, shown, path) =>
      compareReleases(release, MINIMUM_NODE) < 0
        ? {
            ok: false,
            detail: `${shown} at ${path} is older than ${PI_MINIMUM_NODE}, which Pi needs; ${NODE_FIX}`,
          }
        : { ok: true, detail: `${shown} (${path})` },
  })

// A Pi settings file holds many keys of its own; only `packages` is read, each entry a source string
// or an object that names its `source` and may narrow the package's resources.
const Open = Schema.Record(Schema.String, Schema.Unknown)
const PackageEntry = Schema.Union([
  Schema.String,
  Schema.StructWithRest(Schema.Struct({ source: Schema.String }), [Open]),
])
const PiSettings = Schema.StructWithRest(
  Schema.Struct({ packages: Schema.optionalKey(Schema.Array(PackageEntry)) }),
  [Open],
)

/**
 * What leads a git source up to its repository path: the `git:` prefix or a URL scheme with an
 * optional `user@` and, for the scp form, `user@host:`. The `@` that follows the repository path
 * starts the ref, which may hold slashes (`release/0.3.0/integration`).
 */
const GIT_LEAD = /^(?:git:|[a-z][a-z0-9+.-]*:\/\/)(?:[^/@]*@)?|^[^/@:\s]+@[^/@:\s]+:/i

/**
 * The name a package source ends in, or `undefined` for a source that is not a package name: the
 * last path segment without its `@ref` or `@version` and `.git`, and an `npm:` scope check (a
 * scoped npm package is somebody else's, even when it is named `holyagent`). A git source loses its
 * ref first, whole, so a ref with slashes cannot stand in for the name; a path is read as it is.
 */
const sourceName = (source: string): string | undefined => {
  const bare = source.startsWith("npm:") ? source.slice("npm:".length) : source
  if (source.startsWith("npm:") && bare.startsWith("@")) return undefined
  const path = GIT_LEAD.test(bare) ? (bare.replace(GIT_LEAD, "").split("@")[0] ?? "") : bare
  const last =
    path
      .split(/[/\\:]/)
      .filter(Boolean)
      .at(-1) ?? ""
  return (last.split("@")[0] ?? "").replace(/\.git$/, "")
}

/**
 * Whether a Pi package source names the HolyAgent package: `npm:holyagent@<version>`, a git source
 * of a repository named `holyagent` (`git:github.com/<owner>/holyagent@<ref>`, an https or ssh
 * URL), or a local path to a `holyagent` folder or to the built package,
 * `packages/integrations/pi/dist`.
 */
export const isHolyagentSource = (source: string): boolean => {
  const normal = source.replaceAll("\\", "/").replace(/\/+$/, "")
  return sourceName(source) === "holyagent" || normal.endsWith("/packages/integrations/pi/dist")
}

/**
 * Pi's agent folder: `PI_CODING_AGENT_DIR` (with a leading `~` as the home folder), else
 * `~/.pi/agent`.
 */
export const piAgentDirectory = (env: Env): string => {
  const home = homeDirectory(env)
  const set = firstNonEmpty(env["PI_CODING_AGENT_DIR"])
  if (set === undefined) return join(home, ".pi", "agent")
  return set === "~" ? home : /^~[/\\]/.test(set) ? join(home, set.slice(2)) : set
}

/**
 * The sources in the `packages` of one Pi settings file, an object entry by its `source`; a missing
 * or empty file lists none, and a file that is not valid Pi settings is a {@link SetupFailure}.
 */
export const piSettingsSources = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* fileSystem
    const exists = yield* fileOperation(file, "read", () =>
      fs.stat(file).then(
        () => true,
        (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)),
      ),
    )
    if (!exists) return []
    const text = yield* fileOperation(file, "read", () => fs.readFile(file, "utf8"))
    if (text.trim() === "") return []
    const settings = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PiSettings))(text, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new SetupFailure({ message: `${file} is not valid Pi settings: ${error.message}` }),
      ),
    )
    return (settings.packages ?? []).map((entry) =>
      typeof entry === "string" ? entry : entry.source,
    )
  })

/** Pi's two settings files in the order doctor reads them: the global one, then the project's. */
export const piSettingsFiles = (env: Env, cwd: string) =>
  [join(piAgentDirectory(env), "settings.json"), join(cwd, ".pi", "settings.json")] as const

/**
 * The Pi settings files whose packages count as present at a scope, global first. Scope `user`
 * counts Pi's global file only, so a repository's `.pi/settings.json` cannot make setup or doctor
 * believe a global install is there; `project` and `local` also count the project's file, since Pi
 * loads the global packages in a project as well.
 */
export const piPresenceFiles = (env: Env, cwd: string, scope: Scope): ReadonlyArray<string> => {
  const [globalFile, projectFile] = piSettingsFiles(env, cwd)
  return scope === "user" ? [globalFile] : [globalFile, projectFile]
}

/**
 * The name and version of an `npm:<name>[@<version>]` package source, or `undefined` for any other
 * source (a git URL, a path). A scoped name keeps its leading `@`.
 */
export const parseNpmSource = (
  source: string,
): { readonly name: string; readonly version: string | undefined } | undefined => {
  if (!source.startsWith("npm:")) return undefined
  const spec = source.slice("npm:".length)
  const at = spec.indexOf("@", 1)
  return at < 0
    ? { name: spec, version: undefined }
    : { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

/** Whether a settings source is exactly the wanted `npm:<name>@<version>` source. */
export const listsAtPin = (listed: ReadonlyArray<string>, wanted: string): boolean => {
  const want = parseNpmSource(wanted)
  return listed.some((source) => {
    const found = parseNpmSource(source)
    return found !== undefined && found.name === want?.name && found.version === want.version
  })
}

/**
 * Whether Pi is in use on this machine: `HOLYAGENT_HOST` is `pi` (the Pi extension sets it), or a
 * `pi` command is on PATH. Setup and doctor do Pi work only then, so a Claude-only user never sees
 * a Pi failure.
 */
export const piInUse = (env: Env) =>
  Effect.gen(function* () {
    if (firstNonEmpty(env["HOLYAGENT_HOST"]) === "pi") return true
    return Option.isSome(yield* (yield* Shell).which("pi"))
  })

/**
 * The capability switches of a run that the config files do not hold yet, by `pi.features` key:
 * what `--<capability> on|off` or the setup screen chose, applied over the loaded config so a dry
 * run plans with them.
 */
export type CapabilityChoices = Readonly<Partial<Record<CapabilityFeature, boolean>>>

/**
 * The HolyAgent config that decides the Pi packages at a scope, or a {@link SetupFailure} naming the
 * bad file. Scope `user` works on Pi's global settings and reads the user's own file only, so a
 * `.holyagent/config.json` of the directory it runs in cannot turn a feature off and have a package
 * removed from them; `project` and `local` work on the project, so they read the user's file with
 * the project's over it, the config the project runs with. `choices` are laid over the result.
 */
export const loadPiConfig = (
  env: Env,
  cwd: string,
  scope: Scope,
  choices: CapabilityChoices = {},
): Effect.Effect<Config, SetupFailure> =>
  loadConfig({ projectDirectories: scope === "user" ? [] : [stateDirectory(cwd)], env }).pipe(
    Effect.map((config): Config => ({
      ...config,
      pi: { ...config.pi, features: { ...config.pi.features, ...choices } },
    })),
    Effect.mapError((error) => new SetupFailure({ message: error.message })),
  )

/**
 * Whether Pi has the HolyAgent package in the files that count at the scope ({@link
 * piPresenceFiles}). Reads files only.
 */
const checkPackage = (env: Env, cwd: string, scope: Scope) =>
  Effect.gen(function* () {
    const files = piPresenceFiles(env, cwd, scope)
    const outcomes = yield* Effect.forEach(files, (file) =>
      piSettingsSources(file).pipe(
        Effect.map((sources) => ({
          file,
          listed: sources.some(isHolyagentSource),
          problem: undefined as string | undefined,
        })),
        Effect.catchTag("SetupFailure", (error) =>
          Effect.succeed({ file, listed: false, problem: error.message }),
        ),
      ),
    )
    const found = outcomes.find((outcome) => outcome.listed)
    if (found !== undefined) return pass("pi package", `listed in ${found.file}`)
    const problems = outcomes.flatMap((outcome) =>
      outcome.problem === undefined ? [] : [outcome.problem],
    )
    return fail(
      "pi package",
      problems.length > 0
        ? `${problems.join("; ")}; fix the file, or ${packageFix(scope)}`
        : `not in the packages of ${files.join(" or ")}; ${packageFix(scope)}`,
    )
  })

/** The sources the files counting at the scope list, from every file that can be read. */
const listedSources = (files: ReadonlyArray<string>) =>
  Effect.forEach(files, (file) =>
    piSettingsSources(file).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
  ).pipe(Effect.map((lists) => lists.flat()))

/** How a missing package is installed, for the line that names it. */
const installFix = (source: string, scope: Scope) =>
  `install it with \`pi install ${source}\`${scope === "user" ? "" : " (add -l for this project only)"}, or re-run \`holyagent setup\``

/**
 * One line per package the config needs that no capability owns (the provider extension, and the
 * web kit when the web choice loads it) and the files counting at the scope do not list at its
 * pinned release, each with the `pi install` command that fixes it; one `ok` line when none is
 * missing. A settings file that cannot be read lists nothing here; `pi package` names it.
 */
const checkBasePackages = (
  files: ReadonlyArray<string>,
  scope: Scope,
  config: Config,
  listed: ReadonlyArray<string>,
) => {
  const wanted = piPackages(config, undefined, "normal", [])
  const missing = wanted.filter((source) => !listsAtPin(listed, source))
  if (missing.length === 0)
    return [pass("pi base packages", `${wanted.length} packages listed at their pins`)]
  return missing.map((source) =>
    fail(
      `pi base package ${parseNpmSource(source)?.name ?? source}`,
      `not listed at ${source} in the packages of ${files.join(" or ")}; ${installFix(source, scope)}`,
    ),
  )
}

/**
 * The reason a system need is not met on this machine, or `undefined` when it is. The `platform`
 * (the machine's by default) decides the graphical-session need, which only a Unix desktop without
 * `DISPLAY` or `WAYLAND_DISPLAY` fails ({@link hasDisplay}), and where a Chromium is looked for.
 */
export const unmetNeed = (env: Env, need: SystemNeed, platform: string = process.platform) =>
  Effect.gen(function* () {
    if (need.kind === "display")
      return hasDisplay(env, platform)
        ? undefined
        : "needs a graphical session (no DISPLAY or WAYLAND_DISPLAY)"
    if (need.kind === "chromium") {
      const fs = yield* fileSystem
      return findChromiumWith(fs, env, platform) === undefined
        ? `needs a Chromium; ${chromiumFixWith(fs, env, need.fix)}`
        : undefined
    }
    if (need.kind === "node") return yield* unmetNode(env, need)
    const found = yield* (yield* Shell).which(need.command)
    return Option.isSome(found) ? undefined : `needs ${need.command} on PATH; ${need.fix}`
  })

// Node.js on PATH at the need's minimum release or newer, read from `node --version`.
const unmetNode = (env: Env, need: Extract<SystemNeed, { readonly kind: "node" }>) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const found = yield* shell.which("node")
    const minimum = need.minimum.join(".")
    if (Option.isNone(found)) return `needs Node.js ${minimum} or newer on PATH; ${need.fix}`
    const result = yield* shell.run("node", ["--version"], { cwd: homeDirectory(env) })
    const release =
      result.exitCode === 0 ? releaseIn(`${result.stdout}\n${result.stderr}`) : undefined
    if (release === undefined)
      return `needs Node.js ${minimum} or newer, and ${found.value} did not report a version for --version (exit ${result.exitCode}); ${need.fix}`
    return compareReleases(release, need.minimum) < 0
      ? `needs Node.js ${minimum} or newer, but ${found.value} is ${release.join(".")}; ${need.fix}`
      : undefined
  })

/**
 * Doctor's line on one enabled capability in a form on a host (the machine's by default). A form
 * the capability does not offer, or a host its native library does not cover, is a `~` line saying
 * why and that nothing is expected (never a failure, since a headless machine is not broken, nor is
 * one without a native build, where Pi keeps its own tools). Otherwise the probes of its `health`
 * run: `needs` checks each system need ({@link SystemNeed}) and `packages` that each package of the
 * form is listed at its pin in the files that count; every problem is named in one `FAIL` line, and
 * a healthy capability is one `ok` line with its form and whom it applies to. The `pairing` probe
 * has a line of its own ({@link checkPairing}).
 */
export const checkCapability = (
  env: Env,
  scope: Scope,
  capability: CapabilityDefinition,
  form: CapabilityForm,
  listed: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
  platform?: string,
) =>
  Effect.gen(function* () {
    const name = `pi capability ${capability.name}`
    const reason = unavailableIn(capability, form, platform)
    if (reason !== undefined)
      return hint(`${name}: not offered in the ${form} form (${reason}); nothing is expected of it`)
    const content = formContent(capability, form)
    const problems: Array<string> = []
    if (capability.health.includes("needs")) {
      // The host key is `<platform>-<arch>`; the needs know the operating system by its name alone.
      const system = platform?.split("-", 1)[0]
      for (const need of formNeeds(capability, form)) {
        const unmet = yield* unmetNeed(env, need, system)
        if (unmet !== undefined) problems.push(unmet)
      }
    }
    const sources = (content?.packages ?? []).map((package_) => piPackageSource(package_))
    if (capability.health.includes("packages")) {
      for (const source of sources.filter((wanted) => !listsAtPin(listed, wanted)))
        problems.push(
          `${source} is not listed in the packages of ${files.join(" or ")}; ${installFix(source, scope)}`,
        )
    }
    if (problems.length > 0) return fail(name, problems.join("; "))
    const count = sources.length === 1 ? "1 package" : `${sources.length} packages`
    const what =
      sources.length === 0
        ? "nothing to install"
        : capability.health.includes("packages")
          ? `${count} listed at ${sources.length === 1 ? "its pin" : "their pins"}`
          : `${count}, not checked`
    return pass(name, `${form} form, ${capability.applicability}, ${what}`)
  })

/**
 * Doctor's line on the pairing of a capability whose form drives a paired browser (opencode browse,
 * `pairing` in its normal form), or none for any other form. A browser paired with browse is an
 * `ok` line naming it: its extension is installed and paired. Otherwise a `~` line, not a failure
 * (the first run of a machine is in that state until the person adds the extension to their
 * browser), that says whether the extension is installed in a browser but not paired or not
 * installed at all ({@link readBrowseState}), with the next step for each. A pairing file that
 * cannot be read is a `FAIL` line.
 */
export const checkPairing = (
  env: Env,
  capability: CapabilityDefinition,
  form: CapabilityForm,
  platform?: string,
) =>
  Effect.gen(function* () {
    if (unavailableIn(capability, form, platform) !== undefined) return []
    if (formContent(capability, form)?.pairing !== true) return []
    const name = `pi capability ${capability.name} pairing`
    const found = yield* readBrowseState(env, platform).pipe(
      Effect.catchTag("SetupFailure", (error) => Effect.succeed(error)),
    )
    if (found instanceof SetupFailure) return [fail(name, found.message)]
    const { text, fix } = describeBrowseState(found)
    return found.state === "paired"
      ? [pass(name, text)]
      : [hint(`${name}: ${text}${fix === undefined ? "" : `; ${fix}`}`)]
  })

/**
 * Doctor's note when a capability's MCP servers are not registered because `pi.features.mcp` is off
 * ({@link serversWithheld}): a `~` line, since the person switched it off, and none otherwise.
 */
export const checkServers = (
  capability: CapabilityDefinition,
  form: CapabilityForm,
  config: Config,
) => {
  const reason =
    unavailableIn(capability, form) === undefined
      ? serversWithheld(capability, form, config.pi.features)
      : undefined
  return reason === undefined ? [] : [hint(`pi capability ${capability.name}: ${reason}`)]
}

/**
 * Doctor's lines on the capabilities: the form in force ({@link describeForm}), then one line for
 * each enabled capability of the config in registry order ({@link checkCapability}). A disabled
 * capability has no line.
 */
const checkCapabilities = (
  env: Env,
  cwd: string,
  scope: Scope,
  config: Config,
  choice: FormChoice,
  listed: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const files = piPresenceFiles(env, cwd, scope)
    const lines = yield* Effect.forEach(
      enabledCapabilities(config.pi.features, { provider: config.pi.provider }),
      (capability) =>
        Effect.gen(function* () {
          return [
            yield* checkCapability(env, scope, capability, choice.form, listed, files),
            ...(yield* checkPairing(env, capability, choice.form)),
            ...checkServers(capability, choice.form, config),
          ]
        }),
    )
    return [pass("pi form", describeForm(choice)), ...lines.flat()]
  })

/**
 * The Pi checks of `holyagent doctor`, one line each: `pi` on PATH at the release HolyAgent is
 * built against ({@link PI_HOST_VERSION}) or newer, `node` on PATH at {@link PI_MINIMUM_NODE} or
 * newer, `pi package`, the HolyAgent package in the `packages` of Pi's global settings (Pi's agent
 * folder, `PI_CODING_AGENT_DIR` honored), the base packages (provider, web kit) those settings do
 * not list at their pins, then the form in force and one line for each enabled capability: its
 * system needs and its packages at their pins, or why its form does not offer it
 * ({@link checkCapability}). The form is the `choice` (detected or named by `--form`; `normal` when
 * the caller passes none). Scope `project` and `local` also count the project's `.pi/settings.json`
 * ({@link piPresenceFiles}); scope `user` does not. Every failing line ends with the command that
 * fixes it, and nothing is installed or written. The config is the one `setup` reads at the same
 * scope ({@link loadPiConfig}). The checks run only while Pi is in use ({@link piInUse}) and
 * `pi.enable` is on in that config; when Pi is not in use there is one informational `~` line
 * saying so, with `pi.enable` off there are no lines, and a config that cannot be loaded gives one
 * failing `pi config` line.
 */
export const piChecks = (
  env: Env,
  cwd: string,
  scope: Scope,
  choice: FormChoice = DEFAULT_FORM_CHOICE,
): Effect.Effect<ReadonlyArray<string>, never, Shell> =>
  Effect.gen(function* () {
    if (!(yield* piInUse(env)))
      return [
        hint("pi: not in use (HOLYAGENT_HOST is not pi and pi is not on PATH); Pi checks skipped"),
      ]
    return yield* loadPiConfig(env, cwd, scope).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed<ReadonlyArray<string>>([fail("pi config", error.message)]),
        onSuccess: (config) =>
          config.pi.enable
            ? Effect.gen(function* () {
                const files = piPresenceFiles(env, cwd, scope)
                const listed = yield* listedSources(files)
                const [pi, node, pkg] = yield* Effect.all([
                  checkPi(env),
                  checkNode(env),
                  checkPackage(env, cwd, scope),
                ])
                return [
                  pi,
                  node,
                  pkg,
                  ...checkBasePackages(files, scope, config, listed),
                  ...(yield* checkCapabilities(env, cwd, scope, config, choice, listed)),
                ]
              })
            : Effect.succeed<ReadonlyArray<string>>([]),
      }),
    )
  })
