import { mkdtemp, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { $ } from "bun"
import { Console, Effect } from "effect"

import { packPreview } from "./npm-preview-archive.ts"
import { executePreview, type PreviewExecution } from "./npm-preview-execute.ts"
import { type PreviewConfirmation, readPreviewEvidence } from "./npm-preview-live.ts"
import {
  planPreview,
  PreviewBlocked,
  type PreviewChange,
  type PreviewEvidence,
} from "./npm-preview.ts"

const registry = "https://registry.npmjs.org/"
const repo = "davidbasilefilho/holyagent"
const tag = /^pr(?:-[1-9]\d*)?$/
const version = /^0\.\d+\.\d+-pr\.([1-9]\d*)\.\d{4}-\d\d-\d\d\.\d\d-\d\d-\d\d\.g([a-f0-9]{40})$/
const stageName = (value: string) => {
  const match = version.exec(value)
  return match ? `pr-staged-${match[1]}-${match[2]}` : undefined
}
const denied = (detail: string) => new PreviewBlocked({ detail })
const run = <A>(message: string, work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: () => denied(message) })

const object = (root: string, number: number, head: string) =>
  run(`Could not obtain the exact approved object for PR ${number}`, async () => {
    if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(head))
      throw denied("Invalid PR reference")
    const has = await $`git --no-replace-objects cat-file -e ${`${head}^{commit}`}`
      .cwd(root)
      .quiet()
      .nothrow()
    if (has.exitCode === 0) return
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.RUNNER_TEMP ?? "/tmp",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    }
    await $`git --no-replace-objects -c core.hooksPath=/dev/null -c credential.helper= fetch --depth=1 --no-tags --no-recurse-submodules ${`https://github.com/${repo}.git`} ${`refs/pull/${number}/head`}`
      .cwd(root)
      .env(env)
      .quiet()
    const fetched = (await $`git --no-replace-objects rev-parse FETCH_HEAD`.cwd(root).quiet())
      .text()
      .trim()
    if (fetched !== head) throw denied("The PR HEAD changed during fetch")
  })

const equalTags = (a: Record<string, string>, b: Readonly<Record<string, string>>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every((name) => a[name] === b[name])

/** Resolve all allowed preview writes from fresh evidence. No caller-provided artifact or tag. */
export const reconcilePreviews = Effect.fn("reconcileNpmPreviews")(function* (
  io: PreviewExecution,
) {
  for (let i = 0; i < 24; i++) {
    const evidence = yield* io.evidence()
    const plan = yield* planPreview(evidence)
    const change = plan.changes[0]
    if (change) {
      yield* executePreview({ op: "tag", source: plan.sourceSha, change }, io)
      yield* Console.log(`${change.op} ${change.tag}`)
      continue
    }
    const next = plan.candidates.find(({ status }) => status === "waiting-artifact")
    if (next) {
      yield* executePreview(
        { op: "stage", source: plan.sourceSha, number: next.number, head: next.sha },
        io,
      )
      yield* Console.log(`staged exact PR ${next.number} head ${next.sha}`)
      continue
    }
    const stale = Object.entries(evidence.tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .find(([name]) => name.startsWith("pr-staged-"))
    if (!stale) return plan
    const [name, previous] = stale
    if (stageName(previous) !== name)
      return yield* denied("Cannot prove ownership of the staging tag")
    const before = yield* io.evidence()
    const fresh = yield* planPreview(before)
    if (
      JSON.stringify(fresh) !== JSON.stringify(plan) ||
      !equalTags({ ...evidence.tags }, before.tags)
    )
      return yield* denied("Preview evidence moved before staging cleanup")
    yield* io.tag({ op: "remove", tag: name, previous })
    const after = yield* io.evidence()
    const afterPlan = yield* planPreview(after)
    const expected = { ...before.tags }
    delete expected[name]
    if (JSON.stringify(afterPlan) !== JSON.stringify(fresh) || !equalTags(expected, after.tags))
      return yield* denied("Staging cleanup readback did not match; inspect before retrying")
  }
  return yield* denied("Preview write budget reached; continue with a fresh workflow run")
})

const isoEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== "GITHUB_TOKEN" &&
        /^(?:PATH|HOME|TMPDIR|CI|GITHUB_[A-Z_]+|ACTIONS_ID_TOKEN_REQUEST_(?:URL|TOKEN))$/.test(key),
    ),
  ) as Record<string, string>

/** Distribution-tag changes are constructed here, never passed through as arbitrary npm options. */
export const previewTagArgs = (change: PreviewChange): readonly string[] | undefined => {
  if (change.op === "remove")
    return tag.test(change.tag) || stageName(change.previous) === change.tag
      ? ["dist-tag", "rm", "holyagent", change.tag]
      : undefined
  const parts = version.exec(change.version)
  return parts && tag.test(change.tag) && (change.tag === "pr" || change.tag === `pr-${parts[1]}`)
    ? ["dist-tag", "add", `holyagent@${change.version}`, change.tag]
    : undefined
}

const live = (root: string, npm: string, temp: string, reviewers: string[], token: string) =>
  Effect.gen(function* () {
    let confirm: PreviewConfirmation | undefined
    const raw = () =>
      readPreviewEvidence(
        root,
        reviewers,
        token,
        fetch,
        (number, head) => object(root, number, head),
        (value) => {
          confirm = value
        },
      )
    const beforeWrite = (value: string, global: boolean) => {
      const match = version.exec(value)
      return confirm && match?.[2]
        ? confirm(Number(match[1]), match[2], global)
        : Effect.fail(denied("No exact candidate proof for the requested preview write"))
    }
    const userConfig = join(temp, "empty-user.npmrc")
    const globalConfig = join(temp, "empty-global.npmrc")
    yield* run("Could not isolate npm configuration", async () => {
      await Bun.write(userConfig, "")
      await Bun.write(globalConfig, "")
    })
    const invoke = (args: readonly string[]) =>
      run("npm rejected the preview write; verify registry state before retrying", async () => {
        const result =
          await $`node ${npm} ${args} ${[`--registry=${registry}`, "--ignore-scripts", `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`]}`
            .cwd(temp)
            .env(isoEnv())
            .quiet()
            .nothrow()
        if (result.exitCode !== 0) throw denied("npm write failed")
      })
    let pending: ((evidence: PreviewEvidence) => boolean) | undefined
    const evidence = Effect.fn("readNpmPreviewEvidence")(function* () {
      const check = pending
      if (!check) return yield* raw()
      for (let i = 0; i < 7; i++) {
        if (i) yield* Effect.sleep("10 seconds")
        const value = yield* raw()
        if (check(value)) {
          pending = undefined
          return value
        }
      }
      return yield* denied(
        "The last npm write was not visible in the readback window; inspect before retrying",
      )
    })
    const io: PreviewExecution = {
      evidence,
      pack: (number, head, utc) => packPreview(root, number, head, utc),
      tag: (change) =>
        Effect.gen(function* () {
          const args = previewTagArgs(change)
          if (!args) return yield* denied("Forbidden preview tag operation")
          if (change.op === "add") yield* beforeWrite(change.version, change.tag === "pr")
          yield* invoke(args)
          pending = (v) => v.tags[change.tag] === (change.op === "add" ? change.version : undefined)
        }),
      publish: (value, archive, staging) =>
        Effect.gen(function* () {
          if (stageName(value) !== staging) return yield* denied("Forbidden preview staging tag")
          const path = join(temp, "preview.tgz")
          yield* run("Could not stage the verified archive bytes", async () => {
            await Bun.write(path, archive)
          })
          yield* beforeWrite(value, false)
          yield* invoke(["publish", path, "--access=public", `--tag=${staging}`])
          pending = (v) =>
            v.tags[staging] === value &&
            v.candidates.some(
              ({ artifact }) =>
                artifact &&
                artifact.registryIntegrity === artifact.expectedIntegrity &&
                version.exec(value)?.[2] === artifact.sha,
            )
        }),
    }
    return yield* reconcilePreviews(io)
  })

if (import.meta.main)
  await Effect.runPromise(
    Effect.gen(function* () {
      const env = process.env
      const npm = env.PREVIEW_NPM_CLI
      const dir = env.RUNNER_TEMP
      const token = env.GH_TOKEN
      if (
        env.GITHUB_REPOSITORY !== repo ||
        env.GITHUB_REF_PROTECTED !== "true" ||
        (env.GITHUB_REF !== "refs/heads/dev" &&
          !(env.GITHUB_REF === "refs/heads/main" && env.GITHUB_EVENT_NAME === "schedule")) ||
        !npm ||
        !isAbsolute(npm) ||
        !dir ||
        !isAbsolute(dir) ||
        !token ||
        !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
      )
        return yield* denied("The preview publisher requires the protected, provisioned workflow")
      const reviewers = (env.PREVIEW_REVIEWERS ?? "").split(/[\s,]+/).filter(Boolean)
      return yield* Effect.acquireUseRelease(
        run("Could not create a private staging directory", () =>
          mkdtemp(join(dir, "holyagent-preview-")),
        ),
        (temp) => live(process.cwd(), npm, temp, reviewers, token),
        (temp) =>
          run("Could not clean the staging directory", () =>
            rm(temp, { recursive: true, force: true }),
          ).pipe(Effect.orDie),
      )
    }).pipe(
      Effect.andThen((plan) => Console.log(JSON.stringify(plan, null, 2))),
      Effect.catchTag("PreviewBlocked", ({ detail }) =>
        Console.error(detail).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1
            }),
          ),
        ),
      ),
    ),
  )
