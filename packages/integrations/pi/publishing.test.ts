import { describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { manifest } from "./src/generate.ts"

const root = join(import.meta.dir, "../../..")
type Step = {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, string>
  env?: Record<string, string>
}
type Job = { needs?: string; steps: Step[] }
const workflow = (name: string) =>
  Bun.YAML.parse(readFileSync(join(root, `.github/workflows/${name}.yml`), "utf8")) as {
    jobs: Record<string, Job>
  }

describe("npm publication", () => {
  test("generated public manifest identifies the provenance repository", () => {
    expect((JSON.parse(manifest().content) as { repository: unknown }).repository).toEqual({
      type: "git",
      url: "https://github.com/davidbasilefilho/holyagent",
      directory: "packages/integrations/pi/dist",
    })
  })
  test("development versions use commit UTC, are deterministic and reject other refs", () => {
    const script = join(root, ".github/actions/tag-release/dev-version.sh")
    const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim()
    const env = { ...process.env, GITHUB_SHA: sha, GITHUB_REF: "refs/heads/dev" }
    const run = (tz: string, ref = env.GITHUB_REF) =>
      Bun.spawnSync(["bash", script], { cwd: root, env: { ...env, TZ: tz, GITHUB_REF: ref } })
    const first = run("UTC")
    const second = run("Pacific/Honolulu")
    expect(first.exitCode).toBe(0)
    expect(first.stdout.toString()).toBe(second.stdout.toString())
    const version = first.stdout.toString().trim()
    expect(version).toMatch(/^0\.3\.4-dev\.\d{4}-\d\d-\d\d\.\d\d-\d\d-\d\d\.g[0-9a-f]{7}$/)
    expect(Bun.semver.satisfies(version, version)).toBe(true)
    expect(run("UTC", "refs/heads/main").exitCode).not.toBe(0)
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
      mkdirSync(join(dir, ".github/actions/tag-release"), { recursive: true })
      copyFileSync(
        join(root, ".github/actions/tag-release/dev-version.sh"),
        join(dir, ".github/actions/tag-release/dev-version.sh"),
      )
      writeFileSync(join(dir, "bin/git"), "#!/bin/sh\nprintf '1794573000\\n'\n", { mode: 0o755 })
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
        env: {
          ...process.env,
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
          GITHUB_REF: "refs/heads/dev",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.stderr.toString()).toBe("")
      expect(result.exitCode).toBe(0)
      const version = name === "dev" ? "0.3.3-dev.2026-11-13.12-30-00.g0123456" : "0.3.3"
      const archive = join(dir, "runner", `holyagent-${version}.tgz`)
      expect(readFileSync(join(dir, "runner/npm.tgz"))).toEqual(readFileSync(archive))
      expect(readFileSync(join(dir, "runner/attached.tgz"))).toEqual(readFileSync(archive))
      expect(readFileSync(join(dir, "runner/npm-args"), "utf8")).toContain(
        `holyagent-${version}.tgz\n${name === "dev" ? "dev" : "latest"}\n`,
      )
      expect(readFileSync(join(dir, "runner/npm-args"), "utf8")).toContain(`holyagent-${version}\n`)
      expect(npm.env?.["GH_TOKEN"]).toBe("${{ github.token }}")
      expect(readFileSync(join(dir, "runner/gh-args"), "utf8")).toContain(`holyagent-${version}\n`)
      const manifest = Bun.spawnSync(["tar", "-xOzf", archive, "package/package.json"])
      expect(manifest.exitCode).toBe(0)
      expect(JSON.parse(manifest.stdout.toString())).toMatchObject({ name: "holyagent", version })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
