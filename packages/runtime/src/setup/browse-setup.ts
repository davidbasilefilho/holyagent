import { dirname, join } from "node:path"

import { $ } from "bun"
import { Effect, Schema } from "effect"

import { BROWSE_PACKAGE } from "../../../core/src/config/capabilities.ts"
import {
  readJsonObjectSnapshot,
  writeJsonObject,
  writeJsonObjectIfUnchanged,
} from "../../../core/src/setup/json-file.ts"
import { packageRunner, type PackageRunner } from "../../../core/src/setup/package-runner.ts"
import { userConfigFile } from "../config/load.ts"
import {
  BROWSE_EXTENSION_STORE,
  type BrowseProfile,
  type BrowseState,
  browserDirectories,
  browseRunnerCommand,
  BROWSE_VERSION,
  describeBrowseState,
  findBrowseProfiles,
  readBrowsePairing,
} from "./browse.ts"
import { definedEnv, type Env, homeDirectory } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import { added, hint, present, type Report, skipped } from "./report.ts"
import { pathWithBunBin, Shell } from "./shell.ts"
import { plain } from "./tui/load.ts"

const NAME = "OpenCode Browse"
const PACKAGE = `${BROWSE_PACKAGE}@${BROWSE_VERSION}`
const Receipt = Schema.Struct({ version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)) })
const receiptFile = (env: Env) => join(dirname(userConfigFile(env)), "browse-setup.json")
const browseEnv = { OPENCODE_BROWSER_AUTO_UPDATE: "off" } satisfies Env

/** One selected browser's reviewed profile and next step. */
export interface BrowseTarget {
  readonly target: string
  readonly next: "pair" | "extension" | "manual"
  readonly guidance?: string
}

/** What setup detected and can offer without changing Browse or opening a browser. */
export interface BrowsePlan {
  readonly state: string
  readonly command?: string
  readonly action?: "Configure" | "Update"
  readonly runner: PackageRunner
  readonly next: "paired" | "pair" | "extension" | "none"
  readonly profiles?: ReadonlyArray<BrowseProfile>
  readonly target?: string
  readonly guidance?: string
  readonly alreadyPaired?: boolean
  readonly targets?: ReadonlyArray<BrowseTarget>
  readonly receipt?: { readonly text: string | undefined }
}

/** Detect the profiles and managed pin; an external launcher or pairing is never removed. */
export const planBrowse = Effect.fn("planBrowse")(function* (
  env: Env,
  packageRoot: string | undefined,
  platform: string = process.platform,
): Effect.fn.Return<BrowsePlan> {
  const runner = packageRoot === undefined ? "unknown" : packageRunner(packageRoot, env)
  const command = browseRunnerCommand(runner, "pair")?.join(" ")
  return yield* Effect.gen(function* () {
    const pairing = yield* readBrowsePairing(env)
    const profiles = (yield* findBrowseProfiles(env, platform))
      .map((profile) => ({ ...profile, profile: plain(profile.profile) }))
      .sort((a, b) => Number(b.extension === "enabled") - Number(a.extension === "enabled"))
    const installs = profiles.flatMap(({ browser, profile, extension }) =>
      extension === "missing" ? [] : [{ browser, profile, enabled: extension === "enabled" }],
    )
    const state: BrowseState =
      pairing.state === "paired"
        ? pairing
        : installs.length > 0
          ? { state: "installed", installs }
          : { state: "missing", scanned: browserDirectories(env, platform).map(({ name }) => name) }
    const status = describeBrowseState(state, runner)
    const snapshot = yield* readJsonObjectSnapshot(receiptFile(env))
    const receipt =
      snapshot.text === undefined
        ? undefined
        : Schema.is(Receipt)(snapshot.value)
          ? snapshot.value
          : yield* new SetupFailure({ message: "Invalid HolyAgent Browse setup receipt" })
    const next =
      state.state === "paired"
        ? "paired"
        : state.state === "installed" && state.installs.some(({ enabled }) => enabled)
          ? "pair"
          : "extension"
    if (next === "paired" && receipt?.version === BROWSE_VERSION)
      return {
        state: `${status.text}; ${PACKAGE} verified`,
        runner,
        next: "none",
        alreadyPaired: true,
        profiles,
      } satisfies BrowsePlan
    if (command === undefined)
      return {
        state: `${status.text}; the HolyAgent runner could not be identified`,
        runner,
        next: "none",
        alreadyPaired: pairing.state === "paired",
        profiles,
      } satisfies BrowsePlan
    const update = receipt !== undefined && receipt.version !== BROWSE_VERSION
    return {
      state: update ? `${status.text}; previous managed CLI ${receipt.version}` : status.text,
      action: update ? "Update" : "Configure",
      command,
      runner,
      next,
      alreadyPaired: pairing.state === "paired",
      profiles,
      receipt: { text: snapshot.text },
    } satisfies BrowsePlan
  }).pipe(
    Effect.catchTag("SetupFailure", (error) =>
      Effect.succeed({ state: error.message, runner, next: "none" } satisfies BrowsePlan),
    ),
  )
})

const browseProfileLabel = ({ browser, profile }: BrowseProfile): string => `${browser}, ${profile}`
const targetNeeds = ({ target, guidance }: BrowseTarget): string =>
  `${NAME}: ${target}: ${guidance ?? "verify the browser and its extension manually"}`

/** Select handoff steps for the chosen browser profile without opening channels or changing it. */
export const browseForProfile = (plan: BrowsePlan, index: number): BrowsePlan => {
  if (plan.next === "none" || plan.next === "paired") return plan
  const profile = plan.profiles?.[index]
  const target =
    profile === undefined
      ? "a compatible Chromium-family browser profile"
      : browseProfileLabel(profile)
  const guidance =
    profile?.extension === "enabled"
      ? undefined
      : profile?.extension === "disabled"
        ? `enable the Browse extension in ${target}`
        : `add the official Browse extension in ${target} from ${BROWSE_EXTENSION_STORE}`
  return {
    ...plan,
    next: profile?.extension === "enabled" ? "pair" : "extension",
    target,
    ...(guidance === undefined ? {} : { guidance }),
  }
}

/** The same detected state and action is shown in combined, targeted and dry-run review. */
export const browseReview = (
  plan: BrowsePlan,
  selected: boolean,
  dryRun = false,
): ReadonlyArray<string> => [
  present(`${NAME}: ${plan.state}`),
  ...((plan.profiles?.length ?? 0) === 0
    ? []
    : [
        present(
          `${NAME}: detected profiles ${plan.profiles?.map(browseProfileLabel).join("; ") ?? ""}`,
        ),
      ]),
  ...(plan.action === undefined
    ? []
    : !selected
      ? [skipped(`${NAME}: Skip Browser Use setup; no Browse command will run`)]
      : [
          added(`${NAME}: ${plan.action} ${PACKAGE} with ${plan.runner}; keep existing pairing`),
          ...(plan.targets !== undefined
            ? []
            : plan.next === "pair"
              ? [
                  hint(
                    `${NAME}: setup ${dryRun ? "would run" : "runs"} ${plan.command ?? "the official pair command"} after you close the screen. Enter its code in the extension Options of ${plan.target ?? "your chosen browser profile"}`,
                  ),
                ]
              : plan.next === "extension"
                ? [
                    hint(
                      `${NAME}: ${plan.guidance ?? "add or enable the extension before pairing"}, then rerun setup to pair`,
                    ),
                  ]
                : []),
        ]),
  ...(plan.targets ?? []).map((target) =>
    target.next === "pair"
      ? hint(
          `${NAME}: ${target.target}: ${selected && plan.action !== undefined ? (dryRun ? "would ask for its own one-time code" : "enter its own one-time code after closing this screen") : "no pairing command will run"}`,
        )
      : hint(targetNeeds(target)),
  ),
]

/**
 * Runs the official pairing command after the renderer restores output; code never enters the
 * report.
 */
export type BrowsePair = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Env },
) => Effect.Effect<number>

/** Stream the official one-time code to the terminal instead of collecting it in setup reports. */
export const pairBrowseOnTerminal: BrowsePair = (command, args, options) => {
  const bunBin = pathWithBunBin(
    { ...options.env },
    {
      home: homeDirectory(options.env),
      bunInstall: options.env.BUN_INSTALL,
    },
  )
  return Effect.tryPromise({
    try: () =>
      $`${command} ${args}`
        .cwd(options.cwd)
        .env(definedEnv({ ...options.env, [bunBin.key]: bunBin.value }))
        .nothrow()
        .then(({ exitCode }) => exitCode),
    catch: () => 127,
  }).pipe(Effect.orElseSucceed(() => 127))
}

/** Verify the exact runner package, then pair only when reviewed and necessary. */
export const configureBrowse = Effect.fn("configureBrowse")(
  function* (
    env: Env,
    plan: BrowsePlan,
    pair: BrowsePair,
    notify: (line: string) => Effect.Effect<void> = () => Effect.void,
  ) {
    const failure = (detail: string): Report => ({ ok: false, lines: [`! ${NAME}: ${detail}`] })
    const version = browseRunnerCommand(plan.runner, "--version")
    const pairCommand = browseRunnerCommand(plan.runner, "pair")
    if (
      version === undefined ||
      pairCommand === undefined ||
      plan.receipt === undefined ||
      plan.action === undefined ||
      plan.next === "none"
    )
      return failure("no reviewed Browse setup action is available")
    const [runner, ...versionArgs] = version
    if (runner === undefined) return failure("no runner for the pinned Browse CLI")
    const shell = yield* Shell
    const cwd = homeDirectory(env)
    const versionResult = yield* shell.run(runner, versionArgs, { cwd, env: browseEnv })
    if (versionResult.exitCode !== 0) {
      const detail = versionResult.stderr
        .split(/\r?\n/)
        .map(plain)
        .find((line) => /\b(?:error|failed|refusing)\b/i.test(line))
        ?.trim()
        .slice(0, 260)
      return failure(
        `could not run ${PACKAGE} with ${runner} (exit ${versionResult.exitCode})${detail ? `: ${detail}` : ""}`,
      )
    }
    if (versionResult.stdout.trim() !== BROWSE_VERSION)
      return failure(
        `the ${runner} command did not resolve the exact CLI version ${BROWSE_VERSION}`,
      )
    const versionLine = present(`${NAME}: verified CLI ${PACKAGE} with ${runner}`)
    const prior = yield* readBrowsePairing(env)
    const targetLines: Array<string> = []
    if (plan.targets !== undefined) {
      const ready = plan.targets.filter(({ next }) => next === "pair")
      if (prior.state === "paired" && ready.length > 0)
        return failure(
          "a browser was paired since review. Existing pairings were kept; review again",
        )
      let previous = prior
      for (const target of plan.targets) {
        if (target.next !== "pair") {
          targetLines.push(hint(targetNeeds(target)))
          continue
        }
        yield* notify(`${NAME}: ${target.target}. Enter this one-time code in that profile only.`)
        const exit = yield* pair(runner, pairCommand.slice(1), {
          cwd,
          env: { ...env, ...browseEnv },
        })
        if (exit !== 0)
          return {
            ok: false,
            lines: [
              versionLine,
              ...targetLines,
              `! ${NAME}: ${target.target}: pairing was not confirmed (exit ${exit}). Previously connected profiles were kept.`,
            ],
          }
        const after = yield* readBrowsePairing(env)
        const old =
          previous.state === "paired"
            ? new Set(previous.browsers.map(({ key }) => key))
            : new Set<string>()
        if (
          after.state !== "paired" ||
          !after.browsers.some(({ key, lastSeen }) => !old.has(key) && lastSeen !== undefined)
        )
          return {
            ok: false,
            lines: [
              versionLine,
              ...targetLines,
              `! ${NAME}: ${target.target}: no new connected profile was confirmed. Existing pairings were kept.`,
            ],
          }
        previous = after
        targetLines.push(
          present(`${NAME}: a new connection was confirmed during the ${target.target} handoff`),
        )
      }
      if (ready.length === 0 && prior.state === "unpaired")
        return { ok: true, lines: [versionLine, ...targetLines] }
    } else if (prior.state === "unpaired") {
      if (plan.next !== "pair")
        return {
          ok: true,
          lines: [
            versionLine,
            hint(
              `${NAME}: pairing is not complete; ${plan.guidance ?? "add or enable the extension"}, then rerun setup to pair`,
            ),
          ],
        }
      const exit = yield* pair(runner, pairCommand.slice(1), { cwd, env: { ...env, ...browseEnv } })
      if (exit !== 0)
        return {
          ok: false,
          lines: [
            versionLine,
            `! ${NAME}: pairing was not confirmed (exit ${exit}); run setup again when ready to pair`,
          ],
        }
    }
    const pairing = yield* readBrowsePairing(env)
    if (
      pairing.state !== "paired" ||
      (prior.state === "unpaired" &&
        !pairing.browsers.some(({ lastSeen }) => lastSeen !== undefined))
    )
      return failure(
        "the pinned CLI exited but no browser pairing was found; no update was recorded",
      )
    const file = receiptFile(env)
    const { text } = plan.receipt
    const record = { version: BROWSE_VERSION }
    const saved =
      text === undefined
        ? (yield* readJsonObjectSnapshot(file)).text === undefined &&
          (yield* writeJsonObject(file, record, { mode: 0o600 }).pipe(Effect.as(true)))
        : yield* writeJsonObjectIfUnchanged(file, record, text, { mode: 0o600 })
    if (!saved) return failure("the HolyAgent Browse receipt changed; review setup again")
    return {
      ok: true,
      lines: [
        versionLine,
        ...targetLines,
        present(`${NAME}: ${describeBrowseState(pairing, plan.runner).text}`),
      ],
    }
  },
  Effect.catchTag("SetupFailure", ({ message }) =>
    Effect.succeed({
      ok: false,
      lines: [`! ${NAME}: ${message}`],
    }),
  ),
)
