import { describe, expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Effect, Schema } from "effect"

import { Config } from "../../../runtime/src/config/schema.ts"
import { APPLY_PATCH_TOOL } from "../../../runtime/src/pi/codex/apply-patch.ts"
import {
  ENTER_NOTICE,
  EXIT_NOTICE,
  type Fetch,
  RESERVE_BANNER,
  RESERVE_MODEL,
} from "../../../runtime/src/pi/codex/luna-reserve.ts"
import { type CodexSettings, codexSettings, registerCodex } from "../src/codex.ts"
import { removeTemporary } from "./temp-folder.ts"

const decode = (value: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })(value))

const WITH_BILLION = await decode({ pi: { provider: "openai-codex" } })
const WITHOUT_BILLION = await decode({
  pi: { provider: "openai-codex", features: { contextCompression: false } },
})
const KIMI = await decode({ pi: { features: { contextCompression: false } } })

const WRITERS = [
  "worker-mechanical",
  "worker-implementation",
  "worker-integration",
  "worker-debugging",
  "worker-visual",
].flatMap((agent) => [agent, `${agent}-screen`, `${agent}-headless-screen`])

const settings = (config: Config): CodexSettings => {
  const found = codexSettings(config)
  if (found === undefined) throw new Error("the config selects no Codex provider")
  return found
}

describe("codexSettings", () => {
  test("is nothing at all for the Kimi provider, whatever else the config says", () => {
    expect(codexSettings(KIMI)).toBeUndefined()
  })

  test("names the GPT-6 family, the specialists that write, and each switch from the config", () => {
    expect(settings(WITH_BILLION)).toEqual({
      family: "gpt-6",
      contextManagement: false,
      lunaReserve: true,
      autoReview: {},
      applyPatchAgents: WRITERS,
    })
    expect(settings(WITHOUT_BILLION).contextManagement).toBe(true)
  })

  test("Luna Reserve follows its capability switch", async () => {
    const off = await decode({
      pi: { provider: "openai-codex", features: { lunaReserve: false } },
    })
    expect(settings(off).lunaReserve).toBe(false)
  })
})

interface Tool {
  readonly name: string
  readonly defaultActive?: boolean
  readonly parameters: unknown
  readonly execute: (
    id: string,
    params: { readonly input: string },
    signal: undefined,
    update: undefined,
    ctx: { readonly cwd: string },
  ) => Promise<{ readonly content: ReadonlyArray<{ readonly text: string }> }>
}

/** What the module reads of the context: the model, and the credential lookup of the reserve. */
interface Model {
  readonly provider: string
  readonly contextWindow: number
}

const CODEX_MODEL: Model = { provider: "openai-codex", contextWindow: 500_000 }

/** Starts the module on a stub Pi API; `held` is read on each event, as the extension reads it. */
const start = (
  held: { current: CodexSettings | undefined },
  options: { readonly fetcher?: Fetch; readonly token?: string | undefined } = {},
) => {
  const handlers = new Map<string, Array<(event: object, ctx: ExtensionContext) => unknown>>()
  const tools: Array<Tool> = []
  const notices: Array<string> = []
  const lookups: Array<string> = []
  const api = {
    registerTool: (tool: Tool) => void tools.push(tool),
    on: (event: string, handler: (event: object, ctx: ExtensionContext) => unknown) =>
      void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  }
  registerCodex(api as unknown as ExtensionAPI, {
    settings: () => held.current,
    notify: (text) => void notices.push(text),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  })
  const context = (model: Model | undefined = CODEX_MODEL) =>
    ({
      model,
      modelRegistry: {
        getApiKeyForProvider: (provider: string) => {
          lookups.push(provider)
          return Promise.resolve("token" in options ? options.token : "secret-token")
        },
      },
    }) as unknown as ExtensionContext
  const emit = async (event: string, payload: object, model?: Model) => {
    const results: Array<unknown> = []
    for (const handler of handlers.get(event) ?? [])
      results.push(await handler(payload, context(model)))
    return results
  }
  return { tools, handlers, notices, lookups, emit }
}

const request = (model: string, input: ReadonlyArray<unknown>) => ({ model, store: false, input })

describe("the apply_patch tool", () => {
  test("is registered inactive, with one string parameter, and only that tool", () => {
    const { tools } = start({ current: undefined })
    expect(tools.map((tool) => tool.name)).toEqual([APPLY_PATCH_TOOL])
    expect(tools[0]?.defaultActive).toBe(false)
    expect(JSON.stringify(tools[0]?.parameters)).toContain('"input"')
  })

  test("applies a Codex patch below the working directory and tells the model what changed", async () => {
    const folder = await mkdtemp(join(tmpdir(), "holyagent-apply-patch-"))
    try {
      await mkdir(join(folder, "src"), { recursive: true })
      await writeFile(join(folder, "src", "a.ts"), "export const a = 1\n")
      const tool = start({ current: undefined }).tools[0]
      const result = await tool?.execute(
        "call-1",
        {
          input: [
            "*** Begin Patch",
            "*** Update File: src/a.ts",
            "@@",
            "-export const a = 1",
            "+export const a = 2",
            "*** Add File: src/b.ts",
            "+export const b = 3",
            "*** End Patch",
          ].join("\n"),
        },
        undefined,
        undefined,
        { cwd: folder },
      )
      expect(result?.content[0]?.text).toBe(
        "Success. Updated the following files:\nM src/a.ts\nA src/b.ts",
      )
      expect(await readFile(join(folder, "src", "a.ts"), "utf8")).toBe("export const a = 2\n")
      expect(await readFile(join(folder, "src", "b.ts"), "utf8")).toBe("export const b = 3\n")
    } finally {
      await removeTemporary(folder)
    }
  })

  test("a patch that fails is an error the model reads, and changes nothing", async () => {
    const folder = await mkdtemp(join(tmpdir(), "holyagent-apply-patch-"))
    try {
      await writeFile(join(folder, "a.txt"), "one\n")
      const tool = start({ current: undefined }).tools[0]
      const patch = (...lines: Array<string>) =>
        ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")
      const attempt = (input: string) =>
        tool?.execute("call", { input }, undefined, undefined, { cwd: folder })
      await expect(
        attempt(
          patch("*** Update File: a.txt", "@@", "-missing", "+x", "*** Add File: b.txt", "+b"),
        ),
      ).rejects.toThrow("Failed to find expected lines")
      await expect(attempt(patch("*** Add File: ../escape.txt", "+x"))).rejects.toThrow(
        "file references must be relative",
      )
      await expect(attempt("not a patch")).rejects.toThrow("Invalid patch")
      expect(await readFile(join(folder, "a.txt"), "utf8")).toBe("one\n")
      expect(await Bun.file(join(folder, "b.txt")).exists()).toBe(false)
    } finally {
      await removeTemporary(folder)
    }
  })

  describe("on the real disk", () => {
    const patch = (...lines: Array<string>) =>
      ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")
    const inFolders = async (check: (folder: string, outside: string) => Promise<void>) => {
      const folder = await mkdtemp(join(tmpdir(), "holyagent-apply-patch-"))
      const outside = await mkdtemp(join(tmpdir(), "holyagent-apply-outside-"))
      try {
        await check(folder, outside)
      } finally {
        await removeTemporary(folder)
        await removeTemporary(outside)
      }
    }
    const attempt = (folder: string, input: string) =>
      start({ current: undefined }).tools[0]?.execute("call", { input }, undefined, undefined, {
        cwd: folder,
      })

    test("a move to the file's own path leaves the file in place with the new text", async () => {
      await inFolders(async (folder) => {
        await writeFile(join(folder, "a.txt"), "one\ntwo\n")
        await attempt(
          folder,
          patch("*** Update File: a.txt", "*** Move to: a.txt", "@@", "-one", "+1"),
        )
        expect(await readFile(join(folder, "a.txt"), "utf8")).toBe("1\ntwo\n")
      })
    })

    test("a symbolic link that leads out of the project carries no write out of it", async () => {
      await inFolders(async (folder, outside) => {
        await symlink(outside, join(folder, "linked"))
        await symlink(join(outside, "missing.txt"), join(folder, "dangling.txt"))
        await writeFile(join(outside, "victim.txt"), "safe\n")
        await symlink(join(outside, "victim.txt"), join(folder, "victim-link.txt"))
        for (const operation of [
          ["*** Add File: linked/new.txt", "+x"],
          ["*** Add File: linked/deeper/new.txt", "+x"],
          ["*** Add File: dangling.txt", "+x"],
          ["*** Update File: victim-link.txt", "@@", "-safe", "+changed"],
        ])
          await expect(attempt(folder, patch(...operation))).rejects.toThrow(
            "file references must be relative",
          )
        expect(await Bun.file(join(outside, "new.txt")).exists()).toBe(false)
        expect(await Bun.file(join(outside, "deeper", "new.txt")).exists()).toBe(false)
        expect(await Bun.file(join(outside, "missing.txt")).exists()).toBe(false)
        expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("safe\n")
      })
    })

    test("a dangling relative link inside a linked folder carries no write out of the project", async () => {
      await inFolders(async (folder, outside) => {
        // The link `l` sits in the outside folder, so its `..` climbs from there, not from the project.
        await mkdir(join(outside, "dir"))
        await symlink("../x", join(outside, "dir", "l"))
        await symlink("l", join(outside, "dir", "chain"))
        await symlink(join(outside, "dir"), join(folder, "a"))
        for (const path of ["a/l", "a/chain"])
          await expect(attempt(folder, patch(`*** Add File: ${path}`, "+x"))).rejects.toThrow(
            "file references must be relative",
          )
        expect(await Bun.file(join(outside, "x")).exists()).toBe(false)
      })
    })

    test("a dangling link in a project reached through a link is read against the real folder", async () => {
      await inFolders(async (_folder, outside) => {
        // The project is outside/real/proj, entered as outside/alias; `../alias/z` from the real
        // folder is outside/real/alias/z, beyond the project, though it looks like a path inside.
        await mkdir(join(outside, "real", "proj"), { recursive: true })
        await symlink(join(outside, "real", "proj"), join(outside, "alias"))
        await symlink("../alias/z", join(outside, "real", "proj", "d"))
        await expect(
          attempt(join(outside, "alias"), patch("*** Add File: d", "+x")),
        ).rejects.toThrow("file references must be relative")
        expect(await Bun.file(join(outside, "real", "alias", "z")).exists()).toBe(false)
        expect(await Bun.file(join(outside, "alias", "z")).exists()).toBe(false)
        // A dangling link that ends inside the project is followed.
        await symlink("inner.txt", join(outside, "real", "proj", "ok"))
        await attempt(join(outside, "alias"), patch("*** Add File: ok", "+x"))
        expect(await readFile(join(outside, "real", "proj", "inner.txt"), "utf8")).toBe("x\n")
      })
    })

    test("deleting a link that leads out of the project unlinks it and leaves the target", async () => {
      await inFolders(async (folder, outside) => {
        await writeFile(join(outside, "victim.txt"), "safe\n")
        await symlink(join(outside, "victim.txt"), join(folder, "to-victim"))
        await symlink(join(outside, "missing.txt"), join(folder, "to-nothing"))
        await attempt(folder, patch("*** Delete File: to-victim", "*** Delete File: to-nothing"))
        expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("safe\n")
        for (const name of ["to-victim", "to-nothing"])
          await expect(lstat(join(folder, name))).rejects.toThrow()
      })
    })

    test("a write that fails puts a deleted link back as a link and a non-UTF-8 file back byte for byte", async () => {
      await inFolders(async (folder, outside) => {
        const bytes = new Uint8Array([0x6f, 0x6e, 0x65, 0x0a, 0xff, 0xfe, 0x80, 0x0a])
        await writeFile(join(folder, "raw.bin"), bytes)
        await symlink(join(outside, "victim.txt"), join(folder, "to-victim"))
        await mkdir(join(folder, "dir"))
        await expect(
          attempt(
            folder,
            patch(
              "*** Delete File: to-victim",
              "*** Update File: raw.bin",
              "@@",
              "-one",
              "+1",
              // A folder cannot be written as a file.
              "*** Add File: dir",
              "+x",
            ),
          ),
        ).rejects.toThrow()
        expect(new Uint8Array(await readFile(join(folder, "raw.bin")))).toEqual(bytes)
        expect(await readlink(join(folder, "to-victim"))).toBe(join(outside, "victim.txt"))
      })
    })

    test("links that lead back to each other through a missing folder fail the patch instead of hanging", async () => {
      await inFolders(async (folder) => {
        // The kernel reports both as missing (`nosuch` is not there) while `..` flips between them.
        await symlink("nosuch/../l2", join(folder, "m1"))
        await symlink("nosuch/../m1", join(folder, "l2"))
        await expect(attempt(folder, patch("*** Add File: m1", "+x"))).rejects.toThrow("ELOOP")
        await expect(
          attempt(folder, patch("*** Update File: l2", "@@", "-a", "+b")),
        ).rejects.toThrow("ELOOP")
      })
    })

    test("a write that fails puts back the mode of a deleted file and of an overwritten one", async () => {
      await inFolders(async (folder) => {
        await writeFile(join(folder, "secret.txt"), "s\n")
        await chmod(join(folder, "secret.txt"), 0o600)
        await writeFile(join(folder, "run.sh"), "echo\n")
        await chmod(join(folder, "run.sh"), 0o755)
        // Windows keeps no POSIX permission bits (chmod only toggles the read-only flag), so the
        // mode to compare with is the one the file reports before the patch, not a literal.
        const modeOf = async (name: string) => (await lstat(join(folder, name))).mode & 0o7777
        const secretMode = await modeOf("secret.txt")
        const runMode = await modeOf("run.sh")
        if (process.platform !== "win32") {
          expect(secretMode).toBe(0o600)
          expect(runMode).toBe(0o755)
        }
        await mkdir(join(folder, "dir"))
        await expect(
          attempt(
            folder,
            patch(
              "*** Delete File: secret.txt",
              "*** Add File: run.sh",
              "+changed",
              // A folder cannot be written as a file.
              "*** Add File: dir",
              "+x",
            ),
          ),
        ).rejects.toThrow()
        expect(await readFile(join(folder, "secret.txt"), "utf8")).toBe("s\n")
        expect(await readFile(join(folder, "run.sh"), "utf8")).toBe("echo\n")
        expect(await modeOf("secret.txt")).toBe(secretMode)
        expect(await modeOf("run.sh")).toBe(runMode)
      })
    })

    test("deleting a link and adding its path makes a regular file there and leaves the target", async () => {
      await inFolders(async (folder, outside) => {
        await writeFile(join(outside, "victim.txt"), "safe\n")
        await symlink(join(outside, "victim.txt"), join(folder, "to-victim"))
        await attempt(
          folder,
          patch("*** Delete File: to-victim", "*** Add File: to-victim", "+new"),
        )
        expect((await lstat(join(folder, "to-victim"))).isSymbolicLink()).toBe(false)
        expect(await readFile(join(folder, "to-victim"), "utf8")).toBe("new\n")
        expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("safe\n")
      })
    })

    test("a failed patch puts a link back that a file replaced in the same patch", async () => {
      await inFolders(async (folder, outside) => {
        await writeFile(join(outside, "victim.txt"), "safe\n")
        await symlink(join(outside, "victim.txt"), join(folder, "to-victim"))
        await mkdir(join(folder, "dir"))
        await expect(
          attempt(
            folder,
            patch(
              "*** Delete File: to-victim",
              "*** Add File: to-victim",
              "+new",
              "*** Add File: dir",
              "+x",
            ),
          ),
        ).rejects.toThrow()
        expect(await readlink(join(folder, "to-victim"))).toBe(join(outside, "victim.txt"))
        expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("safe\n")
      })
    })

    test("Bun.file(path).delete() on a symbolic link removes the link and leaves its target", async () => {
      await inFolders(async (folder) => {
        await writeFile(join(folder, "target.txt"), "kept\n")
        await symlink(join(folder, "target.txt"), join(folder, "link"))
        await Bun.file(join(folder, "link")).delete()
        await expect(lstat(join(folder, "link"))).rejects.toThrow()
        expect(await readFile(join(folder, "target.txt"), "utf8")).toBe("kept\n")
      })
    })

    test("a link that stays inside the project is followed", async () => {
      await inFolders(async (folder) => {
        await mkdir(join(folder, "real"))
        await symlink(join(folder, "real"), join(folder, "alias"))
        await attempt(folder, patch("*** Add File: alias/file.txt", "+x"))
        expect(await readFile(join(folder, "real", "file.txt"), "utf8")).toBe("x\n")
      })
    })

    test("a write that fails puts back the files already written", async () => {
      await inFolders(async (folder) => {
        await writeFile(join(folder, "a.txt"), "one\n")
        await writeFile(join(folder, "gone.txt"), "bye\n")
        await mkdir(join(folder, "dir"))
        await expect(
          attempt(
            folder,
            patch(
              "*** Update File: a.txt",
              "@@",
              "-one",
              "+1",
              "*** Add File: new.txt",
              "+n",
              "*** Delete File: gone.txt",
              // A folder cannot be written as a file.
              "*** Add File: dir",
              "+x",
            ),
          ),
        ).rejects.toThrow()
        expect(await readFile(join(folder, "a.txt"), "utf8")).toBe("one\n")
        expect(await readFile(join(folder, "gone.txt"), "utf8")).toBe("bye\n")
        expect(await Bun.file(join(folder, "new.txt")).exists()).toBe(false)
      })
    })
  })
})

describe("context_management in the provider request", () => {
  test("is sent for a Codex request while Billion Context is off, with 90% of the model's window", async () => {
    const { emit } = start({ current: settings(WITHOUT_BILLION) })
    const [sent] = (await emit("before_provider_request", {
      payload: request("gpt-6.1-sol", [{ role: "user", content: "hi" }]),
    })) as Array<{ context_management?: unknown }>
    expect(sent?.context_management).toEqual([{ type: "compaction", compact_threshold: 450_000 }])
  })

  test("is not sent while Billion Context is on, the default", async () => {
    const { emit } = start({ current: settings(WITH_BILLION) })
    const results = await emit("before_provider_request", {
      payload: request("gpt-6.1-sol", [{ role: "user", content: "hi" }]),
    })
    expect(results).toEqual([undefined])
  })

  test("is not sent under the Kimi provider, or before the config is read", async () => {
    for (const held of [{ current: undefined }, { current: codexSettings(KIMI) }]) {
      const results = await start(held).emit("before_provider_request", {
        payload: request("k3.1-pro", []),
      })
      expect(results).toEqual([undefined])
    }
  })

  test("is not sent for a request of another provider in a Codex session", async () => {
    const results = await start({ current: settings(WITHOUT_BILLION) }).emit(
      "before_provider_request",
      { payload: request("kimi-for-coding", []) },
      { provider: "kimi-coding", contextWindow: 256_000 },
    )
    expect(results).toEqual([undefined])
  })

  test("turning Billion Context on or off between requests changes what the next one carries", async () => {
    const held = { current: settings(WITHOUT_BILLION) }
    const { emit } = start(held)
    const payload = request("gpt-6.1-terra", [{ role: "user", content: "hi" }])
    expect(await emit("before_provider_request", { payload })).not.toEqual([undefined])
    held.current = settings(WITH_BILLION)
    expect(await emit("before_provider_request", { payload })).toEqual([undefined])
  })

  test("has its own switch: off, a Codex request without Billion Context carries nothing", async () => {
    const off = await decode({
      pi: {
        provider: "openai-codex",
        features: { contextCompression: false, contextManagement: false },
      },
    })
    expect(settings(off).contextManagement).toBe(false)
    const { emit } = start({ current: settings(off) })
    expect(
      await emit("before_provider_request", {
        payload: request("gpt-6.1-sol", [{ role: "user", content: "hi" }]),
      }),
    ).toEqual([undefined])
  })

  test("replays the compaction item the stream delivered, and forgets it when Pi's history changes", async () => {
    const { emit } = start({ current: settings(WITHOUT_BILLION) })
    const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" }
    const user = (text: string) => ({ role: "user", content: text })
    const history = [user("a"), user("b")]
    await emit("before_provider_request", { payload: request("gpt-6.1-sol", history) })
    await emit("provider_stream_event", {
      provider: "openai-codex",
      data: { type: "response.output_item.done", item },
    })
    const [resent] = (await emit("before_provider_request", {
      payload: request("gpt-6.1-sol", [...history, user("c")]),
    })) as Array<{ input: ReadonlyArray<unknown> }>
    expect(resent?.input).toEqual([item, user("c")])
    // A Pi compaction clears what the session kept.
    await emit("provider_stream_event", {
      provider: "openai-codex",
      data: { type: "response.output_item.done", item },
    })
    await emit("session_compact", {})
    const [after] = (await emit("before_provider_request", {
      payload: request("gpt-6.1-sol", [user("summary"), user("d")]),
    })) as Array<{ input: ReadonlyArray<unknown> }>
    expect(after?.input).toEqual([user("summary"), user("d")])
  })
})

describe("the stream events of another provider", () => {
  test("are not a compaction of this session", async () => {
    const { emit } = start({ current: settings(WITHOUT_BILLION) })
    const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" }
    const history = [{ role: "user", content: "a" }]
    await emit("before_provider_request", { payload: request("gpt-6.1-sol", history) })
    await emit("provider_stream_event", {
      provider: "kimi-coding",
      data: { type: "response.output_item.done", item },
    })
    const [next] = (await emit("before_provider_request", {
      payload: request("gpt-6.1-sol", [...history, { role: "user", content: "b" }]),
    })) as Array<{ input: ReadonlyArray<unknown> }>
    expect(next?.input).toEqual([...history, { role: "user", content: "b" }])
  })
})

describe("Luna Reserve in the session", () => {
  const limit = {
    message: {
      role: "assistant",
      provider: "openai-codex",
      stopReason: "error",
      errorMessage: "You have hit your ChatGPT usage limit (plus plan).",
    },
  }
  const status = (banner: string | null) => () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ rate_limit_upsell: banner === null ? null : { banner_type: banner } }),
      ),
    )

  test("a usage limit with the reserve offered sends the next requests to it, and asks the user to continue", async () => {
    const seen: Array<{ url: string; authorization: string | undefined }> = []
    const fetcher: Fetch = async (url, init) => {
      seen.push({ url, authorization: (init.headers as Record<string, string>)["authorization"] })
      return status(RESERVE_BANNER)()
    }
    const { emit, notices, lookups } = start({ current: settings(WITH_BILLION) }, { fetcher })
    await emit("message_end", limit)
    expect(notices).toEqual([ENTER_NOTICE])
    expect(lookups).toEqual(["openai-codex"])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.authorization).toBe("Bearer secret-token")
    const [rerouted] = (await emit("before_provider_request", {
      payload: request("gpt-6-luna", []),
    })) as Array<{ model: string }>
    expect(rerouted?.model).toBe(RESERVE_MODEL)
  })

  test("a limit without an offer, another error, or a failed status call leaves the model alone", async () => {
    for (const fetcher of [
      status("upgrade"),
      status(null),
      () => Promise.reject(new Error("offline")),
    ] satisfies Array<Fetch>) {
      const { emit, notices } = start({ current: settings(WITH_BILLION) }, { fetcher })
      await emit("message_end", limit)
      expect(notices).toEqual([])
      expect(await emit("before_provider_request", { payload: request("gpt-6-luna", []) })).toEqual(
        [undefined],
      )
    }
    let calls = 0
    const counting: Fetch = async () => {
      calls += 1
      return status(RESERVE_BANNER)()
    }
    const { emit } = start({ current: settings(WITH_BILLION) }, { fetcher: counting })
    await emit("message_end", {
      message: {
        role: "assistant",
        provider: "openai-codex",
        stopReason: "error",
        errorMessage: "connection reset",
      },
    })
    await emit("message_end", { message: { role: "assistant", stopReason: "stop" } })
    expect(calls).toBe(0)
  })

  test("no credential means no status call and no reserve", async () => {
    let calls = 0
    const fetcher: Fetch = async () => {
      calls += 1
      return status(RESERVE_BANNER)()
    }
    const { emit, notices } = start(
      { current: settings(WITH_BILLION) },
      { fetcher, token: undefined },
    )
    await emit("message_end", limit)
    expect(calls).toBe(0)
    expect(notices).toEqual([])
  })

  test("turned off, or under another provider, it never asks the backend", async () => {
    let calls = 0
    const fetcher: Fetch = async () => {
      calls += 1
      return status(RESERVE_BANNER)()
    }
    const off = await decode({ pi: { provider: "openai-codex", features: { lunaReserve: false } } })
    for (const current of [settings(off), codexSettings(KIMI), undefined]) {
      await start({ current }, { fetcher }).emit("message_end", limit)
    }
    expect(calls).toBe(0)
  })

  test("returns to the regular model once ordinary usage is back, and keeps the reserve when the check fails", async () => {
    let banner: string | null = RESERVE_BANNER
    let failing = false
    const fetcher: Fetch = async () => {
      if (failing) throw new Error("offline")
      return status(banner)()
    }
    const { emit, notices } = start({ current: settings(WITH_BILLION) }, { fetcher })
    await emit("message_end", limit)
    failing = true
    await emit("before_agent_start", { prompt: "continue" })
    expect(notices).toEqual([ENTER_NOTICE])
    expect(
      await emit("before_provider_request", { payload: request("gpt-6-luna", []) }),
    ).not.toEqual([undefined])
    failing = false
    await emit("before_agent_start", { prompt: "continue" })
    expect(notices).toEqual([ENTER_NOTICE])
    banner = null
    await emit("before_agent_start", { prompt: "continue" })
    expect(notices).toEqual([ENTER_NOTICE, EXIT_NOTICE])
    expect(await emit("before_provider_request", { payload: request("gpt-6-luna", []) })).toEqual([
      undefined,
    ])
  })

  test("a usage limit of a turn that ran on another provider never opens the reserve or sends the token", async () => {
    let calls = 0
    const fetcher: Fetch = async () => {
      calls += 1
      return status(RESERVE_BANNER)()
    }
    const { emit, notices, lookups } = start({ current: settings(WITH_BILLION) }, { fetcher })
    for (const provider of ["kimi-coding", undefined])
      await emit("message_end", { message: { ...limit.message, provider } })
    expect(calls).toBe(0)
    expect(lookups).toEqual([])
    expect(notices).toEqual([])
    expect(await emit("before_provider_request", { payload: request("gpt-6-luna", []) })).toEqual([
      undefined,
    ])
  })

  test("a new session starts on the regular model, whatever the one before did", async () => {
    const { emit } = start(
      { current: settings(WITH_BILLION) },
      { fetcher: () => status(RESERVE_BANNER)() },
    )
    await emit("message_end", limit)
    expect(
      await emit("before_provider_request", { payload: request("gpt-6-luna", []) }),
    ).not.toEqual([undefined])
    await emit("session_start", { reason: "new" })
    expect(await emit("before_provider_request", { payload: request("gpt-6-luna", []) })).toEqual([
      undefined,
    ])
  })

  test("a resumed or forked session keeps the reserve, and a new one leaves it", async () => {
    for (const [reason, kept] of [
      ["resume", true],
      ["fork", true],
      ["new", false],
    ] as const) {
      const { emit } = start(
        { current: settings(WITH_BILLION) },
        { fetcher: () => status(RESERVE_BANNER)() },
      )
      await emit("message_end", limit)
      await emit("session_start", { reason })
      const sent = await emit("before_provider_request", { payload: request("gpt-6-luna", []) })
      expect(sent[0] === undefined).toBe(!kept)
    }
  })

  test("a run on another provider does not ask the backend whether the reserve is still offered", async () => {
    let calls = 0
    const fetcher: Fetch = async () => {
      calls += 1
      return status(RESERVE_BANNER)()
    }
    const { emit } = start({ current: settings(WITH_BILLION) }, { fetcher })
    await emit("message_end", limit)
    expect(calls).toBe(1)
    await emit(
      "before_agent_start",
      { prompt: "continue" },
      { provider: "kimi-coding", contextWindow: 1 },
    )
    await emit("before_agent_start", { prompt: "continue" })
    expect(calls).toBe(2)
  })

  test("requests that go to the reserve ask for no more than high effort, and keep a lower one", async () => {
    const { emit } = start(
      { current: settings(WITH_BILLION) },
      { fetcher: () => status(RESERVE_BANNER)() },
    )
    await emit("message_end", limit)
    const sent = async (effort: string) =>
      (
        (await emit("before_provider_request", {
          payload: { ...request("gpt-6.1-terra", []), reasoning: { effort, summary: "auto" } },
        })) as Array<{ model: string; reasoning: { effort: string; summary: string } }>
      )[0]
    expect(await sent("xhigh")).toMatchObject({
      model: RESERVE_MODEL,
      reasoning: { effort: "high", summary: "auto" },
    })
    expect((await sent("medium"))?.reasoning.effort).toBe("medium")
  })

  test("the status request refuses a redirect, so the token never follows one", async () => {
    const inits: Array<RequestInit> = []
    const fetcher: Fetch = async (_url, init) => {
      inits.push(init)
      return status(RESERVE_BANNER)()
    }
    await start({ current: settings(WITH_BILLION) }, { fetcher }).emit("message_end", limit)
    expect(inits[0]?.redirect).toBe("error")
  })
})
