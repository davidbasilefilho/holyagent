import { type Context, setup as coreSetup } from "@holyagent/core"
import { Effect, Schema } from "effect"

import { CAPABILITIES } from "../config/capabilities.ts"
import type { PiProviderSelection } from "../config/schema.ts"
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
import type { SetupTarget } from "../setup/steps.ts"
import { saveSetupResult } from "../setup/tui/result-file.ts"
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
  t3Workflow: boolean,
): Effect.fn.Return<ResolvedScope, Usage | SetupFailure, Shell> {
  if (flag === undefined)
    return t3Workflow
      ? { scope: "user", source: "default", notices: [] }
      : yield* installedScope(cwd)
  const scope = yield* choiceFlag(ScopeFlag, "scope", flag, usage)
  return { scope, source: "flag" }
})

const SETUP_USAGE =
  "setup [--scope user|project|local] [--undo] [--dry-run] [--subagent-cache-ttl 1h|5m] [--skip-ctx7] [--<capability> on|off] [--form headless|normal] [--worktrees on|off] [--device-access on|off] [--no-tui]"

const CLAUDE_USAGE =
  "setup claude [--scope user|project|local] [--undo] [--dry-run] [--subagent-cache-ttl 1h|5m] [--skip-ctx7] [--no-tui|--non-interactive]"
const PI_USAGE = SETUP_USAGE.replace(" [--subagent-cache-ttl 1h|5m]", "").replace(
  "[--no-tui]",
  "[--no-tui|--non-interactive]",
)

const CAPABILITY_NAMES = CAPABILITIES.map((capability) => capability.name).join(", ")

/** A `--worktrees` or `--device-access` value as the choice it makes, or `undefined` when not given. */
const switchFlag = Effect.fn("switchFlag")(function* (
  args: Parameters<typeof stringFlag>[0],
  name: string,
  usage: string,
) {
  const value = stringFlag(args, name)
  if (value === undefined) return undefined
  return (yield* choiceFlag(SwitchFlag, name, value, usage)) === "on"
})

/**
 * The capabilities a command line switches: each `--<capability> on|off` given, by its
 * `pi.features` key.
 */
const capabilitySwitches = Effect.fn("capabilitySwitches")(function* (
  args: Parameters<typeof stringFlag>[0],
  usage: string,
) {
  const entries = yield* Effect.forEach(CAPABILITIES, (capability) =>
    switchFlag(args, capability.name, usage).pipe(
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

const setupCommand = (target?: SetupTarget, usage = SETUP_USAGE): Command => {
  return {
    path: target === undefined ? ["setup"] : ["setup", target],
    usage,
    summary:
      target === "claude"
        ? "Configure the existing Claude plugin, preserving your settings"
        : "Configure HolyAgent for T3 Code, skipping every step already done",
    output:
      "report lines: `+` added, `=` already in place, `-` skipped (with --undo: removed), `~` kept or needs you, `!` failed; exit 1 when any step failed",
    notes: [
      "Pi setup uses user scope by default and checks that T3 Code was opened at least once. It does not change Claude Code settings unless you also select Claude Code in bare interactive setup",
      "installs the ctx7 CLI; authentication is managed separately by Context7. Setup no longer installs external Context7 skills or rules; existing files are left in place",
      "when Pi is in use (HOLYAGENT_HOST=pi, or pi on PATH; not in a cloud session), makes Pi's packages match the HolyAgent config: `pi install npm:<name>@<pin>` for each package the config enables that Pi's settings do not list at that pin, and `pi remove npm:<name>` for each feature package the settings list but the config turns off; scope user works on Pi's global settings, project and local on the project's .pi/settings.json with -l; nothing runs while pi.enable is off; re-run setup after changing pi.features or pi.web in the config",
      "internal Claude entry only: merges these keys into the settings file of --scope without changing any value already set: attribution, includeGitInstructions, subagentPromptCacheTtl, modelSettings.claude-opus-5-5 (effortLevel high and autoCompactWindow 450000 for the root), extraKnownMarketplaces, enabledPlugins and permissions.deny for WebSearch and WebFetch",
      "internal Claude entry only: --scope picks the file like Claude Code's scopes: user is CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json; project is .claude/settings.json and local is .claude/settings.local.json, both in the git top-level of the current directory when that is the current directory or above it and holds a .git entry, else in the current directory (a `~` line says so, outside a repository too); project and local refuse a symlinked settings file or .claude folder with a `!` line; ctx7 is installed for the user whatever the scope",
      "internal Claude entry only: without --scope the scope is user, for the Claude Code settings and the Pi packages alike, unless your own uncommitted .claude/settings.local.json sets holyagent@holyagent to true under enabledPlugins, in a git work tree where git does not track that file, which makes both local (a tracked file, or a folder that is not a trusted git work tree, keeps user and a `~ scope:` line names the file and says --scope local targets it); an explicit false there stops the search and keeps user; a committed .claude/settings.json that enables the plugin never changes the scope, and a `~ scope:` line names the file and says --scope project targets it; the output starts with a `~ scope:` line naming the scope and, when inferred, the file; a symlinked local or project file is not read (a `~ scope:` line says so for local); a local file that is not a JSON object fails with a `!` line naming it and nothing runs",
      "internal Claude settings: setup records their keys, per settings file, in holyagent/setup-records.json under CLAUDE_CONFIG_DIR (else ~/.claude), outside the project",
      "--undo removes from the --scope file only what that record says setup added, and only while the value still equals what setup wrote: a changed value, and a key with no record (set before setup or by an earlier version), is kept and reported with `~`, so remove it by hand; permissions.deny loses only the entries setup added, and parent objects left empty are dropped; removed keys print `-` lines (`= nothing to remove` when absent); the file's record is cleared; ctx7 and the Pi packages stay installed; honors --dry-run",
      "a failed step is reported and the rest still run; in the internal Claude entry in a claude.ai cloud session (CLAUDE_CODE_REMOTE=true) ctx7 is skipped and the settings are still merged",
      `capabilities: ${CAPABILITY_NAMES}; each is one switch of pi.features with the packages, tool settings and doctor check that follow from it (docs/pi/configuration.md); \`--<capability> on|off\` turns one on or off by writing pi.features.<key> to the HolyAgent config of the scope (the user's config.json for user, the project's .holyagent/config.json for project and local), only for a value that differs from what the config decides, and the Pi step then installs or removes its packages in the same run; a capability flag applies directly, without the screen, and is refused with --undo`,
      "--form headless|normal picks the form every capability is applied in; without it setup detects the machine (CI set, a claude.ai cloud session, or no DISPLAY or WAYLAND_DISPLAY on Linux means headless, else normal) and prints a `~ form:` line; the headless form leaves out a capability that needs a graphical session (computer-use), which is neither installed nor required there, and setup removes its package once the machine is headless",
      "the T3 Code part of setup (the Pi provider, device access, new threads in worktrees and the keys it always applies) has two choices, new threads in worktrees and agent device access, each on unless you turn it off; the Pi provider is always on while pi.enable is true; device access is offered only where Xcode's iOS simulator or an Android SDK is found",
      "in a terminal, when Pi is in use and the config loads with pi.enable on (or the T3 part has work: scope user, T3 Code installed), setup shows an interactive screen with a row for each capability and, with T3 work, the two T3 choices, a review of what will change and the keys it always applies, and applies on confirm; up/down or j/k move, Enter changes the focused option, Review choices opens the plan, and Esc or Ctrl-C cancels without writing; the installed public CLI loads the renderer from its own package",
      "--worktrees on|off and --device-access on|off make a choice without the screen and apply directly, leaving the other choice on, and so does a capability flag; --no-tui keeps the screen out and applies both choices on; the line-based setup runs too, with one `~ t3 tui:` line saying why, when stdin or stdout is not a terminal, CI is set, TERM is dumb, or a flag above was given; if the selected public renderer fails, setup stops without applying defaults",
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
    run: ({
      args,
      env,
      cwd,
      emit,
      terminal,
      setupTui,
      t3Workflow,
      installedPackageRoot,
      surface,
    }) =>
      Effect.gen(function* () {
        const resolved = yield* resolveScope(
          stringFlag(args, "scope"),
          usage,
          cwd,
          target === "pi" || (target === undefined && t3Workflow),
        ).pipe(Effect.catchTag("SetupFailure", (error) => Effect.succeed(error)))
        if (resolved instanceof SetupFailure) {
          return printed({ lines: [`! scope: ${resolved.message}`], ok: false })
        }
        const subagentCacheTtl = yield* choiceFlag(
          CacheTtlFlag,
          "subagent-cache-ttl",
          stringFlag(args, "subagent-cache-ttl") ?? "1h",
          usage,
        )
        const flagged = {
          worktrees: yield* switchFlag(args, "worktrees", usage),
          deviceAccess: yield* switchFlag(args, "device-access", usage),
        }
        const capabilities = yield* capabilitySwitches(args, usage)
        const form = yield* formOf(args, env, usage)
        if (
          booleanFlag(args, "undo") &&
          (Object.keys(capabilities).length > 0 || stringFlag(args, "form") !== undefined)
        )
          return yield* new Usage({
            message: "--undo takes no capability flag and no --form",
            hint: `Usage: holyagent ${usage}`,
          })
        const apply = (
          choices: {
            readonly worktrees?: boolean | undefined
            readonly deviceAccess?: boolean | undefined
            readonly piProviders?: PiProviderSelection
          },
          chosen: CapabilityChoices,
          notes: ReadonlyArray<string> = [],
          selected?: {
            readonly target: SetupTarget
            readonly dryRun: boolean
            readonly skipSharedPrerequisites: boolean
            readonly replacePiRegistration?: boolean
          },
        ) =>
          Effect.gen(function* () {
            const selectedTarget = selected?.target ?? target
            const report = yield* coreSetup.setup(coreContext(cwd, env), {
              scope: resolved.scope,
              ...(selectedTarget === undefined ? { t3Workflow } : { target: selectedTarget }),
              ...(selectedTarget === "claude" || installedPackageRoot === undefined
                ? {}
                : { installedPackageRoot }),
              ...(selectedTarget !== "claude" && selected?.replacePiRegistration === true
                ? { replacePiRegistration: true }
                : {}),
              undo: booleanFlag(args, "undo"),
              subagentCacheTtl,
              dryRun: selected?.dryRun ?? booleanFlag(args, "dry-run"),
              skipCtx7:
                selected?.skipSharedPrerequisites === true || booleanFlag(args, "skip-ctx7"),
              ...(choices.worktrees === undefined ? {} : { worktrees: choices.worktrees }),
              ...(choices.deviceAccess === undefined ? {} : { deviceAccess: choices.deviceAccess }),
              capabilities: selectedTarget === "claude" ? {} : chosen,
              ...(selectedTarget === "claude" || choices.piProviders === undefined
                ? {}
                : { piProviders: choices.piProviders }),
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
        if (target === "claude") return printed(yield* apply(flagged, capabilities))
        const interactive = yield* runInteractive({
          env,
          cwd,
          scope: resolved.scope,
          undo: booleanFlag(args, "undo"),
          dryRun: booleanFlag(args, "dry-run"),
          terminal,
          t3Workflow: t3Workflow || target === "pi",
          noTui: booleanFlag(args, "no-tui") || booleanFlag(args, "non-interactive"),
          choiceFlag:
            flagged.worktrees !== undefined ||
            flagged.deviceAccess !== undefined ||
            Object.keys(capabilities).length > 0,
          form,
          ...(setupTui === undefined ? {} : { load: setupTui }),
          notify: emit,
          apply: (choices, chosen, replacePiRegistration) =>
            target === "pi"
              ? apply(choices, chosen, [], {
                  target: "pi",
                  dryRun: booleanFlag(args, "dry-run"),
                  skipSharedPrerequisites: false,
                  replacePiRegistration,
                })
              : apply(choices, chosen),
          ...(surface === "public" && target === "pi"
            ? {
                previewPi: (choices, chosen) =>
                  apply(choices, chosen, [], {
                    target: "pi",
                    dryRun: true,
                    skipSharedPrerequisites: false,
                    replacePiRegistration: true,
                  }),
              }
            : {}),
          ...(surface === "public" && target === undefined
            ? {
                combined: {
                  run: (
                    harness,
                    choices,
                    chosen,
                    dryRun,
                    skipSharedPrerequisites,
                    replacePiRegistration,
                  ) =>
                    apply(choices, chosen, [hint(`setup harness: ${harness}`)], {
                      target: harness,
                      dryRun,
                      skipSharedPrerequisites,
                      replacePiRegistration,
                    }),
                },
              }
            : {}),
        })
        if (interactive.kind === "done") return printed(interactive.report)
        if (interactive.kind === "applied")
          return surface === "public"
            ? yield* saveSetupResult(interactive.report, booleanFlag(args, "dry-run"), env)
            : printed(interactive.report)
        return printed(yield* apply(flagged, capabilities, interactive.notes))
      }).pipe(Effect.provide(shellLive(env))),
  }
}

/** Setup and diagnostics retained for the bundled private host entry. */
export const SETUP_COMMANDS = [
  setupCommand(),
  {
    path: ["doctor"],
    usage: DOCTOR_USAGE,
    summary:
      "Check T3 Code readiness, Bun, the Pi backend and feature packages; exit 1 when a check fails",
    output:
      "one line per check, `ok   <name>: …` or `FAIL <name>: …`; exit 1 when any check failed",
    notes: [
      "public T3 Code doctor uses user scope by default and does not check Claude Code settings; open T3 Code once and use the Pi provider",
      "internal Claude entry only: --scope picks the settings file to check, as for setup; without it the scope is user unless your own uncommitted .claude/settings.local.json enables the plugin in a git work tree where git does not track it (then local), the output starts with an `ok   scope:` line naming the scope and, when inferred, the file, with the same `~ scope:` lines as setup; --fix then merges into that file",
      "the Pi checks run when HOLYAGENT_HOST=pi or pi is on PATH and pi.enable is on; in the public workflow missing Pi fails, while the internal entry prints a `~ pi: not in use` hint; a missing Pi package line names its `pi install` command, and `holyagent setup` installs them",
      "the Pi checks include `ok   pi form:` (headless or normal, detected from the machine as setup does, or named by --form) and one `pi capability <name>` line for each capability the config turns on: `ok` with its form and what applies, `FAIL` naming an unmet system need or a package not listed at its pin, or a `~` line when the form does not offer it (computer-use on a headless machine), which fails nothing; the provider and web kit packages are the `pi base packages` line",
      "--fix runs the setup steps behind a failing check, prints their lines, then checks again; it never installs Bun, Pi, Node or Pi packages. The ctx7 check verifies CLI availability, not authentication",
    ],
    flags: { scope: "string", fix: "boolean", form: "string" },
    stateless: true,
    positionals: 0,
    run: ({ args, env, cwd, t3Workflow }) =>
      Effect.gen(function* () {
        const resolved = yield* resolveScope(
          stringFlag(args, "scope"),
          DOCTOR_USAGE,
          cwd,
          t3Workflow,
        ).pipe(Effect.catchTag("SetupFailure", (error) => Effect.succeed(error)))
        if (resolved instanceof SetupFailure) {
          return printed({ lines: [fail("scope", resolved.message)], ok: false })
        }
        const form = yield* formOf(args, env, DOCTOR_USAGE)
        const report = yield* coreSetup.doctor(coreContext(cwd, env), {
          fix: booleanFlag(args, "fix"),
          t3Workflow,
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
] as const satisfies ReadonlyArray<Command>

const publicPiSetup = (target?: "pi"): Command => {
  const command = setupCommand(
    target,
    target === undefined ? "setup [pi|claude] [options]" : PI_USAGE.replace(/^setup\b/, "setup pi"),
  )
  const { "subagent-cache-ttl": _claudeOnly, ...flags } = command.flags
  return {
    ...command,
    summary: target === undefined ? "Configure HolyAgent (alias: install)" : command.summary,
    flags: { ...flags, "non-interactive": "boolean" },
    notes: [
      ...(target === undefined
        ? [
            "In a terminal, bare setup opens a combined Pi and Claude Code review. Codex is not an available public setup target on this build. Unattended bare setup configures Pi for T3 Code. Run holyagent setup pi --help or holyagent setup claude --help for the harness options.",
          ]
        : []),
      ...(command.notes?.filter((note) => !/internal Claude|claude\.ai cloud/.test(note)) ?? []),
      "--non-interactive is an alias for --no-tui. It uses default choices for omitted flags and does not read stdin for answers. Interactive setup remains the default in a terminal.",
    ],
  }
}

/** Explicit harness selectors share the public setup handler and precede the bare command. */
export const PUBLIC_SETUP_COMMANDS: ReadonlyArray<Command> = [
  publicPiSetup("pi"),
  {
    ...setupCommand("claude", CLAUDE_USAGE),
    summary: "Configure an existing Claude Code plugin installation",
    flags: {
      scope: "string",
      undo: "boolean",
      "dry-run": "boolean",
      "subagent-cache-ttl": "string",
      "skip-ctx7": "boolean",
      "no-tui": "boolean",
      "non-interactive": "boolean",
    },
    notes: [
      "Install the Claude Code plugin separately. Setup adds missing settings and keeps existing values.",
      "--scope defaults to local when untracked local settings enable the plugin, and user otherwise. --subagent-cache-ttl defaults to 1h. Context7 is installed if needed unless you pass --skip-ctx7 or setup runs on claude.ai.",
      "--undo removes only values recorded by setup that are still unchanged. --dry-run previews without writing. Both are off by default.",
      "Claude Code setup runs without a TUI or stdin prompts. --non-interactive and --no-tui are accepted for scripts.",
    ],
  },
  publicPiSetup(),
]
