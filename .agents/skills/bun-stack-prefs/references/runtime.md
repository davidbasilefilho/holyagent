# Runtime

Sourced from the Convex, Cloudflare and Vercel runtime docs and from the `portablejs/portable` repository, read on 2026-11-04. Runtimes change often: re-check the deploy target's current docs with web search or fetch before deciding what it supports.

## The rule in practice

- Code that runs only on Bun uses Bun runtime APIs freely.
- Code that runs on a target without them (Cloudflare Workers, Convex backend code, and similar) uses portable code: `fetch`, `Request`, `Response`, `Headers`, `URL`, web streams, `TextEncoder`, `crypto.subtle`, `atob` and `btoa`, plus `node:` modules only where the target lists them.
- Shared packages that both kinds of app import are portable. Put Bun-only calls behind an adapter module that only Bun-only apps import.

## Target notes

- **Convex** default runtime: web standards (fetch in actions only, Request, Response, Headers, Blob, File, streams, TextEncoder, `crypto.subtle`, `atob`, `btoa`, `performance.now`) and only a few Node APIs (`process.env`, `AsyncLocalStorage`, `AsyncResource`). A `"use node"` action runtime exists for anything more. Queries and mutations must be deterministic.
- **Cloudflare Workers**: a subset of Node APIs is available (Buffer, crypto, fs, path, stream, zlib and others). For compatibility dates from 2026-08-04 `nodejs_compat` is on by default; for earlier dates add `nodejs_compat` to `compatibility_flags`. Check the docs for the exact subset.
- **Vercel edge**: a subset of web APIs. Vercel recommends moving from edge to Node.js, and newer Next.js versions no longer support `runtime = 'edge'`. Verify before choosing it.

## portablejs/portable

Repository https://github.com/portablejs/portable, site https://portablejs.com.
- What it is: about 45 `@portable/*` packages of web-standard building blocks (streams, base64, csv, jsonl, sse, websockets, web-crypto, password, webhooks, smtp, dkim, queue, timers, rate-limit, log and more), imported as namespaces such as `import * as Csv from '@portable/csv'`. It does not offer `Bun.file`, `Bun.serve`, `Bun.password` or other Bun APIs, so it is not a shim: it closes the gap by giving portable building blocks to use instead of those APIs.
- Runtimes: its tests run in Chromium, Firefox, WebKit, Node, Bun and Deno, and a check of every package runs in workerd (Cloudflare Workers). Convex is not mentioned. `smtp` and `sockets` need a TCP socket API, which Workers and Convex may not offer.
- Maturity: the repository was created on 2026-10-20, with about 30 stars and 8 open issues when read, and no package versions or release history were inspected.
- Use: when portable code needs a capability the target lacks natively (for example CSV, JSONL, SSE or password hashing) and the user's runtime is on its list, evaluate the matching `@portable/*` package first. Before adopting any package, check its current version, release history and runtime support with web search or fetch, tell the user about its age, and pin it under the `bun-prefs` range rule. Do not use it for code that only runs on Bun.
