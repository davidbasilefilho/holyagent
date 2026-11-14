#!/usr/bin/env bun
import { main } from "./entry.ts"

// Awaiting the entry keeps a pending stdin read alive on Windows.
await main()
