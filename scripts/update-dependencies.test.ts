import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import {
  ChecksumMismatch,
  execute,
  fetchVendored,
  main,
  manifestFiles,
  type Pin,
  PinsBehind,
  SourceError,
  type Steps,
  type Survey,
  Usage,
  verifyChecksum,
} from "./update-dependencies.ts"

const pin = (current: string, next: string): Pin => ({
  kind: "mise",
  name: "bun",
  file: "mise.toml",
  current,
  next,
})

const survey = (...pins: ReadonlyArray<Pin>): Survey => ({
  pins,
  skipped: [],
  actions: new Map(),
  vendored: new Map(),
  mise: new Map(),
  packages: new Map(),
})

/** Steps that read a fixed survey and count the writes asked for. */
const steps = (found: Survey) => {
  const calls = { survey: 0, apply: 0 }
  const stand: Steps = {
    survey: () => Effect.sync(() => ((calls.survey += 1), found)),
    apply: () => Effect.sync(() => void (calls.apply += 1)),
  }
  return { calls, stand }
}

let root = ""
let logged: Array<string> = []
let failed: Array<string> = []
const restores: Array<() => void> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "holyagent-update-"))
  logged = []
  failed = []
  const log = spyOn(console, "log").mockImplementation((...parts: Array<unknown>) => {
    logged.push(parts.join(" "))
  })
  const error = spyOn(console, "error").mockImplementation((...parts: Array<unknown>) => {
    failed.push(parts.join(" "))
  })
  restores.push(
    () => log.mockRestore(),
    () => error.mockRestore(),
  )
})

afterEach(async () => {
  for (const restore of restores.splice(0)) restore()
  await rm(root, { recursive: true, force: true })
})

const files = () => Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))

describe("--check", () => {
  test("fails with PinsBehind, counting the pins that are behind, and writes nothing", async () => {
    const { calls, stand } = steps(survey(pin("1.0.0", "1.1.0"), pin("2.0.0", "2.0.0")))
    const error = await Effect.runPromise(Effect.flip(execute(["--check", root], stand)))
    expect(error).toBeInstanceOf(PinsBehind)
    expect((error as PinsBehind).count).toBe(1)
    expect(calls).toEqual({ survey: 1, apply: 0 })
    expect(await files()).toEqual([])
  })

  test("passes when no pin is behind", async () => {
    const { calls, stand } = steps(survey(pin("1.0.0", "1.0.0")))
    await Effect.runPromise(execute(["--check", root], stand))
    expect(calls).toEqual({ survey: 1, apply: 0 })
  })

  test("main turns the failure into a failing exit code", async () => {
    const { stand } = steps(survey(pin("1.0.0", "1.1.0")))
    await Effect.runPromise(main(["--check", root], stand))
    const code = process.exitCode
    // The runner would otherwise end with this exit code.
    process.exitCode = 0
    expect(code).toBe(1)
    expect(failed.join("\n")).toContain("PinsBehind")
  })
})

describe("--dry-run", () => {
  test("lists every pin, succeeds when pins are behind, and never applies or writes", async () => {
    const { calls, stand } = steps(survey(pin("1.0.0", "1.1.0"), pin("2.0.0", "2.0.0")))
    await Effect.runPromise(execute(["--dry-run", root], stand))
    expect(calls).toEqual({ survey: 1, apply: 0 })
    expect(logged.join("\n")).toContain("1.0.0 -> 1.1.0")
    expect(logged.join("\n")).toContain("2.0.0 -> 2.0.0")
    expect(await files()).toEqual([])
  })
})

describe("without a flag", () => {
  test("applies the survey once", async () => {
    const { calls, stand } = steps(survey(pin("1.0.0", "1.1.0")))
    await Effect.runPromise(execute([root], stand))
    expect(calls).toEqual({ survey: 1, apply: 1 })
  })

  test("refuses an unknown flag before it surveys anything", async () => {
    const { calls, stand } = steps(survey())
    const error = await Effect.runPromise(Effect.flip(execute(["--force", root], stand)))
    expect(error).toBeInstanceOf(Usage)
    expect(calls).toEqual({ survey: 0, apply: 0 })
  })
})

describe("manifestFiles", () => {
  test("lists the root and the workspace packages, never anything under node_modules", async () => {
    const write = (file: string, text: string) => Bun.write(join(root, file), text)
    await write("package.json", JSON.stringify({ workspaces: ["packages/*", "packages/x/*"] }))
    await write("packages/a/package.json", "{}")
    await write("packages/a/node_modules/dep/package.json", "{}")
    await write("packages/x/b/package.json", "{}")
    await write("node_modules/top/package.json", "{}")
    await write("elsewhere/package.json", "{}")
    expect(await Effect.runPromise(manifestFiles(root))).toEqual([
      "package.json",
      "packages/a/package.json",
      "packages/x/b/package.json",
    ])
  })
})

describe("verifyChecksum", () => {
  const published = { hash: "a".repeat(64), via: "the release" }

  test("passes on the published hash", async () => {
    await Effect.runPromise(verifyChecksum("https://x/y.tar.gz", "a".repeat(64), published))
  })

  test("fails with ChecksumMismatch naming both hashes and where the expected one came from", async () => {
    const error = await Effect.runPromise(
      Effect.flip(verifyChecksum("https://x/y.tar.gz", "b".repeat(64), published)),
    )
    expect(error).toBeInstanceOf(ChecksumMismatch)
    expect(error.message).toContain("b".repeat(64))
    expect(error.message).toContain("a".repeat(64))
    expect(error.message).toContain("the release")
  })
})

describe("fetchVendored", () => {
  const encode = (text: string) => new TextEncoder().encode(text)
  const damaged = encode("not an archive")
  const hashOfDamaged = new Bun.CryptoHasher("sha256").update(damaged).digest("hex")

  /** A network that serves a damaged archive for every download and the given text for the rest. */
  const network = (other: (url: string) => string | undefined) => (url: string) =>
    Effect.sync(() => {
      const text = other(url)
      return text === undefined ? damaged : encode(text)
    })

  test("ripgrep: refuses an archive that differs from its published .sha256", async () => {
    const get = network((url) =>
      url.endsWith(".sha256") ? `${"0".repeat(64)}  file\n` : undefined,
    )
    const error = await Effect.runPromise(
      Effect.flip(fetchVendored("ripgrep", "15.2.0", "15.3.0", get)),
    )
    expect(error).toBeInstanceOf(ChecksumMismatch)
    expect(error.message).toContain(".sha256")
    expect(error.message).toContain(hashOfDamaged)
  })

  test("ripgrep: refuses an archive whose release publishes no .sha256", async () => {
    const get = network((url) => (url.endsWith(".sha256") ? "Not Found" : undefined))
    const error = await Effect.runPromise(
      Effect.flip(fetchVendored("ripgrep", "15.2.0", "15.3.0", get)),
    )
    expect(error).toBeInstanceOf(SourceError)
    expect(error.message).toContain("publishes no SHA-256")
  })

  test("ripgrep: reads an archive only after its hash matches the published one", async () => {
    const get = network((url) => (url.endsWith(".sha256") ? `${hashOfDamaged}  file\n` : undefined))
    const error = await Effect.runPromise(
      Effect.flip(fetchVendored("ripgrep", "15.2.0", "15.3.0", get)),
    )
    // The hash matched, so the failure is the unreadable archive, not a checksum.
    expect(error).toBeInstanceOf(SourceError)
    expect(error).not.toBeInstanceOf(ChecksumMismatch)
  })

  const release = (digest: string | null | undefined) =>
    JSON.stringify({
      id: 1,
      assets: [
        "fd-v10.6.0-aarch64-apple-darwin.tar.gz",
        "fd-v10.6.0-x86_64-unknown-linux-musl.tar.gz",
        "fd-v10.6.0-x86_64-pc-windows-msvc.zip",
      ].map((name) => ({ id: 2, name, ...(digest === undefined ? {} : { digest }) })),
    })
  const api = (text: string) => (url: string) =>
    url.startsWith("https://api.github.com/repos/sharkdp/fd/releases/tags/v10.6.0")
      ? text
      : undefined

  test("fd: refuses an archive that differs from the digest of the release asset", async () => {
    const get = network(api(release(`sha256:${"0".repeat(64)}`)))
    const error = await Effect.runPromise(Effect.flip(fetchVendored("fd", "10.5.1", "10.6.0", get)))
    expect(error).toBeInstanceOf(ChecksumMismatch)
    expect(error.message).toContain("GitHub release API")
  })

  test.each([null, undefined])(
    "fd: refuses an asset the API gives no digest (%p)",
    async (digest) => {
      const get = network(api(release(digest)))
      const error = await Effect.runPromise(
        Effect.flip(fetchVendored("fd", "10.5.1", "10.6.0", get)),
      )
      expect(error).toBeInstanceOf(SourceError)
      expect(error.message).toContain("publishes no SHA-256")
    },
  )

  test("fd: reads an archive only after its hash matches the digest", async () => {
    const get = network(api(release(`sha256:${hashOfDamaged}`)))
    const error = await Effect.runPromise(Effect.flip(fetchVendored("fd", "10.5.1", "10.6.0", get)))
    expect(error).toBeInstanceOf(SourceError)
    expect(error).not.toBeInstanceOf(ChecksumMismatch)
  })

  test("fd: refuses a release answer that lists no assets", async () => {
    const get = network(api("{}"))
    const error = await Effect.runPromise(Effect.flip(fetchVendored("fd", "10.5.1", "10.6.0", get)))
    expect(error).toBeInstanceOf(SourceError)
  })
})
