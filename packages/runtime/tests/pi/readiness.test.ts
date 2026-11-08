import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import {
  type CommandRunner,
  ProviderInvalid,
  ProviderNotReady,
  providerReadiness,
  requireProviderReady,
} from "../../src/pi/readiness.ts"
import { DEFAULT_CONFIG } from "../config/defaults.ts"

/** A runner that answers every command with one result and records the commands it was given. */
const fake = (exitCode: number, stdout = "", stderr = "") => {
  const calls: Array<ReadonlyArray<string>> = []
  const run: CommandRunner = (command, args) => {
    calls.push([command, ...args])
    return Effect.succeed({ exitCode, stdout, stderr })
  }
  return { run, calls }
}

describe("providerReadiness", () => {
  test("exit 0 is ready", async () => {
    const { run } = fake(0, '{"status":"ready","provider":"kimi-coding","authType":"oauth"}')
    expect(await Effect.runPromise(providerReadiness(run, DEFAULT_CONFIG))).toEqual({
      status: "ready",
      provider: "kimi-coding",
    })
  })

  test("exit 1 is not ready and carries the login fix", async () => {
    const { run } = fake(1, '{"status":"not_ready","reason":"credentials_not_configured"}')
    const result = await Effect.runPromise(providerReadiness(run, DEFAULT_CONFIG))
    expect(result).toMatchObject({ status: "not_ready", provider: "kimi-coding" })
    expect(result).toHaveProperty("fix")
    expect(JSON.stringify(result)).toContain("/login kimi-coding")
    expect(JSON.stringify(result)).toContain("KIMI_API_KEY")
  })

  test("exit 2 is invalid and carries what Pi printed", async () => {
    const { run } = fake(2, '{"status":"invalid","reason":"invalid_state"}')
    expect(await Effect.runPromise(providerReadiness(run, DEFAULT_CONFIG))).toEqual({
      status: "invalid",
      provider: "kimi-coding",
      detail: '{"status":"invalid","reason":"invalid_state"}',
    })
  })

  test("a Pi that does not start, or another exit code, is invalid", async () => {
    for (const result of [fake(127, "", "pi: command not found"), fake(3)]) {
      expect(await Effect.runPromise(providerReadiness(result.run, DEFAULT_CONFIG))).toMatchObject({
        status: "invalid",
        provider: "kimi-coding",
      })
    }
  })

  test("asks Pi once about the selected provider only, whatever the answer", async () => {
    for (const code of [0, 1, 2]) {
      const { run, calls } = fake(code)
      const result = await Effect.runPromise(providerReadiness(run, DEFAULT_CONFIG))
      expect(calls).toEqual([["pi", "auth", "check", "--provider", "kimi-coding", "--json"]])
      expect(result.provider).toBe("kimi-coding")
    }
  })
})

describe("requireProviderReady", () => {
  test("succeeds when ready", async () => {
    await Effect.runPromise(requireProviderReady(fake(0).run, DEFAULT_CONFIG))
  })

  test("fails with the login fix as a blocker when not ready", async () => {
    const error = await Effect.runPromise(
      Effect.flip(requireProviderReady(fake(1).run, DEFAULT_CONFIG)),
    )
    expect(error).toBeInstanceOf(ProviderNotReady)
    expect(error.message).toContain("/login kimi-coding")
  })

  test("fails as invalid when Pi says so", async () => {
    const error = await Effect.runPromise(
      Effect.flip(requireProviderReady(fake(2, "bad").run, DEFAULT_CONFIG)),
    )
    expect(error).toBeInstanceOf(ProviderInvalid)
    expect(error.message).toContain("bad")
  })
})
