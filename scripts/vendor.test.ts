import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type Asset, ASSETS, binaryOf } from "../packages/integrations/claude/src/vendor.ts"
import { download, installMissing, removeUnpinned, unpinnedFiles } from "./vendor.ts"

const expected = new Set(["linux-x64/rg", "linux-x64/licenses/ripgrep/COPYING"])

describe("unpinnedFiles", () => {
  test("keeps pinned files that a Windows scan reports with backslashes", () => {
    const scanned = ["linux-x64\\rg", "linux-x64\\licenses\\ripgrep\\COPYING", "stray.txt"]
    expect(unpinnedFiles(scanned, expected, "\\")).toEqual(["stray.txt"])
  })

  test("names an unpinned file in a nested folder", () => {
    expect(unpinnedFiles(["linux-x64\\licenses\\other\\NOTICE"], expected, "\\")).toEqual([
      "linux-x64\\licenses\\other\\NOTICE",
    ])
  })
})

describe("removeUnpinned", () => {
  test("removes a stray file and leaves the pinned ones, whatever the platform separator", async () => {
    const folder = await mkdtemp(join(tmpdir(), "vendor-"))
    try {
      await mkdir(join(folder, "linux-x64", "licenses", "ripgrep"), { recursive: true })
      for (const file of [...expected, "linux-x64/stray.txt"])
        await Bun.write(join(folder, file), "x")
      expect(await removeUnpinned(folder, expected)).toEqual([join("linux-x64", "stray.txt")])
      for (const file of expected) expect(await Bun.file(join(folder, file)).exists()).toBe(true)
      expect(await Bun.file(join(folder, "linux-x64", "stray.txt")).exists()).toBe(false)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})

describe("download", () => {
  /** Serves the handler on a free port while the test runs. */
  const serving = async (
    handler: (request: Request) => Response | Promise<Response>,
    run: (url: string) => Promise<void>,
  ) => {
    const server = Bun.serve({ port: 0, fetch: handler })
    try {
      await run(`http://localhost:${server.port}/archive`)
    } finally {
      await server.stop(true)
    }
  }

  test("returns the bytes of a successful answer", async () => {
    await serving(
      () => new Response("archive"),
      async (url) => {
        expect(new TextDecoder().decode(await download(url))).toBe("archive")
      },
    )
  })

  test("rejects an answer that is not a success", async () => {
    await serving(
      () => new Response("no", { status: 404 }),
      async (url) => {
        await expect(download(url)).rejects.toThrow("answered 404")
      },
    )
  })

  test("gives up on a server that does not answer in time", async () => {
    await serving(
      () => new Promise<Response>(() => {}),
      async (url) => {
        await expect(download(url, 1024, 100)).rejects.toThrow()
      },
    )
  })

  test("gives up on a body that stalls after the answer began", async () => {
    await serving(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("part"))
            },
          }),
        ),
      async (url) => {
        await expect(download(url, 1024, 100)).rejects.toThrow()
      },
    )
  })

  test("refuses a declared length above the cap", async () => {
    await serving(
      () => new Response(new Uint8Array(2048)),
      async (url) => {
        await expect(download(url, 1024)).rejects.toThrow("above the 1024 allowed")
      },
    )
  })

  test("cuts off a stream that carries more than the cap without declaring it", async () => {
    await serving(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(512))
            },
          }),
        ),
      async (url) => {
        await expect(download(url, 1024)).rejects.toThrow("more than the 1024 bytes allowed")
      },
    )
  })
})

describe("installMissing", () => {
  const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

  /** A pinned asset for the target of a real one, whose archive holds a program and a license. */
  const pinned = async (index: number, url: string) => {
    const program = new TextEncoder().encode(`program ${index}`)
    const archive = await new Bun.Archive(
      { "pkg/rg": program, "pkg/LICENSE": "license" },
      { compress: "gzip" },
    ).bytes()
    const template = ASSETS[index] as Asset
    const asset: Asset = {
      ...template,
      url,
      format: "tar.gz",
      archiveSha256: sha256(archive),
      binarySha256: sha256(program),
      folder: "pkg",
      tool: "rg",
      target: { ...template.target, suffix: "" },
      licenses: ["LICENSE"],
    }
    return { asset, archive }
  }

  test("keeps the archives that succeeded when another download fails or fails its pin", async () => {
    const folder = await mkdtemp(join(tmpdir(), "vendor-"))
    try {
      const good = await pinned(0, "https://example.test/good")
      const missing = await pinned(1, "https://example.test/missing")
      const tampered = await pinned(2, "https://example.test/tampered")
      const served = new Map<string, Uint8Array>([
        [good.asset.url, good.archive],
        [tampered.asset.url, new TextEncoder().encode("not the pinned archive")],
      ])
      const fetched: Array<string> = []
      const problems = await installMissing(
        folder,
        [good.asset, missing.asset, tampered.asset],
        (url) => {
          fetched.push(url)
          const bytes = served.get(url)
          return bytes === undefined
            ? Promise.reject(new Error(`${url} answered 404`))
            : Promise.resolve(bytes)
        },
      )
      expect(fetched.sort()).toEqual([good.asset.url, missing.asset.url, tampered.asset.url].sort())
      expect(problems).toHaveLength(2)
      expect(problems.some((problem) => problem.startsWith(missing.asset.url))).toBe(true)
      expect(problems.some((problem) => problem.startsWith(tampered.asset.url))).toBe(true)
      expect(await Bun.file(join(folder, binaryOf(good.asset))).text()).toBe("program 0")
      expect(await Bun.file(join(folder, binaryOf(missing.asset))).exists()).toBe(false)
      expect(await Bun.file(join(folder, binaryOf(tampered.asset))).exists()).toBe(false)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  test("reports nothing when every archive succeeds", async () => {
    const folder = await mkdtemp(join(tmpdir(), "vendor-"))
    try {
      const good = await pinned(0, "https://example.test/good")
      expect(
        await installMissing(folder, [good.asset], () => Promise.resolve(good.archive)),
      ).toEqual([])
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
