import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test"

import { cleanup, initRepo, sh } from "./vcs-fixtures.ts"

// Tests that run git processes: process creation on Windows is slow enough on the CI runner to pass
// Bun's 5 second default, and a slow test there is not a hung one. Linux and macOS keep the default.
if (process.platform === "win32") setDefaultTimeout(60_000)
afterAll(() => setDefaultTimeout(5_000))

afterEach(cleanup)

// A fixture repository names github.com as its origin so that `vcs pr` finds an owner and a
// repository, and any command that fetches the state branch then reaches for the network. Through
// a sandbox proxy that fetch took 1 to 57 seconds (the state fetch is cut off at 8), far past the
// 5 second test timeout, so a different test timed out in each full run.
test("the hermetic git environment refuses a fetch over the network, so no test waits for it", async () => {
  const dir = await initRepo()
  await sh(dir, ["git", "remote", "add", "origin", "https://github.com/octo/project.git"])

  const refused = await sh(dir, ["git", "ls-remote", "origin"]).then(
    () => "",
    (error: { stderr?: { toString: () => string } }) => String(error.stderr?.toString()),
  )

  expect(refused).toContain("not allowed")
})
