#!/usr/bin/env bun
import { HOST_VARIABLE } from "./config.ts"
import { main } from "./entry.ts"

process.env[HOST_VARIABLE] = "claude"
await main(false, "agent")
