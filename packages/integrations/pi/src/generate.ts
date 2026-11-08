import { join } from "node:path"

import { Effect } from "effect"

import type { Family } from "../../../runtime/src/instructions/families.ts"
import { jsonText, MODULE_COMMENT } from "../../../runtime/src/instructions/generated.ts"
import { skillFiles } from "../../../runtime/src/instructions/skills.ts"
import packageJson from "../package.json" with { type: "json" }
import { DIST_DIRECTORY, type GeneratedFile, generatedNote, REPOSITORY, SOURCES } from "./files.ts"

/**
 * Every path the build writes, relative to the repository root. The build removes these before it
 * writes and touches nothing else; the commit hook stages exactly these.
 */
export const GENERATED_PATHS: ReadonlyArray<string> = [DIST_DIRECTORY]

/**
 * The model family whose instruction sources the package is built from. The family is a parameter
 * of {@link generate}, so a later change that adds a family switches this one value.
 */
export const PI_FAMILY: Family = "claude-5.5"

/** The extension's source file, relative to the repository root. */
export const EXTENSION_SOURCE = `${SOURCES}/extension.ts`

/** The built extension, relative to the package folder: the file Pi loads from `extensions/`. */
export const EXTENSION_OUTPUT = "extensions/holyagent.js"

/** The description of the package in its manifest. */
export const DESCRIPTION =
  "HolyAgent for Pi: its skills and an extension, built from the shared holyagent runtime."

/**
 * The packages Pi supplies to every extension and skill, which a package declares as peer
 * dependencies and never bundles (Pi's `docs/packages.md`, "Declare dependencies"). Read from this
 * package's `peerDependencies`, so the manifest is the one list.
 */
export const HOST_MODULES: ReadonlyArray<string> = Object.keys(packageJson.peerDependencies)

const inPackage = (path: string) => `${DIST_DIRECTORY}/${path}`

/**
 * The manifest of the built package. The `pi-package` keyword makes it a Pi package, and the `pi`
 * key lists its resource folders, relative to the package root, which is where a `pi install` of
 * the built folder looks. Every host module is a peer dependency with the range `*`, as Pi's
 * package documentation requires.
 */
export const manifest = (): GeneratedFile => ({
  path: inPackage("package.json"),
  content: jsonText({
    name: "holyagent",
    version: packageJson.version,
    description: DESCRIPTION,
    license: "Apache-2.0",
    author: "davidbasilefilho",
    type: "module",
    keywords: ["pi-package"],
    pi: { extensions: ["./extensions"], skills: ["./skills"] },
    peerDependencies: packageJson.peerDependencies,
  }),
})

/**
 * Bundles an extension source to one ES module for Pi's Node runtime. The host modules and their
 * subpaths stay imports: Pi supplies them, and a bundled copy would create duplicate classes and
 * registries. Bun's module comments go, so the text is the same from every working directory.
 * Returns the module text, led by the note that names its source.
 */
export const bundleExtension = async (entrypoint: string, source: string): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "node",
    format: "esm",
    external: HOST_MODULES.flatMap((name) => [name, `${name}/*`]),
  })
  const output = result.outputs[0]
  if (!result.success || output === undefined)
    throw new Error(result.logs.map((log) => log.message).join("\n"))
  return `// ${generatedNote(source)}\n${(await output.text()).replace(MODULE_COMMENT, "")}`
}

const extension = async (): Promise<GeneratedFile> => ({
  path: inPackage(EXTENSION_OUTPUT),
  content: await bundleExtension(join(REPOSITORY, EXTENSION_SOURCE), EXTENSION_SOURCE),
})

const skills = async (family: Family): Promise<ReadonlyArray<GeneratedFile>> =>
  (await Effect.runPromise(skillFiles(family, generatedNote))).map(({ path, content }) => ({
    path: inPackage(`skills/${path}`),
    content,
  }))

/** Every generated file of the package for a model family, in path order. */
export const generate = async (family: Family = PI_FAMILY): Promise<ReadonlyArray<GeneratedFile>> =>
  [manifest(), await extension(), ...(await skills(family))].toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
