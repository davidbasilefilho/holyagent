import { version } from "../../../../../package.json" with { type: "json" }
import { type RoleTask, ROUTES } from "../../../../core/src/domain/route.ts"
import recoverWork from "../../instructions/gpt-6.2/root/recover-work.md" with { type: "text" }
import hillclimb from "../../instructions/gpt-6.2/skills/hillclimb-iteration/SKILL.md" with { type: "text" }
import workflow from "./skills/holyagent-workflow/SKILL.md" with { type: "text" }

/** The package version used by Codex's plugin cache. */
export const CODEX_ASSET_VERSION = version

/** The name of the locally provisioned native Codex marketplace. */
export const CODEX_MARKETPLACE = "holyagent-local"

/** The selector accepted by `codex plugin add`. */
export const CODEX_PLUGIN = `holyagent@${CODEX_MARKETPLACE}`

/** The default model of the native Codex integration. */
export const CODEX_MODEL = "gpt-6.2-sol"

/** The ordinary root reasoning effort for native Codex. */
export const CODEX_DEFAULT_EFFORT = "medium"

/** Native startup note. The plugin skill holds the detailed workflow. */
export const CODEX_STARTUP_GUIDANCE = `# HolyAgent

If you are a specialist, stay in your assigned scope, verify your result, and report it to the root. Do not delegate.

If you are the root, handle straightforward work directly. For independent work or material risk, load the HolyAgent workflow skill before choosing whether to delegate or ask for independent review. Use only the native tools the host actually exposes. If delegation is unavailable, continue authorized direct work and leave required independent checks open.

${recoverWork.trim()}
`

/** One UTF-8 file to stage under the marketplace root or Codex home. */
export interface CodexAsset {
  readonly path: string
  readonly content: string
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const plugin = "plugins/holyagent"

/** The skills available in both the native marketplace and the portable Cloud export. */
export const codexSkillFiles: ReadonlyArray<CodexAsset> = [
  { path: "skills/holyagent-workflow/SKILL.md", content: workflow },
  { path: "skills/hillclimb-iteration/SKILL.md", content: hillclimb },
]

/** Files of a local marketplace containing the native HolyAgent plugin. */
export const codexMarketplaceFiles = (
  assetVersion = CODEX_ASSET_VERSION,
): ReadonlyArray<CodexAsset> => [
  {
    path: ".agents/plugins/marketplace.json",
    content: json({
      name: CODEX_MARKETPLACE,
      plugins: [
        {
          name: "holyagent",
          source: { source: "local", path: `./${plugin}` },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    }),
  },
  {
    path: `${plugin}/.codex-plugin/plugin.json`,
    content: json({
      name: "holyagent",
      version: assetVersion,
      description: "Scope, ownership and evidence for Codex work.",
      skills: "./skills/",
      interface: { displayName: "HolyAgent" },
    }),
  },
  ...codexSkillFiles.map(({ path, content }) => ({ path: `${plugin}/${path}`, content })),
]

const roleProfiles = {
  "Explorer.map": ["low", "Map the requested code paths and point to the files that own them."],
  "Explorer.lookup": ["low", "Find a specific fact in the codebase and cite its source."],
  "Explorer.trace": ["medium", "Trace how the target behavior reaches its callers and effects."],
  "Librarian.lookup": ["low", "Find the requested fact in authoritative documentation."],
  "Librarian.research": ["medium", "Reconcile primary sources and identify unresolved questions."],
  "Worker.mechanical": ["low", "Apply the specified mechanical change and check its coverage."],
  "Worker.implementation": ["medium", "Implement the scoped change and verify its behavior."],
  "Worker.integration": ["medium", "Connect the components and exercise their normal entry point."],
  "Worker.operations": ["medium", "Run the scoped operation and report its observed result."],
  "Worker.validation": ["low", "Exercise the stated acceptance criteria and record the outcomes."],
  "Worker.debugging": ["high", "Isolate the cause of ambiguous behavior and verify the repair."],
  "Worker.visual": ["medium", "Implement the visual change and inspect it at the intended size."],
  "Reviewer.visual": ["high", "Review the rendered artifact and reproduce material visual issues."],
  "Reviewer.code": ["medium", "Find and prioritize actionable correctness regressions."],
  "Reviewer.testing": ["medium", "Find material coverage gaps and unreliable verification."],
  "Reviewer.audit": ["high", "Check the substantive requirements against observable evidence."],
  "Reviewer.security": ["high", "Review security boundaries and substantiate material findings."],
  "Reviewer.artifact": ["medium", "Review the artifact against its audience and requirements."],
} as const satisfies Record<RoleTask, readonly ["low" | "medium" | "high", string]>

/** Standalone role files for `agents/` under Codex home, separate from the plugin. */
export const codexRoleFiles = (): ReadonlyArray<CodexAsset> =>
  ROUTES.map(({ roleTask, agent, mutability, independence }) => {
    const [effort, purpose] = roleProfiles[roleTask]
    const name = `holyagent-${agent}`
    const scope =
      mutability === "ReadOnly"
        ? "Inspect and report without editing project files."
        : "Make changes within the paths or resources assigned to you."
    const evidence =
      independence === "IndependentReview"
        ? "Review independently of implementation. Cite concrete evidence for each material finding."
        : "Report what changed, the checks run and any unresolved blockers."
    return {
      path: `agents/${name}.toml`,
      content: [
        `name = ${JSON.stringify(name)}`,
        `description = ${JSON.stringify(purpose)}`,
        `model = ${JSON.stringify(CODEX_MODEL)}`,
        `model_reasoning_effort = ${JSON.stringify(effort)}`,
        `developer_instructions = ${JSON.stringify(`${purpose} ${scope} ${evidence}`)}`,
        "",
      ].join("\n"),
    }
  })
