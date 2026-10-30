import { join } from "node:path"

import packageJson from "../package.json" with { type: "json" }
import { agentFiles, PLUGIN_NAME } from "./agents.ts"
import {
  DIST_DIRECTORY,
  FRONTEND_DESIGN_DIRECTORY,
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

const DESCRIPTION =
  "A root agent that plans work as Intents and Assignments and eighteen specialists it dispatches, with a CLI that keeps their state."

const inPlugin = (path: string) => `${DIST_DIRECTORY}/${path}`

const manifests = (): ReadonlyArray<GeneratedFile> => [
  {
    path: inPlugin(".claude-plugin/plugin.json"),
    content: jsonText({
      name: PLUGIN_NAME,
      version: packageJson.version,
      description: DESCRIPTION,
      author: { name: "davidbasilefilho" },
      license: "Apache-2.0",
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
          source: `./${DIST_DIRECTORY}`,
          description: DESCRIPTION,
          version: packageJson.version,
        },
      ],
    }),
  },
]

const SCRIPTS = "${CLAUDE_PLUGIN_ROOT}/scripts"

/**
 * One hook in exec form: Claude Code resolves `bun` on PATH and spawns it with these arguments, no
 * shell on any platform (https://code.claude.com/docs/en/hooks, "Exec form and shell form"), so the
 * hooks run on Windows without a POSIX shell. `bun.exe` is a real executable, which exec form needs
 * there, and the host substitutes `${CLAUDE_PLUGIN_ROOT}` into each argument as plain text, so a
 * path with spaces stays one argument. The flags are those of the `sh` wrapper: no `.env` and an
 * empty config file, so the project's `.env` and `bunfig.toml` cannot change the CLI.
 */
const hookCommand = (name: string, extra: Readonly<Record<string, unknown>> = {}) => ({
  type: "command",
  command: "bun",
  args: [
    "--no-env-file",
    `--config=${SCRIPTS}/empty-bunfig.toml`,
    `${SCRIPTS}/holyagent.js`,
    "hook",
    name,
  ],
  timeout: 10,
  ...extra,
})

/**
 * The rules that start the version-control reminder: a Bash command with `git` and then `commit`
 * (or `push`) anywhere in it. Probed against Claude Code 2.1.310, these match `git -C d commit`,
 * `sudo git push`, `env X=1 git commit`, `bash -c 'git push'`, `timeout 5 git push`, `xargs git
 * commit` and the same inside `&&` lists, subshells and substitutions, and they match no command
 * without both words, so `npm test` or `git status` spawn nothing. The reminder is context only, so
 * a command that hides the words (a variable, a git alias, a script) just gets none.
 */
const GIT_COMMIT = "Bash(*git*commit*)"
const GIT_PUSH = "Bash(*git*push*)"

/**
 * The six hooks. The session hook adds the state of the project (and, after a resume or compaction,
 * the reconcile result). The rules hook, on the first prompt or tool call of a main thread that did
 * not get the rules at its start (the session hook's output can arrive late or never), adds them
 * once; it has no matcher, so it sees every tool. The SubagentStart hook adds the version-control
 * rules to each specialist (it has no matcher, and the hook itself picks the plugin's specialists),
 * and the PreToolUse reminder adds them in one line to a Bash command that mentions git commit or
 * push; both only add context and never block. The workflow hook runs `onFailure: block`, because a
 * failure there would let an unvetted workflow through unexamined. The PostToolUse hook records the
 * agent of a dispatched launch, runs only for the Agent tool, and reports its own failures to the
 * root as context, since it authorizes nothing.
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
      UserPromptSubmit: [{ hooks: [hookCommand("root-rules")] }],
      SubagentStart: [{ hooks: [hookCommand("subagent-start")] }],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            hookCommand("vcs-reminder", { if: GIT_COMMIT }),
            hookCommand("vcs-reminder", { if: GIT_PUSH }),
          ],
        },
        { matcher: "Workflow", hooks: [hookCommand("workflow", { onFailure: "block" })] },
        { hooks: [hookCommand("root-rules")] },
      ],
      PostToolUse: [{ matcher: "Agent", hooks: [hookCommand("agent-launch")] }],
    },
  }),
})

/**
 * The `/holyagent:setup` command, a prompt that runs `holyagent setup` and shows its report, like
 * Billion Context's own setup command. `${CLAUDE_PLUGIN_ROOT}` is substituted in the body
 * (https://code.claude.com/docs/en/plugins-reference, "Environment variables"); the docs do not say
 * it is in `allowed-tools`, so that rule matches the bun call by its script names instead.
 */
const commands = async (): Promise<ReadonlyArray<GeneratedFile>> => {
  const source = `${SOURCES}/setup-command.md`
  return [
    {
      path: inPlugin("commands/setup.md"),
      content: noteInFrontmatter(await readSource(source), source),
    },
  ]
}

const skills = async (): Promise<ReadonlyArray<GeneratedFile>> => {
  const root = `${INSTRUCTIONS_DIRECTORY}/skills`
  return Promise.all(
    (await listFiles(root)).map(async (path) => {
      const source = `${root}/${path}`
      const text = await readSource(source)
      return {
        path: inPlugin(`skills/${path}`),
        content: path.endsWith("SKILL.md") ? noteInFrontmatter(text, source) : text,
      }
    }),
  )
}

/**
 * The license of the `frontend-design` text that the visual roles embed, byte for byte, because the
 * Apache License asks for it to travel with the text.
 */
const licenses = async (): Promise<ReadonlyArray<GeneratedFile>> => [
  {
    path: inPlugin("licenses/frontend-design/LICENSE.txt"),
    content: await readSource(`${FRONTEND_DESIGN_DIRECTORY}/LICENSE.txt`),
  },
]

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
    ...(await commands()),
    ...(await skills()),
    ...(await licenses()),
    ...(await scripts()),
  ].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
