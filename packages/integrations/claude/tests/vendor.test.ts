import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateRawSync } from "node:zlib"

import { TARGETS, TOOLS } from "../../../runtime/src/cli/tools.ts"
import { VENDOR_DIRECTORY } from "../src/files.ts"
import {
  ASSETS,
  binaryOf,
  expectedFiles,
  installAsset,
  readZip,
  sha256,
  vendorProblems,
} from "../src/vendor.ts"
import { ROOT } from "./built.ts"

const vendor = join(ROOT, VENDOR_DIRECTORY)

describe("the pins", () => {
  test("pin each tool for each target, with SHA-256 hashes and a versioned release URL", () => {
    expect(ASSETS.map((asset) => `${asset.tool} ${asset.target.id}`).toSorted()).toEqual(
      TOOLS.flatMap((tool) => TARGETS.map((target) => `${tool} ${target.id}`)).toSorted(),
    )
    for (const asset of ASSETS) {
      expect(asset.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.binarySha256).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.url).toMatch(/^https:\/\/github\.com\/.+\/releases\/download\/v?\d+\.\d+\.\d+\//)
      expect(asset.url.endsWith(`/${asset.folder}.${asset.format}`)).toBe(true)
      expect(asset.format).toBe(asset.target.suffix === ".exe" ? "zip" : "tar.gz")
    }
  })

  test("ship the licenses of each tool beside its programs", () => {
    for (const asset of ASSETS) expect(asset.licenses.length).toBeGreaterThanOrEqual(2)
    expect(ASSETS.find((asset) => asset.tool === "rg")?.licenses).toContain("UNLICENSE")
    expect(ASSETS.find((asset) => asset.tool === "fd")?.licenses).toContain("LICENSE-APACHE")
  })
})

describe("the vendored tools of the plugin", () => {
  test("are exactly the pinned files, each program with its pinned SHA-256", async () => {
    expect(await vendorProblems(vendor)).toEqual([])
    const present = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: vendor }))
    expect(present.toSorted()).toEqual([...expectedFiles()])
  })

  test("are executable where the platform needs the mode", async () => {
    for (const asset of ASSETS)
      expect(((await stat(join(vendor, binaryOf(asset)))).mode & 0o111) !== 0).toBe(true)
  })
})

describe("installing an archive", () => {
  const asset = ASSETS.find((candidate) => candidate.format === "zip")
  if (asset === undefined) throw new Error("expected a zip asset")

  /** A zip archive of the named files, each deflated or stored as asked. */
  const zip = (files: ReadonlyArray<readonly [string, Uint8Array, 0 | 8]>): Uint8Array => {
    const parts: Array<Uint8Array> = []
    const directory: Array<Uint8Array> = []
    let offset = 0
    const header = (size: number, fill: (view: DataView) => void) => {
      const bytes = new Uint8Array(size)
      fill(new DataView(bytes.buffer))
      return bytes
    }
    for (const [name, content, method] of files) {
      const data = method === 8 ? deflateRawSync(content) : content
      const label = new TextEncoder().encode(name)
      const local = header(30, (view) => {
        view.setUint32(0, 0x04034b50, true)
        view.setUint16(8, method, true)
        view.setUint32(18, data.length, true)
        view.setUint32(22, content.length, true)
        view.setUint16(26, label.length, true)
      })
      directory.push(
        header(46, (view) => {
          view.setUint32(0, 0x02014b50, true)
          view.setUint16(10, method, true)
          view.setUint32(20, data.length, true)
          view.setUint32(24, content.length, true)
          view.setUint16(28, label.length, true)
          view.setUint32(42, offset, true)
        }),
        label,
      )
      parts.push(local, label, data)
      offset += 30 + label.length + data.length
    }
    const central = directory.reduce((sum, part) => sum + part.length, 0)
    const end = header(22, (view) => {
      view.setUint32(0, 0x06054b50, true)
      view.setUint16(10, files.length, true)
      view.setUint32(12, central, true)
      view.setUint32(16, offset, true)
    })
    return Buffer.concat([...parts, ...directory, end])
  }

  const text = (value: string) => new TextEncoder().encode(value)

  test("reads stored and deflated zip entries by name and skips the others", () => {
    const archive = zip([
      ["a/one.txt", text("one"), 8],
      ["a/two.txt", text("two"), 0],
      ["a/three.txt", text("three"), 8],
    ])
    const found = readZip(archive, ["a/two.txt", "a/one.txt", "a/absent.txt"])
    expect([...found.keys()].toSorted()).toEqual(["a/one.txt", "a/two.txt"])
    expect(new TextDecoder().decode(found.get("a/one.txt"))).toBe("one")
    expect(new TextDecoder().decode(found.get("a/two.txt"))).toBe("two")
  })

  test("refuses bytes that are not a zip archive", () => {
    expect(() => readZip(text("not a zip file at all"), ["x"])).toThrow("not a zip file")
  })

  test("refuses an archive whose SHA-256 differs from the pin and writes nothing", async () => {
    const archive = zip([[`${asset.folder}/x`, text("x"), 8]])
    const directory = await mkdtemp(join(tmpdir(), "holyagent-vendor-"))
    await expect(installAsset(directory, asset, archive)).rejects.toThrow(
      `${sha256(archive)}, but ${asset.archiveSha256} is pinned`,
    )
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory }))).toEqual([])
    await rm(directory, { recursive: true, force: true })
  })
})
