import { rm } from "node:fs/promises"

/** Error codes Windows raises while a just-exited child process still holds a directory handle. */
const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"])

const ATTEMPTS = 10
const RETRY_DELAY_MS = 100

/** Removes a folder tree, retrying while Windows reports it busy, locked or not yet empty. */
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
      if (attempt >= ATTEMPTS || code === undefined || !TRANSIENT_CODES.has(code)) throw error
      await Bun.sleep(retryDelayMs)
    }
  }
}
