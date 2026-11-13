import { join } from "node:path"

import { Effect } from "effect"

import { bundleModule } from "../../../runtime/src/bundle.ts"
import { PI_ROOT_PLACEHOLDER } from "../../../runtime/src/hooks/pi-context.ts"
import type { Family } from "../../../runtime/src/instructions/families.ts"
import { jsonText } from "../../../runtime/src/instructions/generated.ts"
import { skillFiles } from "../../../runtime/src/instructions/skills.ts"
import { SHELL_EXTERNAL, withoutSqlite } from "../../../runtime/src/pi/bash/bundle.ts"
import { SHELL_BUNDLE } from "../../../runtime/src/pi/bash/protocol.ts"
import { PROMPT_TEMPLATES } from "../../../runtime/src/prompts/index.ts"
import { bundleSetupTui } from "../../../runtime/src/setup/tui/build.ts"
import { TUI_BUNDLE, TUI_SOURCE } from "../../../runtime/src/setup/tui/files.ts"
import { frontmatter } from "../../claude/src/agents.ts"
import packageJson from "../package.json" with { type: "json" }
import { agentFiles } from "./agents.ts"
import { bunFlags } from "./bun-flags.ts"
import { EXTRA_PI_FAMILIES, FAMILIES_FOLDER, familyAgents, familySkills } from "./families.ts"
import {
  DIST_DIRECTORY,
  type GeneratedFile,
  generatedNote,
  PI_FAMILY,
  readSource,
  REPOSITORY,
  SOURCES,
} from "./files.ts"

export { PI_FAMILY }

/**
 * Every path the build writes, relative to the repository root. The build removes these before it
 * writes and touches nothing else; the commit hook stages exactly these.
 */
export const GENERATED_PATHS: ReadonlyArray<string> = [DIST_DIRECTORY]

/** The extension's source file, relative to the repository root. */
export const EXTENSION_SOURCE = `${SOURCES}/extension.ts`

/** The built extension, relative to the package folder: the file Pi loads from `extensions/`. */
export const EXTENSION_OUTPUT = "extensions/holyagent.js"

/** The description of the package in its manifest. */
export const DESCRIPTION =
  "HolyAgent for Pi: its skills, its 18 specialists and an extension, built from the shared holyagent runtime."

/**
 * The runtime entry the package bundles as `scripts/holyagent.js`: the CLI, plus the `config`
 * command that loads the HolyAgent config for the extension, which runs under Node.
 */
export const RUNTIME_SOURCE = "packages/runtime/src/hooks/pi-entry.ts"

/**
 * The entry the package bundles as `scripts/just-bash.js` (see `SHELL_BUNDLE`): the shell process
 * the extension starts with Bun for each bash call, with just-bash inside. A bundle of its own,
 * apart from the CLI, so a move of the just-bash pin changes this file and no other.
 */
export const SHELL_SOURCE = "packages/runtime/src/pi/bash/entry.ts"

/** The folders and files of the built package, which its manifest lists as the package's files. */
export const PACKAGE_FILES: ReadonlyArray<string> = [
  "agents",
  "extensions",
  FAMILIES_FOLDER,
  "prompts",
  "scripts",
  "skills",
]

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
 * the built folder looks; Pi ignores `pi.subagents`, which `@tintinweb/pi-subagents` reads for the
 * folder of specialist agent files. Every host module is a peer dependency with the range `*`, as
 * Pi's package documentation requires. It lists no `dependencies`: Pi would install every one
 * whatever the user's config says and load none of them, since it loads a package only from the `pi
 * install` entry in its settings, which `holyagent setup` writes per config.
 */
export const manifest = (): GeneratedFile => ({
  path: inPackage("package.json"),
  content: jsonText({
    name: "holyagent",
    version: packageJson.version,
    description: DESCRIPTION,
    license: "Apache-2.0",
    author: "davidbasilefilho",
    repository: {
      type: "git",
      url: "https://github.com/davidbasilefilho/holyagent",
      directory: "packages/integrations/pi/dist",
    },
    type: "module",
    keywords: ["pi-package"],
    files: PACKAGE_FILES,
    pi: {
      extensions: ["./extensions"],
      // The first-pass review templates, which a person runs as `/code-review` and `/security-review`.
      prompts: ["./prompts"],
      skills: ["./skills"],
      // `@tintinweb/pi-subagents` loads the specialists from the folder this key names.
      subagents: { agents: ["./agents"] },
    },
    peerDependencies: packageJson.peerDependencies,
  }),
})

/**
 * Bundles an extension source to one ES module for Pi's Node runtime. The host modules and their
 * subpaths stay imports: Pi supplies them, and a bundled copy would create duplicate classes and
 * registries. Bun's module comments go, so the text is the same from every working directory.
 * Returns the module text, led by the note that names its source.
 */
export const bundleExtension = (entrypoint: string, source: string): Promise<string> =>
  Effect.runPromise(
    bundleModule(entrypoint, {
      target: "node",
      note: generatedNote(source),
      external: HOST_MODULES.flatMap((name) => [name, `${name}/*`]),
    }),
  )

const extension = async (): Promise<GeneratedFile> => ({
  path: inPackage(EXTENSION_OUTPUT),
  content: await bundleExtension(join(REPOSITORY, EXTENSION_SOURCE), EXTENSION_SOURCE),
})

/**
 * The just-bash shell as one file for Bun, with the note that names its source after Bun's `//
 *
 * @bun` pragma, as the runtime's.
 */
const shell = (): Promise<string> =>
  Effect.runPromise(
    bundleModule(join(REPOSITORY, SHELL_SOURCE), {
      target: "bun",
      note: generatedNote(SHELL_SOURCE),
      external: SHELL_EXTERNAL,
      plugins: [withoutSqlite],
    }),
  )

/**
 * The runtime as one file for Bun, like the Claude plugin's `holyagent.js`: Bun's module comments
 * go, so the text is the same on every machine, and the note that names the source follows Bun's
 * `// @bun` pragma, which stays first after the shebang.
 */
const runtime = (): Promise<string> =>
  Effect.runPromise(
    bundleModule(join(REPOSITORY, RUNTIME_SOURCE), {
      target: "bun",
      note: generatedNote(RUNTIME_SOURCE),
    }),
  )

// The wrapper's line that starts Bun. The generator writes it from `bunFlags`, so the flags are
// those the extension passes when it starts Bun itself.
const WRAPPER_EXEC = /^exec "\$bun" .*$/m

/**
 * The wrapper's line that starts Bun on the bundled CLI, with the flags of `bunFlags` in the
 * shell's words (`$here` is the wrapper's folder).
 */
const wrapperExecLine = (): string =>
  ["exec", '"$bun"', ...bunFlags('"$here/empty-bunfig.toml"'), '"$here/holyagent.js"', '"$@"'].join(
    " ",
  )

const scripts = async (): Promise<ReadonlyArray<GeneratedFile>> => {
  const [shebang = "", ...wrapper] = (await readSource(WRAPPER_SOURCE)).split("\n")
  if (!WRAPPER_EXEC.test(wrapper.join("\n")))
    throw new Error(`${WRAPPER_SOURCE} no longer has the line that starts Bun for the generator`)
  const text = wrapper.join("\n").replace(WRAPPER_EXEC, wrapperExecLine)
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
    { path: inPackage(`scripts/${SHELL_BUNDLE}`), content: await shell() },
    {
      path: inPackage(`scripts/${TUI_BUNDLE}`),
      content: await Effect.runPromise(bundleSetupTui(REPOSITORY, generatedNote(TUI_SOURCE))),
    },
  ]
}

/**
 * The folder of the runtime that holds the first-pass prompt sources, relative to the repository
 * root.
 */
export const PROMPTS_SOURCE = "packages/runtime/src/prompts"

/**
 * One prompt template for each of the package's first-pass reviews, which Pi loads from the
 * `prompts` folder the manifest names. The file is the runtime's source, which the Pi launcher also
 * reads, with the generated note added to its frontmatter.
 */
const promptFiles = (): ReadonlyArray<GeneratedFile> =>
  PROMPT_TEMPLATES.map(({ name, head, body }) => ({
    path: inPackage(`prompts/${name}.md`),
    content: `${frontmatter(generatedNote(`${PROMPTS_SOURCE}/${name}.md`), head)}\n${body}\n`,
  }))

const skills = async (family: Family, folder = "skills"): Promise<ReadonlyArray<GeneratedFile>> =>
  (await Effect.runPromise(skillFiles(family, generatedNote))).map(({ path, content }) => ({
    path: inPackage(`${folder}/${path}`),
    content,
  }))

/**
 * The specialist prompts and skills of the families a provider can run besides the package's own,
 * below `families/<family>/`: the extension swaps a session onto them when the config selects a
 * provider with that family.
 */
const otherFamilies = async (family: Family): Promise<ReadonlyArray<GeneratedFile>> =>
  (
    await Promise.all(
      EXTRA_PI_FAMILIES.filter((extra) => extra !== family).map(async (extra) => [
        ...(await agentFiles(extra, undefined, familyAgents(extra))),
        ...(await skills(extra, familySkills(extra))),
      ]),
    )
  ).flat()

/** Every generated file of the package for a model family, in path order. */
export const generate = async (family: Family = PI_FAMILY): Promise<ReadonlyArray<GeneratedFile>> =>
  [
    manifest(),
    await extension(),
    ...(await agentFiles(family)),
    ...promptFiles(),
    ...(await scripts()),
    ...(await skills(family)),
    ...(await otherFamilies(family)),
  ].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
