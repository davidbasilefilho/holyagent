import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync as createTemp, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

// Refuse fixtures under an existing repository, even when the system temp directory is overridden.
const mkdtempSync = (prefix: string) => {
  const dir = createTemp(prefix)
  const probe = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (probe.exitCode !== 128) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error("Fixture temp directory is inside a Git repository or Git is unavailable")
  }
  return dir
}

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

  test("only authorized job permissions grant write access", () => {
    const grants = files().flatMap((file) => {
      const jobs = (parse(file)["jobs"] ?? {}) as Record<
        string,
        { permissions?: Record<string, unknown> }
      >
      return Object.entries(jobs).flatMap(([id, job]) =>
        Object.entries(job.permissions ?? {})
          .filter(([, value]) => value === "write")
          .map(([permission]) => `${file}#${id}:${permission}`),
      )
    })
    expect(grants.sort()).toEqual([
      ".github/workflows/dev.yml#prerelease:contents",
      ".github/workflows/dev.yml#publish:id-token",
      ".github/workflows/publish.yml#dev:contents",
      ".github/workflows/publish.yml#dev:id-token",
      ".github/workflows/publish.yml#stable:contents",
      ".github/workflows/publish.yml#stable:id-token",
      ".github/workflows/stable.yml#publish:id-token",
      ".github/workflows/stable.yml#release:contents",
    ])
  })

  test("only the tag and release jobs hold contents: write", () => {
    const writers = files().flatMap((file) => {
      const document = parse(file)
      const jobs = (document["jobs"] ?? {}) as Record<
        string,
        { permissions?: Record<string, unknown> }
      >
      return Object.entries(jobs)
        .filter(([, job]) => job.permissions?.contents === "write")
        .map(([id]) => `${file}#${id}`)
    })
    expect(writers.sort()).toEqual([
      ".github/workflows/dev.yml#prerelease",
      ".github/workflows/publish.yml#dev",
      ".github/workflows/publish.yml#stable",
      ".github/workflows/stable.yml#release",
    ])
  })

  test("only the stable and dev publishing jobs hold id-token: write", () => {
    const writers = files().flatMap((file) => {
      const document = parse(file)
      const jobs = (document["jobs"] ?? {}) as Record<
        string,
        { permissions?: Record<string, unknown> }
      >
      return Object.entries(jobs)
        .filter(([, job]) => job.permissions?.["id-token"] === "write")
        .map(([id]) => `${file}#${id}`)
    })
    expect(writers.sort()).toEqual([
      ".github/workflows/dev.yml#publish",
      ".github/workflows/publish.yml#dev",
      ".github/workflows/publish.yml#stable",
      ".github/workflows/stable.yml#publish",
    ])
  })
})

describe("publication authority", () => {
  test.each(["stable", "dev"])(
    "%s npm job requires the npm environment and a protected ref",
    (name) => {
      const jobs = parse(`.github/workflows/${name}.yml`)["jobs"] as Record<
        string,
        { environment?: string; if?: string }
      >
      expect(jobs["publish"]?.environment).toBe("npm")
      expect(jobs["publish"]?.if).toContain("github.ref_protected")
      expect(jobs["publish"]?.if).toBe(
        name === "stable"
          ? "github.ref == 'refs/heads/main' && github.ref_protected"
          : "github.ref == 'refs/heads/dev' && github.ref_protected",
      )
    },
  )
})

describe("release lookup", () => {
  test.each(["404", "500"])(
    "handles HTTP %s without treating operational failures as absent",
    (status) => {
      const dir = mkdtempSync(join(tmpdir(), "release-lookup-"))
      try {
        mkdirSync(join(dir, "bin"))
        // Functions take precedence over Windows executables; an isolated PATH prevents a
        // future command from accidentally reaching the installed GitHub CLI.
        const stubs = `
grep_path="$(type -P grep)"
export PATH="$PWD/bin"
grep() { "$grep_path" "$@"; }
jq() { printf 'jq\\n' >> calls; printf '0.3.3\\n'; }
gh() {
printf '%s\\n' "$*" >> calls
case "$*" in
  "api repos/owner/repo/git/ref/tags/"*) echo "commit abc" ;;
  "api repos/owner/repo/releases/tags/"*) echo "HTTP ${status}" >&2; return 1 ;;
  "release create "*) : > created ;;
  *) echo "Unexpected gh call: $*" >&2; return 2 ;;
esac
}
`
        const action = parse(".github/actions/tag-release/action.yml") as {
          runs: { steps: Array<{ run: string }> }
        }
        const script = action.runs.steps[0]?.run ?? ""
        const result = Bun.spawnSync(["bash", "-c", `${stubs}\n${script}`], {
          cwd: dir,
          env: {
            ...process.env,
            GITHUB_REPOSITORY: "owner/repo",
            SHA: "abc",
            PRERELEASE: "false",
            NOTES: "notes",
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const diagnostic = `stdout: ${result.stdout.toString()}\nstderr: ${result.stderr.toString()}`
        expect(result.exitCode, diagnostic).toBe(status === "404" ? 0 : 1)
        expect(readdirSync(dir).includes("created")).toBe(status === "404")
        const calls = readFileSync(join(dir, "calls"), "utf8")
        expect(calls).toContain("jq\n")
        expect(calls).toContain("api repos/owner/repo/git/ref/tags/holyagent-0.3.3")
        expect(calls).toContain("api repos/owner/repo/releases/tags/holyagent-0.3.3")
        expect(calls.includes("release create holyagent-0.3.3")).toBe(status === "404")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

describe("release readiness", () => {
  test("validates on macOS as well as Linux and Windows", () => {
    const jobs = parse(".github/workflows/validation.yml")["jobs"] as Record<
      string,
      { "runs-on"?: string; steps?: Array<{ run?: string }> }
    >
    expect(jobs["macos"]?.["runs-on"]).toBe("macos-latest")
    expect(jobs["macos"]?.steps?.some((step) => step.run === "mise run verify")).toBe(true)
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

  test("calls stable on protected main and dev on protected integration branches, only after validation", () => {
    expect(publish.jobs["validation"]?.uses).toBe("./.github/workflows/validation.yml")
    expect(publish.jobs["stable"]).toMatchObject({
      needs: "validation",
      if: "github.ref == 'refs/heads/main' && github.ref_protected",
      uses: "./.github/workflows/stable.yml",
    })
    expect(publish.jobs["dev"]).toMatchObject({
      needs: "validation",
      if: "github.ref == 'refs/heads/dev' && github.ref_protected",
      uses: "./.github/workflows/dev.yml",
    })
  })
})

describe("validation.yml", () => {
  const validation = parse(".github/workflows/validation.yml") as {
    on: Record<string, unknown>
    concurrency: { group: string; "cancel-in-progress": unknown }
    jobs: Record<
      string,
      {
        if?: string
        steps?: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string> }>
      }
    >
  }

  test("runs on pull requests and when called, with the jobs the rulesets require", () => {
    expect(Object.keys(validation.on).sort()).toEqual(["pull_request", "workflow_call"])
    expect(Object.keys(validation.jobs).sort()).toEqual([
      "branch-model",
      "check",
      "installers",
      "macos",
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

  test("branch-model and version fail a pull request from another repository before checkout", () => {
    for (const id of ["branch-model", "version"]) {
      const steps = validation.jobs[id]?.steps ?? []
      const guard = steps.findIndex((step) => step.name === "Require a head in this repository")
      const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"))
      expect(guard).toBe(0)
      expect(guard).toBeLessThan(checkout)
      expect(steps[guard]?.env).toEqual({
        HEAD_REPOSITORY: "${{ github.event.pull_request.head.repo.full_name }}",
      })
      expect(steps[guard]?.run).toContain('"${HEAD_REPOSITORY,,}" != "${GITHUB_REPOSITORY,,}"')
    }
  })

  test("version passes the event head ref as a quoted environment variable", () => {
    const step = validation.jobs["version"]?.steps?.find(
      (item) => item.name === "Check the version",
    )
    expect(step?.env).toEqual({ HEAD_REF: "${{ github.head_ref }}" })
    expect(step?.run).toBe('bun scripts/pr-checks.ts version main . "$HEAD_REF"')
  })

  test("only a pull request run is cancelled by a newer run", () => {
    expect(validation.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    )
  })
})
