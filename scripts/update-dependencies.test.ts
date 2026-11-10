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
  PI_PACKAGE_PINS,
  type Pin,
  PinsBehind,
  PYPI_PACKAGE_PINS,
  pypiReleaseOf,
  releaseOf,
  renderPiPins,
  renderPypiPins,
  SourceError,
  type Steps,
  type Survey,
  surveyPiPackages,
  surveyPypiPackages,
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
  piPackages: new Map(),
  pypiPackages: new Map(),
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

describe("releaseOf", () => {
  test("fails with a SourceError when the registry does not answer in time", async () => {
    const stalled = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    try {
      const error = await Effect.runPromise(
        Effect.flip(releaseOf("left-pad", `http://127.0.0.1:${stalled.port}`, 50)),
      )
      expect(error).toBeInstanceOf(SourceError)
      expect(error.source).toBe(`http://127.0.0.1:${stalled.port}/left-pad`)
    } finally {
      await stalled.stop(true)
    }
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

describe("Pi package pins", () => {
  const write = (file: string, text: string) => Bun.write(join(root, file), text)

  /** The registry's answer for one package: its versions, with `latest` and some deprecated. */
  const packument = (latest: string, versions: ReadonlyArray<string>, deprecated: string[] = []) =>
    JSON.stringify({
      "dist-tags": { latest },
      versions: Object.fromEntries(
        versions.map((version) => [
          version,
          deprecated.includes(version) ? { deprecated: "do not use" } : {},
        ]),
      ),
    })

  /** A registry serving fixtures by package path; the scoped name's slash is escaped as %2F. */
  const registry = (answers: Record<string, string>) =>
    Bun.serve({
      port: 0,
      fetch: (request) => {
        const answer = answers[new URL(request.url).pathname.slice(1)]
        return answer === undefined ? new Response("", { status: 404 }) : new Response(answer)
      },
    })

  const FIXTURE = {
    "pi-web-kit": packument("0.6.0", ["0.5.0", "0.6.0", "0.7.0-rc.1", "0.7.0"]),
    "@scope%2Fext": packument("1.3.0", ["1.2.0", "1.3.0", "1.4.0", "1.3.1"], ["1.3.1"]),
    "old-line": packument("1.0.0", ["1.0.0", "2.0.0"]),
  }

  const seed = () =>
    write(
      PI_PACKAGE_PINS,
      JSON.stringify({ "pi-web-kit": "0.5.0", "@scope/ext": "1.2.0", "old-line": "3.0.0" }),
    )

  test("moves each pin to the newest stable, non-deprecated release at or below latest", async () => {
    await seed()
    const server = registry(FIXTURE)
    try {
      const { pins, latest } = await Effect.runPromise(
        surveyPiPackages(root, `http://127.0.0.1:${server.port}`),
      )
      expect(pins.map(({ kind, name, current, next }) => ({ kind, name, current, next }))).toEqual([
        { kind: "pi", name: "pi-web-kit", current: "0.5.0", next: "0.6.0" },
        { kind: "pi", name: "@scope/ext", current: "1.2.0", next: "1.3.0" },
        // The registry's latest is behind the pin: the pin stays.
        { kind: "pi", name: "old-line", current: "3.0.0", next: "3.0.0" },
      ])
      expect(Object.fromEntries(latest)).toEqual({
        "pi-web-kit": "0.6.0",
        "@scope/ext": "1.3.0",
        "old-line": "3.0.0",
      })
      expect(pins.every(({ file }) => file === PI_PACKAGE_PINS)).toBe(true)
    } finally {
      await server.stop(true)
    }
  })

  test("--check fails when a Pi pin is behind and passes once it is current", async () => {
    await seed()
    const server = registry(FIXTURE)
    try {
      const found = await Effect.runPromise(
        surveyPiPackages(root, `http://127.0.0.1:${server.port}`),
      )
      const behind = survey(...found.pins)
      const error = await Effect.runPromise(
        Effect.flip(execute(["--check", root], steps(behind).stand)),
      )
      expect(error).toBeInstanceOf(PinsBehind)
      expect((error as PinsBehind).count).toBe(2)
      expect(logged.join("\n")).toContain("pi-web-kit")

      const current = survey(...found.pins.map((pin) => ({ ...pin, current: pin.next })))
      await Effect.runPromise(execute(["--check", root], steps(current).stand))
    } finally {
      await server.stop(true)
    }
  })

  test("a package the registry does not know fails the survey", async () => {
    await seed()
    const server = registry({})
    try {
      const error = await Effect.runPromise(
        Effect.flip(surveyPiPackages(root, `http://127.0.0.1:${server.port}`)),
      )
      expect(error).toBeInstanceOf(SourceError)
    } finally {
      await server.stop(true)
    }
  })

  test("a pin file that is not a table of strings fails with a FileError", async () => {
    await write(PI_PACKAGE_PINS, JSON.stringify({ "pi-web-kit": 5 }))
    const error = await Effect.runPromise(Effect.flip(surveyPiPackages(root, "http://127.0.0.1:1")))
    expect(error._tag).toBe("FileError")
  })

  test("renders the moved versions into the file text, in the file's key order", async () => {
    await seed()
    const text = await Effect.runPromise(
      renderPiPins(
        root,
        new Map([
          ["@scope/ext", "1.3.0"],
          ["pi-web-kit", "0.6.0"],
        ]),
      ),
    )
    expect(JSON.parse(text)).toEqual({
      "pi-web-kit": "0.6.0",
      "@scope/ext": "1.3.0",
      "old-line": "3.0.0",
    })
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "pi-web-kit",
      "@scope/ext",
      "old-line",
    ])
    expect(text.endsWith("}\n")).toBe(true)
  })

  test("the repository's own pin file is already in the form the updater writes", async () => {
    const repository = join(import.meta.dir, "..")
    const text = await Bun.file(join(repository, PI_PACKAGE_PINS)).text()
    expect(await Effect.runPromise(renderPiPins(repository, new Map()))).toBe(text)
  })
})

describe("PyPI package pins", () => {
  const write = (file: string, text: string) => Bun.write(join(root, file), text)

  /** The JSON API's answer for one project: each version with its files, some yanked. */
  const project = (releases: Record<string, ReadonlyArray<boolean>>) =>
    JSON.stringify({
      info: { name: "browser-use", version: "1.2.0" },
      urls: [],
      releases: Object.fromEntries(
        Object.entries(releases).map(([version, yanked]) => [
          version,
          yanked.map((flag) => ({ filename: `${version}.whl`, yanked: flag })),
        ]),
      ),
    })

  /** An index serving fixtures by project; the path is `/pypi/<name>/json`. */
  const index = (answers: Record<string, string>) =>
    Bun.serve({
      port: 0,
      fetch: (request) => {
        const answer = answers[new URL(request.url).pathname]
        return answer === undefined ? new Response("", { status: 404 }) : new Response(answer)
      },
    })

  const FIXTURE = {
    "/pypi/browser-use/json": project({
      "1.0.0": [false],
      "1.1.0": [false],
      "1.2.0": [true],
      "1.3.0rc1": [false],
      "1.2.1.post1": [false],
      "2.0.0.dev4": [false],
    }),
    "/pypi/old-line/json": project({ "1.0.0": [false], "2.0.0": [false] }),
  }

  const seed = () =>
    write(PYPI_PACKAGE_PINS, JSON.stringify({ "browser-use": "1.0.0", "old-line": "3.0.0" }))

  test("the repository pins browser-use exactly, in the form the updater writes", async () => {
    const repository = join(import.meta.dir, "..")
    const text = await Bun.file(join(repository, PYPI_PACKAGE_PINS)).text()
    expect(JSON.parse(text)).toEqual({ "browser-use": "1.0.0" })
    expect(await Effect.runPromise(renderPypiPins(repository, new Map()))).toBe(text)
  })

  test("moves each pin to the newest stable release that is not yanked, never down", async () => {
    await seed()
    const server = index(FIXTURE)
    try {
      const { pins, latest } = await Effect.runPromise(
        surveyPypiPackages(root, `http://127.0.0.1:${server.port}`),
      )
      expect(pins.map(({ kind, name, current, next }) => ({ kind, name, current, next }))).toEqual([
        // 1.2.0 is yanked, 1.3.0rc1, 1.2.1.post1 and 2.0.0.dev4 are not stable.
        { kind: "pypi", name: "browser-use", current: "1.0.0", next: "1.1.0" },
        // The newest release is behind the pin: the pin stays.
        { kind: "pypi", name: "old-line", current: "3.0.0", next: "3.0.0" },
      ])
      expect(Object.fromEntries(latest)).toEqual({ "browser-use": "1.1.0", "old-line": "3.0.0" })
      expect(pins.every(({ file }) => file === PYPI_PACKAGE_PINS)).toBe(true)
    } finally {
      await server.stop(true)
    }
  })

  test("--check fails when a PyPI pin is behind and passes once it is current", async () => {
    await seed()
    const server = index(FIXTURE)
    try {
      const found = await Effect.runPromise(
        surveyPypiPackages(root, `http://127.0.0.1:${server.port}`),
      )
      const error = await Effect.runPromise(
        Effect.flip(execute(["--check", root], steps(survey(...found.pins)).stand)),
      )
      expect(error).toBeInstanceOf(PinsBehind)
      expect((error as PinsBehind).count).toBe(1)
      expect(logged.join("\n")).toContain("browser-use")

      const current = survey(...found.pins.map((pin) => ({ ...pin, current: pin.next })))
      await Effect.runPromise(execute(["--check", root], steps(current).stand))
    } finally {
      await server.stop(true)
    }
  })

  test("a project with no stable, installable release fails the survey", async () => {
    const server = index({
      "/pypi/browser-use/json": project({ "1.0.0": [true], "1.1.0rc1": [false] }),
    })
    try {
      const error = await Effect.runPromise(
        Effect.flip(pypiReleaseOf("browser-use", `http://127.0.0.1:${server.port}`)),
      )
      expect(error).toBeInstanceOf(SourceError)
      expect(error.message).toContain("no stable release that is not yanked")
    } finally {
      await server.stop(true)
    }
  })

  test("an unknown project, an answer of another shape and a stalled index fail with a SourceError", async () => {
    const server = index({ "/pypi/odd/json": JSON.stringify({ releases: [] }) })
    const stalled = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    try {
      const base = `http://127.0.0.1:${server.port}`
      expect(await Effect.runPromise(Effect.flip(pypiReleaseOf("missing", base)))).toBeInstanceOf(
        SourceError,
      )
      expect(await Effect.runPromise(Effect.flip(pypiReleaseOf("odd", base)))).toBeInstanceOf(
        SourceError,
      )
      expect(
        await Effect.runPromise(
          Effect.flip(pypiReleaseOf("browser-use", `http://127.0.0.1:${stalled.port}`, 50)),
        ),
      ).toBeInstanceOf(SourceError)
    } finally {
      await server.stop(true)
      await stalled.stop(true)
    }
  })

  test("a pin file that is not a table of strings fails with a FileError", async () => {
    await write(PYPI_PACKAGE_PINS, JSON.stringify({ "browser-use": 1 }))
    const error = await Effect.runPromise(
      Effect.flip(surveyPypiPackages(root, "http://127.0.0.1:1")),
    )
    expect(error._tag).toBe("FileError")
  })

  test("renders the moved versions into the file text, keeping the key order", async () => {
    await seed()
    const text = await Effect.runPromise(renderPypiPins(root, new Map([["browser-use", "1.1.0"]])))
    expect(JSON.parse(text)).toEqual({ "browser-use": "1.1.0", "old-line": "3.0.0" })
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["browser-use", "old-line"])
    expect(text.endsWith("}\n")).toBe(true)
  })
})
