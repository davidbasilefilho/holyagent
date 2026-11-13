import { type Context, setup as coreSetup } from "@holyagent/core"
import { Effect, Schema } from "effect"

import { CAPABILITIES } from "../config/capabilities.ts"
import { DEFAULT_CONFIG } from "../domain/directive.ts"
import { SetupFailure } from "../setup/errors.ts"
import { chooseForm, FORM_CHOICES } from "../setup/form.ts"
import type { CapabilityChoices } from "../setup/pi-check.ts"
import { fail, hint, pass, type Report } from "../setup/report.ts"
import {
  describeScope,
  installedScope,
  type ResolvedScope,
  scopeNotices,
  SCOPES,
} from "../setup/scope.ts"
import { CACHE_TTLS } from "../setup/settings.ts"
import { type Shell, shellLive } from "../setup/shell.ts"
import { runInteractive } from "../setup/tui/session.ts"
import { booleanFlag, choiceFlag, stringFlag } from "./args.ts"
import { Usage } from "./errors.ts"
import { type Command, Verbatim } from "./types.ts"

const CacheTtlFlag = Schema.Literals(CACHE_TTLS)
const SwitchFlag = Schema.Literals(["on", "off"])
const ScopeFlag = Schema.Literals(SCOPES)
const FormFlag = Schema.Literals(FORM_CHOICES)
const coreContext = (cwd: string, env: Context["env"]): Context => ({
  cwd,
  env,
  host: "claude",
  execution: DEFAULT_CONFIG,
  authorize: () => true,
})

/** The flags that switch one capability each, `--<name> on|off`, from the registry. */
const CAPABILITY_FLAGS = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability.name, "string" as const]),
)

/** A report as the text of stdout, one line each, and exit 1 when any step failed. */
const printed = (report: Report) =>
  new Verbatim(`${report.lines.join("\n")}\n`, "", report.ok ? 0 : 1)

/**
 * The scope to work on: the `--scope` value when given, else `local` when the user's own untracked
 * local settings enable the plugin (see `installedScope`), else `user`.
 */
const resolveScope = Effect.fn("resolveScope")(function* (
  flag: string | undefined,
  usage: string,
  cwd: string,
): Effect.fn.Return<ResolvedScope, Usage | SetupFailure, Shell> {
  if (flag === undefined) return yield* installedScope(cwd)
  const scope = yield* choiceFlag(ScopeFlag, "scope", flag, usage)
  return { scope, source: "flag" }
})

const SETUP_USAGE =
  "setup [--scope user|project|local] [--undo] [--dry-run] [--subagent-cache-ttl 1h|5m] [--skip-ctx7] [--<capability> on|off] [--form headless|normal] [--worktrees on|off] [--device-access on|off] [--no-tui]"

const CAPABILITY_NAMES = CAPABILITIES.map((capability) => capability.name).join(", ")

/** A `--worktrees` or `--device-access` value as the choice it makes, or `undefined` when not given. */
const switchFlag = Effect.fn("switchFlag")(function* (
  args: Parameters<typeof stringFlag>[0],
  name: string,
) {
  const value = stringFlag(args, name)
  if (value === undefined) return undefined
  return (yield* choiceFlag(SwitchFlag, name, value, SETUP_USAGE)) === "on"
})

/**
 * The capabilities a command line switches: each `--<capability> on|off` given, by its
 * `pi.features` key.
 */
const capabilitySwitches = Effect.fn("capabilitySwitches")(function* (
  args: Parameters<typeof stringFlag>[0],
) {
  const entries = yield* Effect.forEach(CAPABILITIES, (capability) =>
    switchFlag(args, capability.name).pipe(
      Effect.map((value) => (value === undefined ? [] : [[capability.feature, value] as const])),
    ),
  )
  const choices: CapabilityChoices = Object.fromEntries(entries.flat())
  return choices
})

/** The form `--form` names, or the one detected from the machine. */
const formOf = Effect.fn("formOf")(function* (
  args: Parameters<typeof stringFlag>[0],
  env: Parameters<typeof chooseForm>[0],
  usage: string,
) {
  const flag = stringFlag(args, "form")
  return chooseForm(
    env,
    flag === undefined ? undefined : yield* choiceFlag(FormFlag, "form", flag, usage),
  )
})
const DOCTOR_USAGE = "doctor [--scope user|project|local] [--form headless|normal] [--fix]"

/**
 * The `setup` and `doctor` commands, which install and check what HolyAgent needs beside the
 * plugin. Both are stateless: they never read the HolyAgent state, and the settings file they work
 * on is the one `--scope` names, else `local` when the user's own untracked local settings enable
 * the plugin, else `user`.
 */
export const SETUP_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["setup"],
    usage: SETUP_USAGE,
    summary:
      "Install and configure what HolyAgent needs beside the plugin, skipping every step already done",
    output:
      "report lines: `+` added, `=` already in place, `-` skipped (with --undo: removed), `~` kept or needs you, `!` failed; exit 1 when any step failed",
    notes: [
      "installs the ctx7 CLI; authentication is managed separately by Context7. Setup no longer installs external Context7 skills or rules; existing files are left in place",
      "when Pi is in use (HOLYAGENT_HOST=pi, or pi on PATH; not in a cloud session), makes Pi's packages match the HolyAgent config: `pi install npm:<name>@<pin>` for each package the config enables that Pi's settings do not list at that pin, and `pi remove npm:<name>` for each feature package the settings list but the config turns off; scope user works on Pi's global settings, project and local on the project's .pi/settings.json with -l; nothing runs while pi.enable is off; re-run setup after changing pi.features or pi.web in the config",
      "merges these keys into the settings file of --scope without changing any value already set: attribution, includeGitInstructions, subagentPromptCacheTtl, modelSettings.claude-opus-5-5 (effortLevel high and autoCompactWindow 450000 for the root), extraKnownMarketplaces, enabledPlugins and permissions.deny for WebSearch and WebFetch",
      "--scope picks the file like Claude Code's scopes: user is CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json; project is .claude/settings.json and local is .claude/settings.local.json, both in the git top-level of the current directory when that is the current directory or above it and holds a .git entry, else in the current directory (a `~` line says so, outside a repository too); project and local refuse a symlinked settings file or .claude folder with a `!` line; ctx7 is installed for the user whatever the scope",
      "without --scope the scope is user, for the Claude Code settings and the Pi packages alike, unless your own uncommitted .claude/settings.local.json sets holyagent@holyagent to true under enabledPlugins, in a git work tree where git does not track that file, which makes both local (a tracked file, or a folder that is not a trusted git work tree, keeps user and a `~ scope:` line names the file and says --scope local targets it); an explicit false there stops the search and keeps user; a committed .claude/settings.json that enables the plugin never changes the scope, and a `~ scope:` line names the file and says --scope project targets it; the output starts with a `~ scope:` line naming the scope and, when inferred, the file; a symlinked local or project file is not read (a `~ scope:` line says so for local); a local file that is not a JSON object fails with a `!` line naming it and nothing runs",
      "setup records the keys it adds, per settings file, in holyagent/setup-records.json under CLAUDE_CONFIG_DIR (else ~/.claude), outside the project",
      "--undo removes from the --scope file only what that record says setup added, and only while the value still equals what setup wrote: a changed value, and a key with no record (set before setup or by an earlier version), is kept and reported with `~`, so remove it by hand; permissions.deny loses only the entries setup added, and parent objects left empty are dropped; removed keys print `-` lines (`= nothing to remove` when absent); the file's record is cleared; ctx7 and the Pi packages stay installed; honors --dry-run",
      "a failed step is reported and the rest still run; in a claude.ai cloud session (CLAUDE_CODE_REMOTE=true) ctx7 is skipped and the settings are still merged",
      `capabilities: ${CAPABILITY_NAMES}; each is one switch of pi.features with the packages, tool settings and doctor check that follow from it (docs/pi/configuration.md); \`--<capability> on|off\` turns one on or off by writing pi.features.<key> to the HolyAgent config of the scope (the user's config.json for user, the project's .holyagent/config.json for project and local), only for a value that differs from what the config decides, and the Pi step then installs or removes its packages in the same run; a capability flag applies directly, without the screen, and is refused with --undo`,
      "--form headless|normal picks the form every capability is applied in; without it setup detects the machine (CI set, a claude.ai cloud session, or no DISPLAY or WAYLAND_DISPLAY on Linux means headless, else normal) and prints a `~ form:` line; the headless form leaves out a capability that needs a graphical session (computer-use), which is neither installed nor required there, and setup removes its package once the machine is headless",
      "the T3 Code part of setup (the Pi provider, device access, new threads in worktrees and the keys it always applies) has two choices, new threads in worktrees and agent device access, each on unless you turn it off; the Pi provider is always on while pi.enable is true; device access is offered only where Xcode's iOS simulator or an Android SDK is found",
      "in a terminal, when Pi is in use and the config loads with pi.enable on (or the T3 part has work: scope user, T3 Code installed), setup shows an interactive screen with a row for each capability and, with T3 work, the two T3 choices, a review of what will change and the keys it always applies, and applies on confirm; up/down or j/k move, space toggles, Enter reviews, Esc or Ctrl-C cancels and writes nothing; the first time it installs the packages the screen runs on (OpenTUI and Solid, at the versions of this release) with bun install into HolyAgent's cache folder (XDG_CACHE_HOME, else ~/.cache; LOCALAPPDATA on Windows)",
      "--worktrees on|off and --device-access on|off make a choice without the screen and apply directly, leaving the other choice on, and so does a capability flag; --no-tui keeps the screen out and applies both choices on; the line-based setup runs too, with one `~ t3 tui:` line saying why, when stdin or stdout is not a terminal, CI is set, TERM is dumb, a flag above was given, or the screen cannot be installed or started (offline); nothing about the screen changes the other steps",
    ],
    flags: {
      scope: "string",
      undo: "boolean",
      "dry-run": "boolean",
      "subagent-cache-ttl": "string",
      "skip-ctx7": "boolean",
      worktrees: "string",
      "device-access": "string",
      "no-tui": "boolean",
      form: "string",
      ...CAPABILITY_FLAGS,
    },
    stateless: true,
    positionals: 0,
    run: ({ args, env, cwd, emit, terminal, setupTui }) =>
      Effect.gen(function* () {
        const resolved = yield* resolveScope(stringFlag(args, "scope"), SETUP_USAGE, cwd).pipe(
          Effect.catchTag("SetupFailure", (error) => Effect.succeed(error)),
        )
        if (resolved instanceof SetupFailure) {
          return printed({ lines: [`! scope: ${resolved.message}`], ok: false })
        }
        const subagentCacheTtl = yield* choiceFlag(
          CacheTtlFlag,
          "subagent-cache-ttl",
          stringFlag(args, "subagent-cache-ttl") ?? "1h",
          SETUP_USAGE,
        )
        const flagged = {
          worktrees: yield* switchFlag(args, "worktrees"),
          deviceAccess: yield* switchFlag(args, "device-access"),
        }
        const capabilities = yield* capabilitySwitches(args)
        const form = yield* formOf(args, env, SETUP_USAGE)
        if (
          booleanFlag(args, "undo") &&
          (Object.keys(capabilities).length > 0 || stringFlag(args, "form") !== undefined)
        )
          return yield* new Usage({
            message: "--undo takes no capability flag and no --form",
            hint: `Usage: holyagent ${SETUP_USAGE}`,
          })
        const apply = (
          choices: {
            readonly worktrees?: boolean | undefined
            readonly deviceAccess?: boolean | undefined
          },
          chosen: CapabilityChoices,
          notes: ReadonlyArray<string> = [],
        ) =>
          Effect.gen(function* () {
            const report = yield* coreSetup.setup(coreContext(cwd, env), {
              scope: resolved.scope,
              undo: booleanFlag(args, "undo"),
              subagentCacheTtl,
              dryRun: booleanFlag(args, "dry-run"),
              skipCtx7: booleanFlag(args, "skip-ctx7"),
              ...(choices.worktrees === undefined ? {} : { worktrees: choices.worktrees }),
              ...(choices.deviceAccess === undefined ? {} : { deviceAccess: choices.deviceAccess }),
              capabilities: chosen,
              form,
            })
            return {
              ...report,
              lines: [
                hint(`scope: ${describeScope(resolved)}`),
                ...scopeNotices(resolved).map((notice) => hint(`scope: ${notice}`)),
                ...notes,
                ...report.lines,
              ],
            } satisfies Report
          }).pipe(
            Effect.provide(shellLive(env)),
            Effect.catch((error) =>
              Effect.succeed({ lines: [`! setup: ${error.message}`], ok: false }),
            ),
          )
        const interactive = yield* runInteractive({
          env,
          cwd,
          scope: resolved.scope,
          undo: booleanFlag(args, "undo"),
          dryRun: booleanFlag(args, "dry-run"),
          terminal,
          noTui: booleanFlag(args, "no-tui"),
          choiceFlag:
            flagged.worktrees !== undefined ||
            flagged.deviceAccess !== undefined ||
            Object.keys(capabilities).length > 0,
          form,
          ...(setupTui === undefined ? {} : { load: setupTui }),
          notify: emit,
          apply: (choices, chosen) => apply(choices, chosen),
        })
        if (interactive.kind === "done") return printed(interactive.report)
        return printed(yield* apply(flagged, capabilities, interactive.notes))
      }).pipe(Effect.provide(shellLive(env))),
  },
  {
    path: ["doctor"],
    usage: DOCTOR_USAGE,
    summary:
      "Check bun, ctx7 and the settings of a scope, and, when Pi is in use, pi, node and the Pi packages the config enables; exit 1 when a check fails",
    output:
      "one line per check, `ok   <name>: …` or `FAIL <name>: …`; exit 1 when any check failed",
    notes: [
      "--scope picks the settings file to check, as for setup; without it the scope is user unless your own uncommitted .claude/settings.local.json enables the plugin in a git work tree where git does not track it (then local), the output starts with an `ok   scope:` line naming the scope and, when inferred, the file, with the same `~ scope:` lines as setup; --fix then merges into that file",
      "the Pi checks run when HOLYAGENT_HOST=pi or pi is on PATH and pi.enable is on; otherwise one `~ pi: not in use` line is printed and nothing fails; a missing Pi package line names its `pi install` command, and `holyagent setup` installs them",
      "the Pi checks include `ok   pi form:` (headless or normal, detected from the machine as setup does, or named by --form) and one `pi capability <name>` line for each capability the config turns on: `ok` with its form and what applies, `FAIL` naming an unmet system need or a package not listed at its pin, or a `~` line when the form does not offer it (computer-use on a headless machine), which fails nothing; the provider and web kit packages are the `pi base packages` line",
      "--fix runs the setup steps behind a failing check, prints their lines, then checks again; it never installs Bun, Pi, Node or Pi packages. The ctx7 check verifies CLI availability, not authentication",
    ],
    flags: { scope: "string", fix: "boolean", form: "string" },
    stateless: true,
    positionals: 0,
    run: ({ args, env, cwd }) =>
      Effect.gen(function* () {
        const resolved = yield* resolveScope(stringFlag(args, "scope"), DOCTOR_USAGE, cwd).pipe(
          Effect.catchTag("SetupFailure", (error) => Effect.succeed(error)),
        )
        if (resolved instanceof SetupFailure) {
          return printed({ lines: [fail("scope", resolved.message)], ok: false })
        }
        const form = yield* formOf(args, env, DOCTOR_USAGE)
        const report = yield* coreSetup.doctor(coreContext(cwd, env), {
          fix: booleanFlag(args, "fix"),
          scope: resolved.scope,
          form,
        })
        return printed({
          ...report,
          lines: [
            pass("scope", describeScope(resolved)),
            ...scopeNotices(resolved).map((notice) => hint(`scope: ${notice}`)),
            ...report.lines,
          ],
        })
      }).pipe(Effect.provide(shellLive(env))),
  },
]
