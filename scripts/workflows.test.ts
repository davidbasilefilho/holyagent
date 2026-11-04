import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const repoRoot = join(import.meta.dir, "..")
const githubDir = join(repoRoot, ".github")

/** Every workflow and every local composite action under `.github`, as paths relative to the root. */
const files = (): string[] =>
  [
    ...readdirSync(join(githubDir, "workflows")).map((name) => join(githubDir, "workflows", name)),
    ...readdirSync(join(githubDir, "actions"), { recursive: true })
      .map((entry) => join(githubDir, "actions", String(entry)))
      .filter((path) => path.endsWith("action.yml")),
  ]
    .filter((path) => /\.ya?ml$/.test(path))
    // Forward slashes on every platform: the assertions below name paths as GitHub does.
    .map((path) => relative(repoRoot, path).replaceAll("\\", "/"))
    .sort()

const read = (file: string) => readFileSync(join(repoRoot, file), "utf8")
const parse = (file: string) => Bun.YAML.parse(read(file)) as Record<string, unknown>

/** The `uses:` values of a parsed workflow or action: job-level calls and every step. */
const parsedUses = (document: Record<string, unknown>): string[] => {
  const found: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value !== null && typeof value === "object")
      for (const [key, inner] of Object.entries(value)) {
        if (key === "uses" && typeof inner === "string") found.push(inner)
        else visit(inner)
      }
  }
  visit(document)
  return found
}

/** `uses:` lines of the raw text with their trailing comment, which the YAML parser drops. */
const usesLines = (text: string): Array<{ value: string; comment: string }> =>
  [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)[ \t]*(#.*)?$/gm)].map(([, value, comment]) => ({
    value: value ?? "",
    comment: comment ?? "",
  }))

const isLocal = (uses: string) => uses.startsWith("./")

describe("the workflows", () => {
  test("the repository has the workflows the release flow needs", () => {
    const present = files()
    for (const name of ["validation", "publish", "stable", "dev"])
      expect(present).toContain(`.github/workflows/${name}.yml`)
  })

  test.each(files())(
    "%s pins every external action to a commit SHA with a version comment",
    (file) => {
      const lines = usesLines(read(file))
      // The raw scan and the parsed document must see the same `uses:` entries, so a form the scan
      // does not match cannot slip past unchecked.
      expect(lines.map(({ value }) => value).sort()).toEqual(parsedUses(parse(file)).sort())
      for (const { value, comment } of lines.filter(({ value }) => !isLocal(value))) {
        expect(value).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/)
        expect(comment).toMatch(/^# v\d+\.\d+\.\d+$/)
      }
    },
  )

  test.each(files())("%s has read-only permissions at the top", (file) => {
    const document = parse(file)
    if (file.includes("/workflows/")) expect(document["permissions"]).toEqual({ contents: "read" })
    else expect(document["permissions"]).toBeUndefined()
  })

  test("only the tag and release jobs hold contents: write", () => {
    const writers = files().flatMap((file) => {
      const document = parse(file)
      const jobs = (document["jobs"] ?? {}) as Record<string, { permissions?: unknown }>
      return Object.entries(jobs)
        .filter(([, job]) => JSON.stringify(job.permissions ?? {}).includes('"write"'))
        .map(([id, job]) => `${file}#${id}:${JSON.stringify(job.permissions)}`)
    })
    expect(writers.sort()).toEqual([
      '.github/workflows/dev.yml#prerelease:{"contents":"write"}',
      '.github/workflows/publish.yml#dev:{"contents":"write"}',
      '.github/workflows/publish.yml#stable:{"contents":"write"}',
      '.github/workflows/stable.yml#release:{"contents":"write"}',
    ])
  })
})

describe("publish.yml", () => {
  const publish = parse(".github/workflows/publish.yml") as {
    on: { push: Record<string, unknown> }
    jobs: Record<string, { uses?: string; needs?: string; if?: string }>
  }

  test("runs on branch pushes and never on tags", () => {
    expect(Object.keys(publish.on)).toEqual(["push"])
    expect(Object.keys(publish.on.push)).toEqual(["branches-ignore"])
  })

  test("skips holyagent/state, which has no package.json to validate or tag", () => {
    expect(publish.on.push["branches-ignore"]).toEqual(["holyagent/state"])
  })

  test("calls stable on main and dev elsewhere, only after validation", () => {
    expect(publish.jobs["validation"]?.uses).toBe("./.github/workflows/validation.yml")
    expect(publish.jobs["stable"]).toMatchObject({
      needs: "validation",
      if: "github.ref == 'refs/heads/main'",
      uses: "./.github/workflows/stable.yml",
    })
    expect(publish.jobs["dev"]).toMatchObject({
      needs: "validation",
      if: "github.ref != 'refs/heads/main'",
      uses: "./.github/workflows/dev.yml",
    })
  })
})

describe("validation.yml", () => {
  const validation = parse(".github/workflows/validation.yml") as {
    on: Record<string, unknown>
    concurrency: { group: string; "cancel-in-progress": unknown }
    jobs: Record<string, { if?: string; steps?: Array<{ run?: string }> }>
  }

  test("runs on pull requests and when called, with the jobs the rulesets require", () => {
    expect(Object.keys(validation.on).sort()).toEqual(["pull_request", "workflow_call"])
    expect(Object.keys(validation.jobs).sort()).toEqual([
      "branch-model",
      "check",
      "installers",
      "version",
      "windows",
    ])
  })

  test("branch-model and version run for pull requests only, version only into main", () => {
    expect(validation.jobs["branch-model"]?.if).toBe("github.event_name == 'pull_request'")
    expect(validation.jobs["version"]?.if).toBe(
      "github.event_name == 'pull_request' && github.base_ref == 'main'",
    )
  })

  test("branch-model and version fail a pull request from another repository", () => {
    for (const id of ["branch-model", "version"]) {
      const runs = (validation.jobs[id]?.steps ?? []).map((step) => step.run ?? "")
      expect(runs).toContain(
        'bun scripts/pr-checks.ts same-repository "$HEAD_REPOSITORY" "$GITHUB_REPOSITORY"',
      )
    }
  })

  test("only a pull request run is cancelled by a newer run", () => {
    expect(validation.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    )
  })
})
