import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "../../..")
type Step = { name?: string; run?: string; uses?: string; with?: Record<string, string> }
type Job = { needs?: string; steps: Step[] }
const workflow = (name: string) =>
  Bun.YAML.parse(readFileSync(join(root, `.github/workflows/${name}.yml`), "utf8")) as {
    jobs: Record<string, Job>
  }

describe("npm publication", () => {
  test("a numeric short SHA with a leading zero is valid in the dev prerelease", () => {
    const version = `0.3.3-dev-${"0123456"}`
    expect(Bun.semver.satisfies(version, version)).toBe(true)
  })

  test.each(["stable", "dev"])("%s hands the packed bytes from npm to GitHub", (name) => {
    const dir = mkdtempSync(join(tmpdir(), "npm-handoff-"))
    try {
      const jobs = workflow(name).jobs
      const publish = jobs["publish"]!
      const release = jobs[name === "stable" ? "release" : "prerelease"]!
      expect(release.needs).toBe("publish")
      const pack = publish.steps.find((step) => step.run?.includes("bun pm pack"))!
      const npm = publish.steps.find((step) => step.run?.includes("scripts/npm-publishing.ts"))!
      const upload = publish.steps.find((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      )!
      const download = release.steps.find((step) =>
        step.uses?.startsWith("actions/download-artifact@"),
      )!
      const attach = release.steps.find((step) => step.run?.includes("gh release upload"))!
      expect(publish.steps.indexOf(pack)).toBeLessThan(publish.steps.indexOf(npm))
      expect(publish.steps.indexOf(npm)).toBeLessThan(publish.steps.indexOf(upload))
      const tag = release.steps.find((step) => step.uses === "./.github/actions/tag-release")!
      expect(release.steps.indexOf(download)).toBeLessThan(release.steps.indexOf(tag))
      expect(release.steps.indexOf(tag)).toBeLessThan(release.steps.indexOf(attach))
      expect(publish.steps.some((step) => step.run === "bun install --frozen-lockfile")).toBe(true)
      expect(upload.with?.["name"]).toBe(download.with?.["name"])
      expect(upload.with?.["path"]).toBe("${{ runner.temp }}/holyagent-*.tgz")
      expect(download.with?.["path"]).toBe("${{ runner.temp }}")
      mkdirSync(join(dir, "packages/integrations/pi/dist"), { recursive: true })
      mkdirSync(join(dir, "bin"))
      mkdirSync(join(dir, "runner"))
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.3", private: true }))
      writeFileSync(
        join(dir, "packages/integrations/pi/dist/package.json"),
        JSON.stringify({ name: "holyagent", version: "0.3.3", files: ["index.js"] }),
      )
      writeFileSync(join(dir, "packages/integrations/pi/dist/index.js"), "export default 1\n")
      writeFileSync(
        join(dir, "bin/jq"),
        `#!/bin/sh
if [ "$1" = "-r" ]; then node -e 'console.log(require(process.argv[1]).version)' "$PWD/$3"; else node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));p.version=process.argv[2];console.log(JSON.stringify(p))' "$5" "$3"; fi
`,
        { mode: 0o755 },
      )
      writeFileSync(
        join(dir, "bin/bun"),
        `#!/bin/sh
if [ "$1" = "scripts/npm-publishing.ts" ]; then printf '%s\\n' "$@" > "$RUNNER_TEMP/npm-args"; cp "$2" "$RUNNER_TEMP/npm.tgz"; else "$REAL_BUN" "$@"; fi
`,
        { mode: 0o755 },
      )
      writeFileSync(
        join(dir, "bin/gh"),
        `#!/bin/sh
printf '%s\\n' "$@" > "$RUNNER_TEMP/gh-args"
cp "$4" "$RUNNER_TEMP/attached.tgz"
`,
        { mode: 0o755 },
      )
      const script = `set -e
REAL_BUN="$(command -v bun)"; export REAL_BUN
export PATH="$PWD/bin:$PATH"
export RUNNER_TEMP="$PWD/runner"
(
${pack.run}
)
${npm.run}
mkdir "$PWD/transfer"
cp "$RUNNER_TEMP"/holyagent-*.tgz "$PWD/transfer/"
rm "$RUNNER_TEMP"/holyagent-*.tgz
cp "$PWD/transfer/"*.tgz "$RUNNER_TEMP/"
${attach.run}
`
      const result = Bun.spawnSync(["bash", "-c", script], {
        cwd: dir,
        env: { ...process.env, GITHUB_SHA: "0123456789abcdef" },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.stderr.toString()).toBe("")
      expect(result.exitCode).toBe(0)
      const version = name === "dev" ? "0.3.3-dev-0123456" : "0.3.3"
      const archive = join(dir, "runner", `holyagent-${version}.tgz`)
      expect(readFileSync(join(dir, "runner/npm.tgz"))).toEqual(readFileSync(archive))
      expect(readFileSync(join(dir, "runner/attached.tgz"))).toEqual(readFileSync(archive))
      expect(readFileSync(join(dir, "runner/npm-args"), "utf8")).toContain(
        `holyagent-${version}.tgz\n${name === "dev" ? "dev" : "latest"}\n`,
      )
      expect(readFileSync(join(dir, "runner/gh-args"), "utf8")).toContain(`holyagent-${version}\n`)
      const manifest = Bun.spawnSync(["tar", "-xOzf", archive, "package/package.json"])
      expect(manifest.exitCode).toBe(0)
      expect(JSON.parse(manifest.stdout.toString())).toMatchObject({ name: "holyagent", version })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
