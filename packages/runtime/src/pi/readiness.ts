import { Data, Effect } from "effect"

import type { Config } from "../config/schema.ts"
import type { ShellResult } from "../setup/shell.ts"
import { providerProfile } from "./provider.ts"

/**
 * Runs a command to completion and captures its output; a command that cannot start has exit code
 * 127, as the setup shell reports it. The launcher passes its own runner, tests pass a fake.
 */
export type CommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<ShellResult>

/** The longest part of a command's output that a report carries. */
export const DETAIL_CHARS = 400

/** The provider's login state, as `pi auth check` reports it. */
export type Readiness =
  | { readonly status: "ready"; readonly provider: string }
  | {
      readonly status: "not_ready"
      readonly provider: string
      /** What to do to log in. */
      readonly fix: string
    }
  | {
      readonly status: "invalid"
      readonly provider: string
      /** What `pi auth check` printed, or why it did not run. */
      readonly detail: string
    }

/** The provider is not logged in; `fix` says how to log in. It is a blocker, never replaced. */
export class ProviderNotReady extends Data.TaggedError("ProviderNotReady")<{
  readonly provider: string
  readonly fix: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `Provider ${this.provider} is not ready. ${this.fix}.`
  }
}

/** Pi found the provider's state or configuration invalid, or `pi auth check` did not run. */
export class ProviderInvalid extends Data.TaggedError("ProviderInvalid")<{
  readonly provider: string
  readonly detail: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `Provider ${this.provider} is invalid: ${this.detail}`
  }
}

/**
 * What a failed Pi command printed, for an error report: its standard output, else its standard
 * error, trimmed and cut to {@link DETAIL_CHARS}; `fallback` when it printed neither. Every error
 * detail of the integration comes from here, so they show the same stream and the same length.
 */
export const outputDetail = ({ stdout, stderr }: ShellResult, fallback: string): string =>
  (stdout.trim() || stderr.trim()).slice(0, DETAIL_CHARS) || fallback

/**
 * Asks Pi whether the selected provider has working credentials, with `pi auth check --provider
 * <id> --json`: exit 0 is ready, 1 is not ready with the login fix, and 2 is invalid, as is any
 * other exit code or a Pi that did not start. It checks the one provider the config selects and
 * never falls back to another. It does not ask for the credential and never reads it.
 */
export const providerReadiness = (run: CommandRunner, config: Config): Effect.Effect<Readiness> => {
  const { id, loginFix } = providerProfile(config)
  return run("pi", ["auth", "check", "--provider", id, "--json"]).pipe(
    Effect.map((result): Readiness => {
      switch (result.exitCode) {
        case 0:
          return { status: "ready", provider: id }
        case 1:
          return { status: "not_ready", provider: id, fix: loginFix }
        default:
          return {
            status: "invalid",
            provider: id,
            detail: outputDetail(result, `pi auth check exited with code ${result.exitCode}`),
          }
      }
    }),
  )
}

/** Like {@link providerReadiness}, but fails with the blocker unless the provider is ready. */
export const requireProviderReady = (
  run: CommandRunner,
  config: Config,
): Effect.Effect<void, ProviderNotReady | ProviderInvalid> =>
  Effect.flatMap(
    providerReadiness(run, config),
    (readiness): Effect.Effect<void, ProviderNotReady | ProviderInvalid> => {
      switch (readiness.status) {
        case "ready":
          return Effect.void
        case "not_ready":
          return Effect.fail(
            new ProviderNotReady({ provider: readiness.provider, fix: readiness.fix }),
          )
        case "invalid":
          return Effect.fail(
            new ProviderInvalid({ provider: readiness.provider, detail: readiness.detail }),
          )
      }
    },
  )
