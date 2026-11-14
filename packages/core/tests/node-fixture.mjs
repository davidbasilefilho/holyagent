import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { assignment, handoff, intent } from "../src/index.ts"

assert.equal(typeof globalThis.Bun, "undefined")
const cwd = await mkdtemp(join(tmpdir(), "holyagent-core-node-"))
try {
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: cwd },
    })
    assert.equal(result.status, 0, result.stderr)
  }
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.test")
  git("commit", "--allow-empty", "-m", "fixture")
  const context = {
    cwd,
    env: { HOME: cwd },
    host: "claude",
    execution: { host: "claude", ttlMinutes: 55, workflowsAvailable: false },
    authorize: () => true,
  }
  const run = Effect.runPromise
  await run(intent.create(context, { objective: "Node fixture" }))
  const draft = {
    roleTask: "Reviewer.testing",
    objective: "Review fixture",
    criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
  }
  const started = await run(assignment.dispatch(context, draft))
  const brief = await readFile(started.briefPath, "utf8")
  assert.match(brief, /Review fixture/)
  await run(assignment.record(context, { id: started.assignment.id, agent: "node-agent" }))
  const closed = await run(
    assignment.close(context, {
      id: started.assignment.id,
      outcome: "success",
      report: "evidence:\nworks: tested",
    }),
  )
  assert.equal(closed.state, "Succeeded")
  const accepted = await run(
    assignment.accept(context, { id: started.assignment.id, rationale: "verified" }),
  )
  assert.ok(accepted.acceptance)
  const snapshot = await run(handoff(context, {}))
  assert.equal(snapshot.intents[0].assignments[0].id, started.assignment.id)
  console.log("node direct lifecycle, brief and handoff passed")
} finally {
  await rm(cwd, { recursive: true, force: true })
}
