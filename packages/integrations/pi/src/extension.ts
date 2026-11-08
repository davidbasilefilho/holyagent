import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * The HolyAgent extension for Pi. Pi calls this factory when it loads the package and passes the
 * extension API. It registers nothing yet: the root agent, tools and handlers arrive with the
 * extension entry, and the package ships its skills until then.
 */
export default function holyagent(_pi: ExtensionAPI): void {}
