import { join } from "node:path"

import { Effect } from "effect"

import { PI_ROOT_PLACEHOLDER } from "../../../runtime/src/hooks/pi-context.ts"
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
 * The model family whose instruction sources the package is built from: the Kimi K3.1 set, which is
 * what {@link generate} uses unless it is given another family.
 */
export const PI_FAMILY: Family = "kimi-k3.1"

/** The extension's source file, relative to the repository root. */
export const EXTENSION_SOURCE = `${SOURCES}/extension.ts`

/** The built extension, relative to the package folder: the file Pi loads from `extensions/`. */
export const EXTENSION_OUTPUT = "extensions/holyagent.js"

/** The description of the package in its manifest. */
export const DESCRIPTION =
  "HolyAgent for Pi: its skills and an extension, built from the shared holyagent runtime."

/**
 * The runtime entry the package bundles as `scripts/holyagent.js`: the CLI, plus the `config`
 * command that loads the HolyAgent config for the extension, which runs under Node.
 */
export const RUNTIME_SOURCE = "packages/runtime/src/hooks/pi-entry.ts"

/** The folders and files of the built package, which its manifest lists as the package's files. */
export const PACKAGE_FILES: ReadonlyArray<string> = ["extensions", "scripts", "skills"]

// The wrapper and its empty Bun config are the Claude plugin's, shared so the two cannot differ.
const WRAPPER_SOURCE = "packages/integrations/claude/src/wrapper.sh"
const BUNFIG_SOURCE = "packages/integrations/claude/src/empty-bunfig.toml"

// The one place the wrapper names the plugin: a hint for a run by bare name.
const WRAPPER_PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}"

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
    files: PACKAGE_FILES,
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

const readSource = (path: string): Promise<string> => Bun.file(join(REPOSITORY, path)).text()

/**
 * The runtime as one file for Bun, like the Claude plugin's `holyagent.js`: Bun's module comments
 * go, so the text is the same on every machine, and the note that names the source follows Bun's
 * `// @bun` pragma, which stays first after the shebang.
 */
const runtime = async (): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [join(REPOSITORY, RUNTIME_SOURCE)],
    target: "bun",
  })
  const output = result.outputs[0]
  if (!result.success || output === undefined)
    throw new Error(result.logs.map((log) => log.message).join("\n"))
  const lines = (await output.text()).replace(MODULE_COMMENT, "").split("\n")
  const pragma = lines.indexOf("// @bun")
  if (pragma === -1) throw new Error("The bundle has no // @bun pragma line to put the note after")
  lines.splice(pragma + 1, 0, `// ${generatedNote(RUNTIME_SOURCE)}`)
  return lines.join("\n")
}

const scripts = async (): Promise<ReadonlyArray<GeneratedFile>> => {
  const [shebang = "", ...wrapper] = (await readSource(WRAPPER_SOURCE)).split("\n")
  const text = wrapper.join("\n")
  if (!text.includes(WRAPPER_PLUGIN_ROOT))
    throw new Error(
      `${WRAPPER_SOURCE} no longer names ${WRAPPER_PLUGIN_ROOT} for the generator to replace`,
    )
  return [
    {
      path: inPackage("scripts/holyagent"),
      content: [
        shebang,
        `# ${generatedNote(WRAPPER_SOURCE)}`,
        text.replaceAll(WRAPPER_PLUGIN_ROOT, PI_ROOT_PLACEHOLDER),
      ].join("\n"),
      executable: true,
    },
    {
      path: inPackage("scripts/empty-bunfig.toml"),
      content: `# ${generatedNote(BUNFIG_SOURCE)}\n${await readSource(BUNFIG_SOURCE)}`,
    },
    { path: inPackage("scripts/holyagent.js"), content: await runtime() },
  ]
}

const skills = async (family: Family): Promise<ReadonlyArray<GeneratedFile>> =>
  (await Effect.runPromise(skillFiles(family, generatedNote))).map(({ path, content }) => ({
    path: inPackage(`skills/${path}`),
    content,
  }))

/** Every generated file of the package for a model family, in path order. */
export const generate = async (family: Family = PI_FAMILY): Promise<ReadonlyArray<GeneratedFile>> =>
  [manifest(), await extension(), ...(await scripts()), ...(await skills(family))].toSorted(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )
