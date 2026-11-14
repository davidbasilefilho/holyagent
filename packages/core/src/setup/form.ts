import { CAPABILITY_FORMS, type CapabilityForm } from "../config/capabilities.ts"
import { inCloudSession } from "../vcs/identity.ts"
import type { Env } from "./environment.ts"

/** The forms `--form` accepts. */
export const FORM_CHOICES = CAPABILITY_FORMS

/** How the form was chosen: named by `--form`, detected from the machine, or the caller's default. */
export interface FormChoice {
  /** The form every capability is applied in. */
  readonly form: CapabilityForm
  /**
   * `flag` for `--form`, `detected` from the machine, `default` when nothing asked (the normal
   * form).
   */
  readonly source: "flag" | "detected" | "default"
  /** Why, in a phrase: the flag, or what the machine showed. */
  readonly reason: string
}

/** The choice of a caller that neither passes `--form` nor detects: the normal form. */
export const DEFAULT_FORM_CHOICE: FormChoice = {
  form: "normal",
  source: "default",
  reason: "no form was asked for",
}

/**
 * Whether the machine has a graphical session: `DISPLAY` or `WAYLAND_DISPLAY` set on Linux and the
 * other Unix systems; macOS and Windows have one unless they are reached some other way (a cloud
 * session or CI, which {@link detectForm} checks first).
 */
export const hasDisplay = (env: Env, platform: string = process.platform): boolean =>
  platform === "darwin" ||
  platform === "win32" ||
  [env["DISPLAY"], env["WAYLAND_DISPLAY"]].some((value) => value !== undefined && value !== "")

/**
 * Whether the run is in CI: `CI` holds a truthy value. Empty, `0`, `false`, `no` and `off` (in any
 * case) count as unset, as the variable is often exported as a negative on a desktop.
 */
export const inCi = (env: Env): boolean => {
  const value = env["CI"]?.trim().toLowerCase()
  return value !== undefined && !["", "0", "false", "no", "off"].includes(value)
}

/**
 * Picks the form from the machine: `headless` in a claude.ai cloud session, when `CI` is set to a
 * truthy value ({@link inCi}), and where there is no graphical session ({@link hasDisplay});
 * `normal` otherwise. It reads the environment and the platform only, so setup and doctor choose
 * the same form.
 */
export const detectForm = (env: Env, platform: string = process.platform): FormChoice => {
  if (inCloudSession(env))
    return { form: "headless", source: "detected", reason: "a claude.ai cloud session" }
  if (inCi(env)) return { form: "headless", source: "detected", reason: "CI is set" }
  if (!hasDisplay(env, platform))
    return { form: "headless", source: "detected", reason: "no DISPLAY or WAYLAND_DISPLAY is set" }
  return { form: "normal", source: "detected", reason: "a graphical session is available" }
}

/** The form `--form` names, or the detected one when the flag is absent. */
export const chooseForm = (
  env: Env,
  flag: CapabilityForm | undefined,
  platform: string = process.platform,
): FormChoice =>
  flag === undefined
    ? detectForm(env, platform)
    : { form: flag, source: "flag", reason: `--form ${flag}` }

/** A form choice as a phrase for a report line: `headless (detected: CI is set)`. */
export const describeForm = (choice: FormChoice): string =>
  choice.source === "flag"
    ? `${choice.form} (set by ${choice.reason})`
    : choice.source === "detected"
      ? `${choice.form} (detected: ${choice.reason})`
      : choice.form
