import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

test("Node runs direct Core doctor and VCS operations without a HolyAgent subprocess", () => {
  const result = spawnSync(
    "node",
    ["--experimental-strip-types", join(import.meta.dir, "host-node-fixture.mjs")],
    { encoding: "utf8" },
  )
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("node host operations passed")
})
