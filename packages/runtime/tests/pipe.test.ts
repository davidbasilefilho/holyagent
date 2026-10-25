import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { $ } from "bun"

const MAIN = join(import.meta.dir, "../src/cli/main.ts")

describe("the CLI when its reader goes away", () => {
  test("exits quietly when stdout closes before the output is written", async () => {
    // `true` exits at once without reading, so the write meets a closed pipe; pipefail reports the
    // CLI's own exit code as the pipeline's.
    const result =
      await $`bash -o pipefail -c ${'"$0" "$@" | true'} ${process.execPath} ${MAIN} help`
        .quiet()
        .nothrow()
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
  })

  test("still prints everything to a reader that takes it", async () => {
    const result = await $`${process.execPath} ${MAIN} --version`.quiet()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
