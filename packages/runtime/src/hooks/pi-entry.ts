#!/usr/bin/env bun
import { piEntry } from "./pi-runtime.ts"

export { configResult, enterProject, PI_CONFIG_COMMAND } from "./pi-runtime.ts"

if (import.meta.main) await piEntry()
