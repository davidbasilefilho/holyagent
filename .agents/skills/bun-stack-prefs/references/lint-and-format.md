# Lint and format

Sourced from the oxc.rs linter and formatter docs (config, config-file reference, type-aware, plugins, CLI), oxlint 1.91.0 on 2026-11-04, and checked by running oxlint 1.91.0, oxlint-tsgolint 7.0.2005, oxfmt 0.76.0 and eslint-plugin-jsdoc 65.4.3 under Bun 1.4.4 with the configs below. Versions move: check current docs with web search or fetch before relying on an option.

## Install

```
bun add -D oxlint oxlint-tsgolint oxfmt typescript
```

Then normalize the written ranges per `bun-prefs` (for example `^1.91.0` becomes `^1.0.0`). Type-aware linting is powered by typescript-go, needs TypeScript 7.0 or newer, and does not support some legacy tsconfig options (for example `baseUrl`). It covers 59 of 61 typescript-eslint type-aware rules.

## oxlint

Config file: `.oxlintrc.json` (also `.oxlintrc.jsonc`, `oxlint.config.ts`, `oxlint.config.mts`; only one per directory). Prefer the JSON file: the docs mark JS and TS config files as experimental and needing Node.js. `oxlint --init` writes a starter. `oxlint -c <path>` sets a config and disables nested lookup.

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["eslint", "typescript", "unicorn", "oxc", "import", "jsdoc", "promise"],
  "jsPlugins": [{ "name": "jsdoc-js", "specifier": "eslint-plugin-jsdoc" }],
  "categories": { "correctness": "error", "suspicious": "warn" },
  "options": { "typeAware": true, "typeCheck": true },
  "rules": {
    "jsdoc-js/require-jsdoc": ["error", { "publicOnly": true }],
    "jsdoc/check-tag-names": "error",
    "jsdoc/empty-tags": "error",
    "jsdoc/require-param": "error",
    "jsdoc/require-returns": "error"
  },
  "ignorePatterns": ["dist"]
}
```

This config loaded and ran: it flagged an undocumented exported function and a type error, and left an undocumented private function alone.

- **`options.typeAware` and `options.typeCheck`**: booleans, equal to `--type-aware` and `--type-check`. Both need `oxlint-tsgolint`, are valid in the root config only (nested configs must not set them), and a CLI flag overrides the config. `typeCheck` reports TypeScript compiler diagnostics and is experimental. Type-aware rules live in the `typescript/*` namespace (for example `typescript/no-floating-promises`) and need `"typescript"` in `plugins`.
- **Plugins**: setting `plugins` overwrites the default set, so list every plugin wanted. The valid names are `eslint, react, unicorn, typescript, oxc, import, jsdoc, jest, vitest, jsx-a11y, nextjs, react-perf, promise, node, vue`; the defaults are `eslint, typescript, unicorn, oxc`. Choose for the project: add `react` (includes hooks and React Compiler rules) with `jsx-a11y` and `react-perf` for React, `nextjs` for Next.js, `vue` for Vue, `node` for Node code. Tests use `bun test`, so add `jest` or `vitest` rules only after checking they apply to `bun:test` files.
- **Categories**: `correctness` (default), `suspicious`, `pedantic`, `perf`, `style`, `restriction`, `nursery`. Individual `rules` override categories, and categories apply only to enabled plugins. Choose levels with the user's project in mind rather than enabling everything.
- **JSDoc linting**: enable the `jsdoc` plugin and the rules above. Native rules checked: `check-tag-names`, `empty-tags`, `require-param`, `require-returns`, among others (`check-access`, `check-property-names`, `implements-on-classes`, `no-defaults`, `require-yields`).
- **JSDoc required for public API only**: oxlint 1.91.0 has no native `jsdoc/require-jsdoc` (configuring it fails with "Rule 'require-jsdoc' not found in plugin 'jsdoc'"). Use `eslint-plugin-jsdoc` as a JS plugin under an alias (`jsdoc-js` above; the native names are reserved), whose `require-jsdoc` rule takes `publicOnly`. JS plugins are alpha and not covered by semver. Install it with `bun add -D eslint-plugin-jsdoc` and normalize the range. Verify against current docs whether a native `jsdoc/require-jsdoc` with a public-only option now exists, and prefer it if so.
- **React**: with the `react` plugin and `correctness` as `error`, the recommended React Compiler rules turn on. Check current docs for the rule list.

## oxfmt

Config file: `.oxfmtrc.json` (also `.oxfmtrc.jsonc`, `oxfmt.config.ts`, `oxfmt.config.mts`; the nearest config to each file wins, one per directory). `.editorconfig` is read for `end_of_line`, `indent_style`, `indent_size`, `max_line_length` and `insert_final_newline`.

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "bracketSameLine": true,
  "jsdoc": true,
  "sortImports": true,
  "sortPackageJson": true,
  "sortTailwindcss": true
}
```

- Drop `sortTailwindcss` when the project does not use Tailwind. The key's casing varies between sources (`sortTailwindcss` here); check it against the oxfmt schema file (`configuration_schema.json`) before writing it.
- `jsdoc`, `sortImports` and `sortTailwindcss` default to off, so set them explicitly. `sortPackageJson` defaults to on; set it anyway. Its key order is not compatible with `prettier-plugin-packagejson`.
- Tailwind sub-options: `config` (Tailwind v3), `stylesheet` (Tailwind v4), `functions`, `attributes`, `preserveDuplicates`, `preserveWhitespace`. Set `stylesheet` or `config` to the project's entry file.
- Other options (exact casing, defaults): `printWidth` (100), `tabWidth` (2), `useTabs`, `semi`, `singleQuote`, `jsxSingleQuote`, `trailingComma`, `bracketSpacing`, `arrowParens`, `quoteProps`, `objectWrap`, `endOfLine`, `proseWrap`, `singleAttributePerLine`, `ignorePatterns`, `overrides`. `jsdoc` and `sortImports` take sub-options when an object is given instead of `true`.
- CLI: `oxfmt` writes by default, `oxfmt --check` checks (it exited 1 on an unformatted file when tried), `--list-different` lists files that would change. With no paths it uses the current directory and honors `.gitignore`.
