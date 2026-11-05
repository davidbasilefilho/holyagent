import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { download, removeUnpinned, unpinnedFiles } from "./vendor.ts"

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
