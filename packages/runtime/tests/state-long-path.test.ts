import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { fromGitPath } from "../src/domain/paths.ts"
import { cleanup, fakeGitHub, initRepo, put, scratch, seed, sh, vcs } from "./vcs-fixtures.ts"

if (process.platform === "win32") setDefaultTimeout(60_000)
afterAll(() => setDefaultTimeout(5_000))
afterEach(cleanup, 65_000)

if (process.platform === "win32") {
  test("a long state path is checked out and a long legacy state path is copied", async () => {
    const dir = await initRepo()
    await seed(dir, { "a.txt": "a\n" })
    const run = (cwd: string, args: ReadonlyArray<string>, stdin?: unknown) =>
      vcs(cwd, args, fakeGitHub({}).layer, stdin)
    await run(dir, ["intent", "create"], { objective: "Long paths" })
    const list = await sh(dir, ["git", "worktree", "list", "--porcelain"])
    const block = list
      .split("\n\n")
      .find((entry) => entry.includes("\nbranch refs/heads/holyagent/state"))
    if (block === undefined) throw new Error("state worktree not found")
    const state = fromGitPath((block.split("\n")[0] ?? "").replace("worktree ", ""))
    const tail = `${"a".repeat(100)}/${"b".repeat(100)}/record.txt`
    const checkedOut = `.holyagent/intents/${tail}`
    await put(state, { [checkedOut]: "checkout\n" })
    expect(join(state, checkedOut).length).toBeGreaterThan(260)
    await sh(state, ["git", "-c", "core.longpaths=true", "add", "--", checkedOut])
    await sh(state, [
      "git",
      "-c",
      "core.longpaths=true",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "long state",
    ])
    await sh(dir, ["git", "-c", "core.longpaths=true", "worktree", "remove", "--force", state])

    const linked = join(await scratch("holyagent-linked-"), "tree")
    await sh(dir, ["git", "worktree", "add", "-q", "-b", "linked", linked])
    const copied = `.holyagent/notes/${tail}`
    await put(linked, { [copied]: "copied\n" })
    expect(join(linked, copied).length).toBeGreaterThan(260)
    // Isolate the legacy Bun.write failure model from every other test and run the real copy.
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures/legacy-long-path-write.ts"), linked],
      { stdout: "pipe", stderr: "pipe" },
    )
    const stderr = await new Response(child.stderr).text()
    const exit = await child.exited
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
    expect(await readFile(join(state, checkedOut), "utf8")).toBe("checkout\n")
    expect(await readFile(join(state, copied), "utf8")).toBe("copied\n")
  })
}
