#!/usr/bin/env bun
import { HOST_VARIABLE } from "../cli/config.ts"
import { main } from "../cli/entry.ts"

process.env[HOST_VARIABLE] = "pi"
await main(false, "agent")
