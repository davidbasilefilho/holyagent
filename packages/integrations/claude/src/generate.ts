import { join } from "node:path"

import packageJson from "../package.json" with { type: "json" }
import { agentFiles, PLUGIN_NAME } from "./agents.ts"
import {
  DIST_DIRECTORY,
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
 * Every path the build writes, relative to the repository root: the marketplace, which Claude Code
 * reads at the repository root, and the built plugin. The build removes these before it writes and
 * touches nothing else; the commit hook stages exactly these.
 */
export const GENERATED_PATHS: ReadonlyArray<string> = [MARKETPLACE_PATH, DIST_DIRECTORY]

const SOURCES = `${PLUGIN_DIRECTORY}/src`
/** The official frontend-design skill, kept byte for byte as Anthropic ships it. */
const VENDORED_SKILLS = `${PLUGIN_DIRECTORY}/vendor`

const DESCRIPTION =
  "A root agent that plans work as Intents and Assignments and eighteen specialists it dispatches, with a CLI that keeps their state."

/**
 * The plugins this one depends on, and their marketplaces, which are allowed for cross-marketplace
 * dependencies. Claude Code installs a dependency only from a marketplace that is already added;
 * the official one is added by default. Billion Context compresses the conversation, and Exa
 * provides the web tools of the Search roles.
 */
const BILLION_CONTEXT_MARKETPLACE = "billion-context"
const OFFICIAL_MARKETPLACE = "claude-plugins-official"
const DEPENDENCIES = [
  `billion-context@${BILLION_CONTEXT_MARKETPLACE}`,
  `exa@${OFFICIAL_MARKETPLACE}`,
]

const inPlugin = (path: string) => `${DIST_DIRECTORY}/${path}`

const manifests = (): ReadonlyArray<GeneratedFile> => [
  {
    path: inPlugin(".claude-plugin/plugin.json"),
    content: jsonText({
      name: PLUGIN_NAME,
      version: packageJson.version,
      description: DESCRIPTION,
      author: { name: "davidbasilefilho" },
      dependencies: DEPENDENCIES,
    }),
  },
  { path: inPlugin("settings.json"), content: jsonText({ agent: PLUGIN_NAME }) },
  {
    path: MARKETPLACE_PATH,
    content: jsonText({
      name: PLUGIN_NAME,
      owner: { name: "davidbasilefilho" },
      description: DESCRIPTION,
      allowCrossMarketplaceDependenciesOn: [BILLION_CONTEXT_MARKETPLACE, OFFICIAL_MARKETPLACE],
      plugins: [
        {
          name: PLUGIN_NAME,
          source: `./${DIST_DIRECTORY}`,
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
 * The rules that start the redirect hook: a Bash command with `git` and then `commit` (or `push`)
 * anywhere in it. Probed against Claude Code 2.1.310, these match `git -C d commit`, `sudo git
 * push`, `env X=1 git commit`, `bash -c 'git push'`, `timeout 5 git push`, `xargs git commit` and
 * the same inside `&&` lists, subshells and substitutions, and they match no command without both
 * words, so `npm test` or `git status` spawn nothing. Narrower rules such as `git commit*` miss the
 * wrapped and option forms. What still escapes is a command that hides the words: a variable
 * (`g=git; $g commit`), a git alias, or a script that runs git inside.
 */
const GIT_COMMIT = "Bash(*git*commit*)"
const GIT_PUSH = "Bash(*git*push*)"

/**
 * The four hooks. The session hook adds the state of the project (and, after a resume or
 * compaction, the reconcile result); the two PreToolUse hooks run `onFailure: block`, because a
 * failure there would let a raw git write or an unvetted workflow through unexamined. The
 * PostToolUse hook records the agent of a dispatched launch, runs only for the Agent tool, and
 * reports its own failures to the root as context, since it authorizes nothing.
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
            hookCommand("vcs-redirect", { if: GIT_COMMIT, onFailure: "block" }),
            hookCommand("vcs-redirect", { if: GIT_PUSH, onFailure: "block" }),
          ],
        },
        { matcher: "Workflow", hooks: [hookCommand("workflow", { onFailure: "block" })] },
      ],
      PostToolUse: [{ matcher: "Agent", hooks: [hookCommand("agent-launch")] }],
    },
  }),
})

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
  const pragma = lines.indexOf("// @bun")
  if (pragma === -1) throw new Error("The bundle has no // @bun pragma line to put the note after")
  const at = pragma + 1
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
    ...(await scripts()),
  ].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
