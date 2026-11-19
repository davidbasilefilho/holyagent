import { type ExtensionAPI, type ToolInfo, VERSION } from "@earendil-works/pi-coding-agent"

import { piPackageSource } from "../../../runtime/src/config/pi-packages.ts"
import { PI_TOOL_ALIASES } from "../../../runtime/src/domain/host.ts"

const PINNED_SOURCES: Readonly<Record<string, string>> = {
  Agent: piPackageSource("@tintinweb/pi-subagents"),
  SubagentWorkflow: piPackageSource("@tintinweb/pi-subagents"),
  "fff-multi-grep": piPackageSource("@ff-labs/pi-fff"),
}

/** Only the inspected pinned package versions have known argument-preparation behavior. */
export const isPinnedAliasTarget = (target: ToolInfo): boolean =>
  target.sourceInfo?.origin === "package" &&
  target.sourceInfo.source === PINNED_SOURCES[target.name]

/** Whether Pi exposes a target to nested tool calls in its current loadout. */
export const aliasTargetCallable = (target: ToolInfo, active: ReadonlyArray<string>): boolean =>
  target.exposure === "direct"
    ? active.includes(target.name)
    : target.exposure === "codemode" || target.exposure === "deferred"

/** Register only known, collision-free aliases; every invocation traverses Pi's nested pipeline. */
export const registerToolAliases = (
  pi: ExtensionAPI,
  allowed: () => boolean = () => true,
  isSupported: (target: ToolInfo) => boolean = isPinnedAliasTarget,
  hostVersion = VERSION,
): ReadonlyArray<string> => {
  if (hostVersion !== "1.5.0") return []
  const registered: Array<string> = []
  for (const [alias, original] of Object.entries(PI_TOOL_ALIASES)) {
    const tools = pi.getAllTools()
    const target = tools.find((tool) => tool.name === original)
    if (
      target === undefined ||
      tools.some((tool) => tool.name === alias) ||
      !isSupported(target) ||
      !aliasTargetCallable(target, pi.getActiveTools())
    )
      continue
    const schema = JSON.stringify(target.parameters)
    registered.push(alias)
    pi.registerTool({
      name: alias,
      label: alias,
      description: target.description,
      parameters: target.parameters,
      exposure: target.exposure,
      defaultActive: pi.getActiveTools().includes(original),
      ...(target.promptGuidelines === undefined
        ? {}
        : { promptGuidelines: target.promptGuidelines }),
      ...(target.annotations === undefined ? {} : { annotations: target.annotations }),
      prepareLoadout: () => ({ hiddenDeclarations: [original] }),
      execute: async (_id, args, signal, onUpdate, ctx) => {
        if (!allowed())
          return {
            content: [
              { type: "text", text: "HolyAgent's Pi configuration is disabled or unavailable." },
            ],
            details: {},
            isError: true,
          }
        const current = pi.getAllTools().find((tool) => tool.name === original)
        if (
          current === undefined ||
          !isSupported(current) ||
          current.sourceInfo.path !== target.sourceInfo.path ||
          current.sourceInfo.source !== target.sourceInfo.source ||
          !aliasTargetCallable(current, pi.getActiveTools()) ||
          JSON.stringify(current.parameters) !== schema
        )
          return {
            content: [
              {
                type: "text",
                text: `The target ${original} is no longer callable with its registered schema.`,
              },
            ],
            details: {},
            isError: true,
          }
        const result = await ctx.executeTool(original, args, {
          ...(signal === undefined ? {} : { signal }),
          ...(onUpdate === undefined ? {} : { onUpdate }),
        })
        return { ...result.result, isError: result.isError || result.result.isError === true }
      },
    })
  }
  return registered
}
