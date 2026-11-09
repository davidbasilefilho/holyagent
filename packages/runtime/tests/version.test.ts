import { expect, test } from "bun:test"
import { join } from "node:path"

import { $ } from "bun"

import { PROCESS_TIMEOUT_MS } from "./fixtures.ts"

const main = join(import.meta.dir, "../src/cli/main.ts")
const rootManifest = join(import.meta.dir, "../../../package.json")

test(
  "--version prints the version of the root package.json",
  async () => {
    const { version } = (await Bun.file(rootManifest).json()) as { readonly version: string }
    expect((await $`bun ${main} --version`.quiet()).text()).toBe(`${version}\n`)
  },
  PROCESS_TIMEOUT_MS,
)
