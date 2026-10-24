import { join } from "node:path"

import { WORKFLOW_NAMES } from "../../../runtime/src/domain/plan.ts"
import packageJson from "../package.json" with { type: "json" }
import { agentFiles, PLUGIN_NAME } from "./agents.ts"
import {
  type GeneratedFile,
  generatedNote,
  INSTRUCTIONS_DIRECTORY,
  jsonText,
  listFiles,
  noteInFrontmatter,
  PLUGIN_DIRECTORY,
  readSource,
  REPOSITORY,
} from "./files.ts"

/** The marketplace file at the repository root. */
export const MARKETPLACE_PATH = ".claude-plugin/marketplace.json"

/**
 * Every path the build writes, relative to the repository root. The build removes these before it
 * writes and touches nothing else; the commit hook stages exactly these.
 */
export const GENERATED_PATHS: ReadonlyArray<string> = [
  MARKETPLACE_PATH,
  `${PLUGIN_DIRECTORY}/.claude-plugin/plugin.json`,
  `${PLUGIN_DIRECTORY}/settings.json`,
  `${PLUGIN_DIRECTORY}/agents`,
  `${PLUGIN_DIRECTORY}/skills`,
  `${PLUGIN_DIRECTORY}/hooks/hooks.json`,
  `${PLUGIN_DIRECTORY}/workflows`,
  `${PLUGIN_DIRECTORY}/scripts`,
]

const SOURCES = `${PLUGIN_DIRECTORY}/src`
/** The official frontend-design skill, kept byte for byte as Anthropic ships it. */
const VENDORED_SKILLS = `${PLUGIN_DIRECTORY}/vendor`

const DESCRIPTION =
  "A root agent that plans work as Intents and Assignments and eighteen specialists it dispatches, with a CLI that keeps their state."

const inPlugin = (path: string) => `${PLUGIN_DIRECTORY}/${path}`

const manifests = (): ReadonlyArray<GeneratedFile> => [
  {
    path: inPlugin(".claude-plugin/plugin.json"),
    content: jsonText({
      name: PLUGIN_NAME,
      version: packageJson.version,
      description: DESCRIPTION,
      author: { name: "davidbasilefilho" },
    }),
  },
  { path: inPlugin("settings.json"), content: jsonText({ agent: PLUGIN_NAME }) },
  {
    path: MARKETPLACE_PATH,
    content: jsonText({
      name: PLUGIN_NAME,
      owner: { name: "davidbasilefilho" },
      description: DESCRIPTION,
      plugins: [
        {
          name: PLUGIN_NAME,
          source: `./${PLUGIN_DIRECTORY}`,
          description: DESCRIPTION,
          version: packageJson.version,
        },
      ],
    }),
  },
]

const WRAPPER = "${CLAUDE_PLUGIN_ROOT}/scripts/holyagent"
const hookCommand = (name: string, extra: Readonly<Record<string, unknown>> = {}) => ({
  type: "command",
  command: WRAPPER,
  args: ["hook", name],
  timeout: 10,
  ...extra,
})

/**
 * The three hooks. The session hook adds the state of the project; the two PreToolUse hooks run
 * `onFailure: block`, because a failure there would let a raw git write or an unvetted workflow
 * through unexamined.
 */
const hooks = (): GeneratedFile => ({
  path: inPlugin("hooks/hooks.json"),
  content: jsonText({
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact",
          hooks: [hookCommand("session-start")],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            hookCommand("vcs-redirect", { if: "Bash(git commit*)", onFailure: "block" }),
            hookCommand("vcs-redirect", { if: "Bash(git push*)", onFailure: "block" }),
          ],
        },
        { matcher: "Workflow", hooks: [hookCommand("workflow", { onFailure: "block" })] },
      ],
    },
  }),
})

const INCLUDE = "// @include shared.js\n"

const workflows = async (): Promise<ReadonlyArray<GeneratedFile>> => {
  const shared = await readSource(`${SOURCES}/workflows/shared.js`)
  return Promise.all(
    WORKFLOW_NAMES.map(async (name) => {
      const source = `${SOURCES}/workflows/${name}.js`
      const script = await readSource(source)
      if (!script.includes(INCLUDE)) throw new Error(`${source} has no ${INCLUDE.trim()} line`)
      const note = `// ${generatedNote(`${source} and ${SOURCES}/workflows/shared.js`)}\n`
      return {
        path: inPlugin(`workflows/${name}.js`),
        content: script.replace(INCLUDE, `${note}${shared}`),
      }
    }),
  )
}

const skills = async (): Promise<ReadonlyArray<GeneratedFile>> => {
  const root = `${INSTRUCTIONS_DIRECTORY}/skills`
  const own = (await listFiles(root)).map(async (path) => {
    const source = `${root}/${path}`
    const text = await readSource(source)
    return {
      path: inPlugin(`skills/${path}`),
      content: path.endsWith("SKILL.md") ? noteInFrontmatter(text, source) : text,
    }
  })
  const vendored = (await listFiles(VENDORED_SKILLS)).map(async (path) => ({
    path: inPlugin(`skills/${path}`),
    content: await readSource(`${VENDORED_SKILLS}/${path}`),
  }))
  return Promise.all([...own, ...vendored])
}

const BUNDLE_MARKER = /^\/\/ \S+\.(?:[cm]?[jt]s|json|md)$\n/gm

/**
 * The CLI as one file for Bun. Bun's comment above each module names its path in node_modules,
 * which depends on how dependencies were installed, so those comments go and the build is the same
 * on every machine.
 */
const bundle = async (): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [join(REPOSITORY, "packages/runtime/src/cli/main.ts")],
    target: "bun",
  })
  const output = result.outputs[0]
  if (!result.success || output === undefined)
    throw new Error(result.logs.map((log) => log.message).join("\n"))
  const lines = (await output.text()).replace(BUNDLE_MARKER, "").split("\n")
  // Keep the shebang and Bun's `// @bun` pragma first.
  const at = lines.indexOf("// @bun") + 1
  lines.splice(at, 0, `// ${generatedNote("packages/runtime/src/cli/main.ts")}`)
  return lines.join("\n")
}

const scripts = async (): Promise<ReadonlyArray<GeneratedFile>> => {
  const [shebang = "", ...wrapper] = (await readSource(`${SOURCES}/wrapper.sh`)).split("\n")
  const toml = await readSource(`${SOURCES}/empty-bunfig.toml`)
  return [
    {
      path: inPlugin("scripts/holyagent"),
      content: [shebang, `# ${generatedNote(`${SOURCES}/wrapper.sh`)}`, ...wrapper].join("\n"),
      executable: true,
    },
    {
      path: inPlugin("scripts/empty-bunfig.toml"),
      content: `# ${generatedNote(`${SOURCES}/empty-bunfig.toml`)}\n${toml}`,
    },
    { path: inPlugin("scripts/holyagent.js"), content: await bundle() },
  ]
}

/** Every generated file, in path order. The same sources always give the same files. */
export const generate = async (): Promise<ReadonlyArray<GeneratedFile>> =>
  [
    ...manifests(),
    hooks(),
    ...(await agentFiles()),
    ...(await skills()),
    ...(await workflows()),
    ...(await scripts()),
  ].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
