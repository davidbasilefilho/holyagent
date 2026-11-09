import { rm } from "node:fs/promises"

/** Error codes Windows raises while a just-exited child process still holds a directory handle. */
const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"])

/** Attempts made before the last error is rethrown. */
export const MAX_ATTEMPTS = 20

const RETRY_DELAY_MS = 50
/**
 * The delay grows by one base step per attempt up to this many steps; with the default base the
 * retries total about 4.3 s.
 */
const MAX_DELAY_STEPS = 5

/**
 * Removes a folder tree, retrying with a growing, capped delay while Windows reports it busy,
 * locked or not yet empty.
 */
export async function removeTemporary(
  path: string,
  remove: typeof rm = rm,
  retryDelayMs = RETRY_DELAY_MS,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= MAX_ATTEMPTS || code === undefined || !TRANSIENT_CODES.has(code)) throw error
      await Bun.sleep(retryDelayMs * Math.min(attempt, MAX_DELAY_STEPS))
    }
  }
}
