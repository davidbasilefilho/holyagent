# Attributions

## Billion Context and acp-kernel

HolyAgent installs and configures [Billion Context](https://github.com/ranxianglei/billion-context) (`billion-context` on npm), which compresses the conversation with its [acp-kernel](https://github.com/ranxianglei/acp-kernel) ([components.md](components.md)). Billion Context is MIT licensed, Copyright (c) 2026 ranxianglei, with an additional term. This page is part of HolyAgent's documentation and carries the notice that term asks for.

**This product uses billion-context and acp-kernel.**

- billion-context: https://github.com/ranxianglei/billion-context
- acp-kernel: https://github.com/ranxianglei/acp-kernel

The term in its `LICENSE`, quoted:

> if you use or incorporate the Software (including its kernels, e.g. acp-kernel) in a product or service that end users can see or interact with - whether commercial or open source - you must make attribution clearly visible in at least one of the following places: 1. the product's home page; 2. its documentation; or 3. its "About" / "Credits" / "Acknowledgements" page. The attribution must state that the product uses billion-context (and acp-kernel, where applicable) and include a link to https://github.com/ranxianglei/billion-context (and https://github.com/ranxianglei/acp-kernel, where applicable). For purely server-side or embedded uses with no user-facing surface, carrying these notices in the shipped documentation satisfies this term.

## Vendored skill

`frontend-design` is Anthropic's skill. Its text is embedded in the `worker-visual` and `reviewer-visual` agents, not shipped as a skill: the build takes the vendored `SKILL.md` without its frontmatter and moves its headings down two levels. Its terms are in its own `LICENSE.txt` (Apache License 2.0), kept next to the vendored text in `packages/integrations/claude/vendor/frontend-design/` and, byte for byte, in the built plugin at `packages/integrations/claude/dist/licenses/frontend-design/LICENSE.txt`; both agents name that path. The vendored files are kept as Anthropic ships them, and the formatter and linter skip them.

## Other software

| Software                                    | Use                                                                                                             | License                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Context7](https://context7.com) and `ctx7` | Documentation lookup CLI and the skill and rule that `ctx7 setup` installs; by Upstash                          | MIT (`ctx7` package)                                                                                  |
| [Effect](https://effect.website)            | Effects, errors and schemas in the runtime and the public CLI                                                   | MIT                                                                                                   |
| [acorn](https://github.com/acornjs/acorn)   | JavaScript parser the `Workflow` hook uses to read an inline script (`workflow-check.ts`), bundled into the CLI | MIT                                                                                                   |
| [Bun](https://bun.sh)                       | Runtime, test runner, bundler and the type-check, lint and format toolchain                                     | MIT ([LICENSE](https://github.com/oven-sh/bun/blob/main/LICENSE.md); it links JavaScriptCore, LGPL-2) |
| [lefthook](https://lefthook.dev)            | Git hooks                                                                                                       | MIT                                                                                                   |
| [mise](https://mise.jdx.dev)                | Tool versions and the repository's commands                                                                     | MIT                                                                                                   |
| [TOON](https://toonformat.dev)              | The compact output format of the runtime CLI (`@toon-format/toon`)                                              | MIT                                                                                                   |
| [Claude Code](https://code.claude.com)      | The harness the plugin runs in; a product of Anthropic, not redistributed here                                  | its own terms                                                                                         |
