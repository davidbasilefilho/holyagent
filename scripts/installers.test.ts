import { describe, expect, test } from "bun:test"
import { join } from "node:path"

describe("prerequisite installers", () => {
  for (const file of ["windows-install.ps1", "wsl-install.sh"]) {
    test(`${file} hands off to T3 Code and the canonical setup guide`, async () => {
      const source = await Bun.file(join(import.meta.dir, "../install", file)).text()
      expect(source).toContain("Install and open T3 Code")
      expect(source).toContain(
        "https://github.com/davidbasilefilho/holyagent/blob/main/docs/usage.md#install",
      )
      expect(source).toContain("22.19")
      expect(source).not.toMatch(/claude plugin|\/holyagent:setup|Claude Code is not installed/i)
    })
  }
})
