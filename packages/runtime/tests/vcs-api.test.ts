import { afterEach, describe, expect, test } from "bun:test"
import { chmod, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { $ } from "bun"
import { Effect, Layer } from "effect"

import { commitViaApi, partition } from "../src/vcs/api.ts"
import { gitLive } from "../src/vcs/git.ts"
import {
  bareBackedGitHub,
  cleanup,
  commitView,
  GIT_ENV,
  headOf,
  initBare,
  initRepo,
  put,
  readVcs,
  seed,
  sh,
  toon,
  vcs,
} from "./vcs-fixtures.ts"

afterEach(cleanup)

const AGENT = { name: "Claude", email: "noreply@anthropic.com" }

/** A clone with an agent identity, `main` seeded and pushed to a bare "GitHub". */
const cloud = async (files: Record<string, string> = { "a.txt": "a\n", "old.txt": "old\n" }) => {
  const bare = await initBare()
  const dir = await initRepo(AGENT)
  await sh(dir, ["git", "remote", "add", "origin", bare])
  const head = await seed(dir, files)
  await sh(dir, ["git", "push", "-q", "-u", "origin", "main"])
  return { bare, dir, head }
}

const REPO = (bare: string) =>
  bare
    .split("/")
    .slice(-2)
    .join("/")
    .replace(/\.git$/, "")

describe("commit on the api path", () => {
  test("creates one commit with the staged diff and brings the local branch to it", async () => {
    const { bare, dir, head } = await cloud()
    const gh = bareBackedGitHub(bare)
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    await put(dir, { "a.txt": "changed\n", "src/new.ts": "export {}\n" })
    await writeFile(join(dir, "blob.bin"), binary)
    await sh(dir, ["rm", "old.txt"])

    const done = toon(
      await vcs(
        dir,
        [
          "vcs",
          "commit",
          "-m",
          "Change a",
          "-m",
          "Because.",
          "--",
          "a.txt",
          "src",
          "blob.bin",
          "old.txt",
        ],
        gh.layer,
      ),
    )

    expect(done).toMatchObject({ path: "api", signed: true, branch: "main", files: 4 })
    const created = gh.calls.filter((call) => call.kind === "graphql" && call.variables?.["input"])
    expect(created).toHaveLength(1)
    expect(created[0]?.variables?.["input"]).toEqual({
      branch: { repositoryNameWithOwner: REPO(bare), branchName: "main" },
      expectedHeadOid: head,
      message: { headline: "Change a", body: "Because." },
      fileChanges: {
        additions: [
          { path: "a.txt", contents: Buffer.from("changed\n").toString("base64") },
          { path: "blob.bin", contents: binary.toString("base64") },
          { path: "src/new.ts", contents: Buffer.from("export {}\n").toString("base64") },
        ],
        deletions: [{ path: "old.txt" }],
      },
    })
    const remote = await headOf(bare, "main")
    expect(remote).not.toBe(head)
    expect(await headOf(dir)).toBe(remote)
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
    expect(await sh(bare, ["git", "ls-tree", "-r", "--name-only", "main"])).toBe(
      "a.txt\nblob.bin\nsrc/new.ts\n",
    )
    const stored = await $`git show main:blob.bin`
      .cwd(bare)
      .env({ ...process.env, ...GIT_ENV })
      .quiet()
      .arrayBuffer()
    expect(Buffer.from(stored).equals(binary)).toBe(true)
  })

  test("the pre-commit hook runs first and what it changed is committed", async () => {
    const { bare, dir } = await cloud()
    const hook = join(dir, ".git/hooks/pre-commit")
    await writeFile(hook, "#!/bin/sh\necho formatted >> a.txt\n")
    await chmod(hook, 0o755)
    await put(dir, { "a.txt": "changed\n" })

    toon(
      await vcs(
        dir,
        ["vcs", "commit", "-m", "Change a", "--", "a.txt"],
        bareBackedGitHub(bare).layer,
      ),
    )

    expect(await sh(bare, ["git", "show", "main:a.txt"])).toBe("changed\nformatted\n")
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
  })

  test("a failing hook stops the commit before anything reaches GitHub", async () => {
    const { bare, dir, head } = await cloud()
    const hook = join(dir, ".git/hooks/pre-commit")
    await writeFile(hook, "#!/bin/sh\necho lint failed >&2\nexit 1\n")
    await chmod(hook, 0o755)
    await put(dir, { "a.txt": "changed\n" })

    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Change a", "--", "a.txt"],
      bareBackedGitHub(bare).layer,
    )

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: HookFailed")
    expect(result.stderr).toContain("lint failed")
    expect(await headOf(bare, "main")).toBe(head)
  })

  test.each([
    ["a symlink", async (dir: string) => symlink("a.txt", join(dir, "link")), "link", "symlink"],
    [
      "an executable file",
      async (dir: string) => {
        await put(dir, { "run.sh": "echo\n" })
        await chmod(join(dir, "run.sh"), 0o755)
      },
      "run.sh",
      "executable",
    ],
    [
      "a mode-only change",
      async (dir: string) => chmod(join(dir, "a.txt"), 0o755),
      "a.txt",
      "only its mode changed",
    ],
  ])("%s is refused with exit 3 and nothing is sent", async (_name, prepare, path, reason) => {
    const { bare, dir, head } = await cloud()
    const gh = bareBackedGitHub(bare)
    await prepare(dir)

    const result = await vcs(dir, ["vcs", "commit", "-m", "Add it", "--", path], gh.layer)

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: UnsupportedChange")
    expect(result.stderr).toContain(reason)
    expect(gh.calls.some((call) => call.variables?.["input"] !== undefined)).toBe(false)
    expect(await headOf(bare, "main")).toBe(head)
  })

  test("a local branch that is not at GitHub's head is refused", async () => {
    const { bare, dir } = await cloud()
    const other = await initRepo(AGENT)
    await sh(other, ["git", "remote", "add", "origin", bare])
    await sh(other, ["git", "pull", "-q", "origin", "main"])
    await seed(other, { "x.txt": "x\n" })
    await sh(other, ["git", "push", "-q", "origin", "main"])
    await put(dir, { "a.txt": "changed\n" })

    const result = await vcs(
      dir,
      ["vcs", "commit", "-m", "Change a", "--", "a.txt"],
      bareBackedGitHub(bare).layer,
    )

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: RemoteMismatch")
  })

  test("a branch GitHub does not have yet is created at the local head first", async () => {
    const { bare, dir, head } = await cloud()
    const gh = bareBackedGitHub(bare)
    await sh(dir, ["git", "switch", "-q", "-c", "feature"])
    await put(dir, { "a.txt": "changed\n" })

    const done = toon(await vcs(dir, ["vcs", "commit", "-m", "Change a", "--", "a.txt"], gh.layer))

    expect(done).toMatchObject({ createdBranch: true })
    expect(await headOf(bare, "main")).toBe(head)
    expect(await headOf(bare, "feature")).toBe(await headOf(dir))
  })
})

describe("commit to an empty repository", () => {
  test("the first file goes through the contents endpoint, the rest through createCommitOnBranch", async () => {
    const bare = await initBare()
    const dir = await initRepo(AGENT)
    await sh(dir, ["git", "remote", "add", "origin", bare])
    await put(dir, { "a.txt": "first\n", "b.txt": "second\n" })
    const gh = bareBackedGitHub(bare)

    const done = toon(
      await vcs(dir, ["vcs", "commit", "-m", "Start", "--", "a.txt", "b.txt"], gh.layer),
    )

    expect(done).toMatchObject({
      path: "api",
      bootstrapped: true,
      commits: [expect.any(String), expect.any(String)],
    })
    const writes = gh.calls
      .map((call) => call.route.replace(/repos\/[^/]+\/[^/]+\//, ""))
      .filter((route) => route.startsWith("PUT") || route === "graphql")
    // The probe of `vcs detect` is the first GraphQL call, then the file, then the rest.
    expect(writes).toEqual(["graphql", "PUT contents/a.txt", "graphql"])
    const written = gh.calls.find(
      (call) => call.route.includes("PUT") && call.route.endsWith("/contents/a.txt"),
    )
    expect(written?.body).toEqual({
      message: "Start",
      content: Buffer.from("first\n").toString("base64"),
      branch: "main",
    })
    const append = gh.calls.filter((call) => call.variables?.["input"] !== undefined)
    const firstCommit = (await sh(bare, ["git", "rev-list", "--max-parents=0", "main"])).trim()
    expect((append[0]?.variables?.["input"] as { expectedHeadOid: string }).expectedHeadOid).toBe(
      firstCommit,
    )
    expect(await headOf(dir)).toBe(await headOf(bare, "main"))
    expect(await sh(dir, ["git", "status", "--porcelain"])).toBe("")
    expect(await sh(bare, ["git", "ls-tree", "-r", "--name-only", "main"])).toBe("a.txt\nb.txt\n")
  })

  test("a single file needs only the contents endpoint", async () => {
    const bare = await initBare()
    const dir = await initRepo(AGENT)
    await sh(dir, ["git", "remote", "add", "origin", bare])
    await put(dir, { "a.txt": "only\n" })
    const gh = bareBackedGitHub(bare)

    const done = toon(await vcs(dir, ["vcs", "commit", "-m", "Start", "--", "a.txt"], gh.layer))

    expect(done).toMatchObject({ bootstrapped: true })
    expect(gh.calls.some((call) => call.variables?.["input"] !== undefined)).toBe(false)
    expect(await headOf(dir)).toBe(await headOf(bare, "main"))
  })
})

describe("reading the first commit back", () => {
  test("a matching commit is remembered, so the next commit is not read back", async () => {
    const { bare, dir } = await cloud()
    const gh = bareBackedGitHub(bare)
    await put(dir, { "a.txt": "one\n" })
    toon(await vcs(dir, ["vcs", "commit", "-m", "One", "--", "a.txt"], gh.layer))
    await put(dir, { "a.txt": "two\n" })
    toon(await vcs(dir, ["vcs", "commit", "-m", "Two", "--", "a.txt"], gh.layer))

    expect(gh.routes().filter((route) => route.includes("/commits/"))).toHaveLength(1)
    const cached = await readVcs(dir)
    expect(cached.detection?.verified).toBe(true)
  })

  test.each([
    ["another author", { login: "intruder" }, "author is intruder, expected octo"],
    ["no linked account", { login: null }, "no GitHub account"],
    ["an unsigned commit", { verified: false }, "not verified (unsigned)"],
  ])("%s stops with exit 3 and is not remembered", async (_name, view, problem) => {
    const { bare, dir } = await cloud()
    const gh = bareBackedGitHub(bare, () => commitView(view))
    await put(dir, { "a.txt": "one\n" })

    const result = await vcs(dir, ["vcs", "commit", "-m", "One", "--", "a.txt"], gh.layer)

    expect(result.code).toBe(3)
    expect(result.stderr).toContain("error: VerificationMismatch")
    expect(result.stderr).toContain(problem)
    const cached = await readVcs(dir)
    expect(cached.detection).toMatchObject({ path: "api", verified: false })
  })
})

describe("large change sets", () => {
  const sized = (path: string, size: number) => ({ path, size })

  test("one batch when everything fits", () => {
    const changes = [sized("a/x", 10), sized("b/y", 10)]
    expect(partition(changes, 100)).toEqual([changes])
  })

  test("top-level directories stay together and batches pack in order", () => {
    const changes = [
      sized("a/1", 40),
      sized("a/2", 40),
      sized("b/1", 40),
      sized("c/1", 40),
      sized("c/2", 40),
    ]
    expect(partition(changes, 100).map((batch) => batch.map(({ path }) => path))).toEqual([
      ["a/1", "a/2"],
      ["b/1"],
      ["c/1", "c/2"],
    ])
  })

  test("a directory over the limit splits by its next level and one huge file stays alone", () => {
    const changes = [
      sized("src/a/1", 60),
      sized("src/a/2", 60),
      sized("src/b/1", 60),
      sized("big.bin", 500),
    ]
    const batches = partition(changes, 130).map((batch) => batch.map(({ path }) => path))
    expect(batches).toContainEqual(["big.bin"])
    expect(batches.flat().toSorted()).toEqual(changes.map(({ path }) => path).toSorted())
    for (const batch of batches) expect(batch.length === 1 || batch.length * 60 <= 130).toBe(true)
  })

  test("an oversized change set goes in several commits chained by expectedHeadOid", async () => {
    const { bare, dir, head } = await cloud()
    const gh = bareBackedGitHub(bare)
    await put(dir, { "a/one.txt": "x".repeat(3000), "b/two.txt": "y".repeat(3000) })
    await sh(dir, ["git", "add", "-A"])

    const done = await Effect.runPromise(
      commitViaApi({
        repo: REPO(bare),
        branch: "main",
        message: { headline: "Add both" },
        restage: Effect.void,
        limit: 5000,
      }).pipe(Effect.provide(Layer.merge(gitLive(dir, GIT_ENV), gh.layer))),
    )

    expect(done.split).toBe(true)
    expect(done.commits).toHaveLength(2)
    const inputs = gh.calls
      .filter((call) => call.variables?.["input"] !== undefined)
      .map(
        (call) =>
          call.variables?.["input"] as { expectedHeadOid: string; message: { headline: string } },
      )
    expect(inputs.map((input) => input.message.headline)).toEqual([
      "Add both (1/2)",
      "Add both (2/2)",
    ])
    expect(inputs[0]?.expectedHeadOid).toBe(head)
    expect(inputs[1]?.expectedHeadOid).toBe(done.commits[0])
    expect(await headOf(dir)).toBe(done.commits[1])
  })
})
