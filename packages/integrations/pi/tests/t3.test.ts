import { describe, expect, test } from "bun:test"

import {
  belowFullAccess,
  isT3Session,
  refuseDeactivatedT3Tool,
  T3_MCP_URL_ENV,
  T3_RUNTIME_MODE_ENV,
} from "../src/t3.ts"

describe("isT3Session", () => {
  test("is RPC mode with a variable T3 Code sets", () => {
    const rpc = { mode: "rpc" } as const
    expect(isT3Session(rpc, { [T3_RUNTIME_MODE_ENV]: "full-access" })).toBe(true)
    expect(isT3Session(rpc, { [T3_MCP_URL_ENV]: "http://127.0.0.1:9/mcp" })).toBe(true)
  })

  test("is not RPC mode alone, nor a T3 variable outside RPC mode", () => {
    expect(isT3Session({ mode: "rpc" }, {})).toBe(false)
    expect(isT3Session({ mode: "rpc" }, { [T3_RUNTIME_MODE_ENV]: " ", [T3_MCP_URL_ENV]: "" })).toBe(
      false,
    )
    for (const mode of ["tui", "json", "print"] as const)
      expect(isT3Session({ mode }, { [T3_RUNTIME_MODE_ENV]: "full-access" })).toBe(false)
  })

  test("reads the environment before the context, so a plain session never touches it", () => {
    const context = {
      get mode(): never {
        throw new Error("the context was read")
      },
    }
    expect(isT3Session(context, {})).toBe(false)
  })
})

describe("belowFullAccess", () => {
  test("is true for the modes that ask for approvals", () => {
    expect(belowFullAccess({ [T3_RUNTIME_MODE_ENV]: "approval-required" })).toBe(true)
    expect(belowFullAccess({ [T3_RUNTIME_MODE_ENV]: "auto-accept-edits" })).toBe(true)
  })

  test("is false at Full access and when no mode is set, as T3's bridge reads it", () => {
    expect(belowFullAccess({ [T3_RUNTIME_MODE_ENV]: "full-access" })).toBe(false)
    expect(belowFullAccess({ [T3_RUNTIME_MODE_ENV]: " full-access " })).toBe(false)
    expect(belowFullAccess({ [T3_RUNTIME_MODE_ENV]: "" })).toBe(false)
    expect(belowFullAccess({})).toBe(false)
  })
})

describe("refuseDeactivatedT3Tool", () => {
  test("blocks a T3 tool outside the kept families and names it", () => {
    for (const toolName of ["mcp__t3-code__delegate_task", "mcp__t3_code__t3_thread_list"]) {
      const refusal = refuseDeactivatedT3Tool({ toolName })
      expect(refusal?.block).toBe(true)
      expect(refusal?.reason).toContain(toolName)
    }
  })

  test("lets the kept families and every other tool through", () => {
    for (const toolName of [
      "mcp__t3-code__html_render",
      "mcp__t3_code__preview_open",
      "mcp__t3-code__device_tap",
      "mcp__other__delegate_task",
      "bash",
    ])
      expect(refuseDeactivatedT3Tool({ toolName })).toBeUndefined()
  })
})
