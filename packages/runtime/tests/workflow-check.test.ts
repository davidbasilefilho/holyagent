import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { workflowRefusal } from "../src/cli/workflow-check.ts"

const META = 'export const meta = { name: "w", description: "d" }'
const AGENT = "await agent('p', { agentType: 'holyagent:worker-implementation' })"

/** The refusal of a script made of the lines, with a vetted agent() call and the meta. */
const refusal = (...lines: ReadonlyArray<string>) =>
  Effect.runPromise(workflowRefusal([META, ...lines, AGENT].join("\n")))

/** The refusal of a script as it stands. */
const refusalOf = (script: string) => Effect.runPromise(workflowRefusal(script))

describe("the workflow check refuses a function that calls itself", () => {
  test.each<readonly [string, string]>([
    [
      "an async function that starts agents again",
      "async function f() { await agent('p', { agentType: 'holyagent:worker-implementation' }); return f() }\nawait f()",
    ],
    [
      "a function that is its own callback",
      "function f() { return Promise.resolve().then(f) }\nf()",
    ],
    ["a function that calls itself twice", "function f(n) { f(n - 1); f(n - 1) }\nf(100)"],
    ["two functions that call each other", "function f() { g() }\nfunction g() { f() }\nf()"],
    ["an arrow function bound to a name", "const f = () => f()\nf()"],
    ["a function assigned later", "let f\nf = () => [1].map(() => f())\nf()"],
    ["a named function expression", "const f = function g() { g() }\nf()"],
    ["a function expression called in place", ";(function g() { g() })()"],
    ["a function that calls the callback it is given", "const t = (cb) => cb(cb)\nt((c) => t(c))"],
    [
      "a function that maps over the callback it is given",
      "const t = (cb) => [1].map(cb)\nt(() => t(() => 1))",
    ],
    [
      "a function that runs the thunks it is given",
      "const t = (thunks) => parallel(thunks)\nconst make = () => [() => t(make())]\nawait t(make())",
    ],
    [
      "a function kept in an object, for a call to find",
      "const o = { then: (resolve) => resolve(o) }\nawait o",
    ],
    ["a function kept in an array", "const fs = [() => fs[0]()]\nfs[0]()"],
    ["a function passed as a value", "const f = () => 1\nlog([1].map(f))"],
    ["a function aliased", "const f = () => 1\nconst g = f\ng()"],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    [
      "a helper called from a callback",
      "const run = (id) => agent('p ' + id, { agentType: 'holyagent:worker-implementation', label: id })\nawait Promise.all(['a', 'b'].map((id) => run(id)))",
    ],
    [
      "a function that calls an earlier one",
      "function one(n) { return n + 1 }\nfunction two(n) { return one(one(n)) }\nlog(two(1))",
    ],
    [
      "a callback that builds thunks",
      "await parallel(['a', 'b'].map((id) => () => agent(id, { agentType: 'holyagent:explorer-map' })))",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check refuses arrays of any size", () => {
  test.each<readonly [string, string]>([
    ["Array.from over an object with a length", "Array.from({ length: 1e9 }, () => 0)"],
    ["Array.from over a length of one", "log(Array.from({ length: 1 }))"],
    ["an object with a length", "const o = { length: 1e9 }\nlog(Array.from(o))"],
    ["a write to a length", "const a = []\na.length = 4294967295\nfor (const x of a) {}"],
    ["a write to a length by update", "const a = []\na.length++"],
    ["a write far into an array", "const a = []\na[4294967294] = 1\nfor (const x of a) {}"],
    ["a write to a member far into an array", "const a = [[]]\na[0][2000] = 1"],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    ["Array.from over an array", "log(Array.from([1, 2], (x) => x * 2), Array.from(args.entries))"],
    ["writes to low indexes", "const a = []\na[0] = 1\na[10] = 2\nlog(a.length)"],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check refuses a value used twice to build a bigger one", () => {
  test.each<readonly [string, string]>([
    [
      "a concat of the array with itself in a loop",
      "let a = [1]\nfor (let i = 0; i < 40; i++) { a = a.concat(a) }",
    ],
    [
      "a spread of the array twice",
      "let a = [1]\nfor (let i = 0; i < 40; i++) { a = [...a, ...a] }",
    ],
    [
      "a flatMap that returns each element twice",
      "let a = [1]\nfor (let i = 0; i < 40; i++) { a = a.flatMap((x) => [x, x]) }",
    ],
    [
      "a template that holds the text twice",
      "let s = 'x'\nfor (let i = 0; i < 40; i++) { s = `${s}${s}` }",
    ],
    ["a sum of the text with itself", "let s = 'x'\nfor (let i = 0; i < 40; i++) { s = s + s }"],
    ["an append of the text to itself", "let s = 'x'\nfor (let i = 0; i < 40; i++) { s += s }"],
    [
      "an object that holds the value twice",
      "let o = {}\nfor (let i = 0; i < 40; i++) { o = { left: o, right: o } }",
    ],
    [
      "a push of the array into itself",
      "const a = [1]\nfor (let i = 0; i < 40; i++) { a.push(...a) }",
    ],
    [
      "a copy that is added back",
      "let a = [1]\nfor (let i = 0; i < 40; i++) { const b = a.slice(); a = a.concat(b) }",
    ],
    [
      "a copy by spread that is added back",
      "let a = [1]\nfor (let i = 0; i < 40; i++) { const b = [...a]; a = [...a, ...b] }",
    ],
    [
      "a function that returns its argument twice",
      "const twice = (v) => [v, v]\nlet a = [1]\nfor (let i = 0; i < 40; i++) { a = twice(a) }",
    ],
    [
      "a function given the same value twice",
      "const join = (p, q) => p.concat(q)\nlet a = [1]\nfor (let i = 0; i < 40; i++) { a = join(a, a) }",
    ],
    [
      "a replacement by longer text in a loop",
      "let s = 'a'\nfor (let i = 0; i < 40; i++) { s = s.replaceAll('a', 'aaaa') }",
    ],
    [
      "a replacement by longer text in a function",
      "const grow = (s) => { let t = s; t = t.replace('a', 'aa'); return t }\nlog(grow('a'))",
    ],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    [
      "a pair of an id and its entry",
      "log(Object.fromEntries(args.entries.map((e) => [e.id, e])))",
    ],
    [
      "an object of two fields of one value",
      "const entry = args.entries[0]\nlog({ id: entry.id, prompt: entry.prompt })",
    ],
    [
      "a template of two fields of one value",
      "const e = args.entries[0]\nlog(`${e.id}: ${e.prompt}`)",
    ],
    [
      "a concat of another array",
      "let a = [1]\nfor (let i = 0; i < 10; i++) { a = a.concat([i]) }",
    ],
    [
      "two values mapped from the same data",
      "const ids = args.entries.map((e) => e.id)\nconst texts = args.entries.map((e) => e.prompt)\nlog({ ids, texts })",
    ],
    ["a running total", "let total = 0\nfor (let i = 0; i < 5; i++) { total += i }\nlog(total)"],
    [
      "a replacement by shorter text",
      "let s = 'aaaa'\nfor (let i = 0; i < 3; i++) { s = s.replaceAll('aa', 'b') }",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check refuses a for-of loop that adds to what it walks", () => {
  test.each<readonly [string, string]>([
    ["a sorted copy walked", "const a = [1]\nfor (const x of a.sort()) { a.push(x) }"],
    ["a reversed copy walked", "const a = [1]\nfor (const x of a.reverse()) { a.push(x) }"],
    ["a default walked", "const a = [1]\nfor (const x of a ?? []) { a.push(x) }"],
    ["a choice walked", "const a = [1]\nfor (const x of args.on ? a : []) { a.push(x) }"],
    ["an alias walked", "const a = [1]\nconst b = a\nfor (const x of b) { a.push(x) }"],
    ["an alias grown", "const a = [1]\nconst b = a\nfor (const x of a) { b.push(x) }"],
    ["a later alias", "const a = [1]\nlet b = []\nb = a\nfor (const x of a) { b.push(x) }"],
    [
      "a copy by slice walked",
      "const a = [1]\nconst b = a.slice()\nfor (const x of b) { b.unshift(x) }",
    ],
    ["a receiver that is a call", "const a = [1]\nfor (const x of a) { a.slice().push(x) }"],
    [
      "a receiver that is a choice",
      "const a = [1]\nconst b = [2]\nfor (const x of a) { (args.on ? a : b).push(x) }",
    ],
    ["a splice", "const a = [1]\nfor (const x of a) { a.splice(0, 0, x) }"],
    [
      "a helper that grows it",
      "const a = [1]\nfunction grow(x) { a.push(x) }\nfor (const x of a) { grow(x) }",
    ],
    [
      "a helper that grows it through another",
      "const a = [1]\nfunction grow(x) { a.push(x) }\nfunction more(x) { grow(x) }\nfor (const x of a) { more(x) }",
    ],
    [
      "a helper that grows its argument",
      "const a = [1]\nfunction add(list, x) { list.push(x) }\nfor (const x of a) { add(a, x) }",
    ],
    [
      "a walk of what a function returns",
      "const a = [1]\nconst get = () => a\nfor (const x of get()) { a.push(x) }",
    ],
    [
      "a parameter walked and grown",
      "const f = (list) => { for (const x of list) { list.push(x) } }\nf([1])",
    ],
    [
      "two parameters that may be one array",
      "const f = (list, other) => { for (const x of list) { other.push(x) } }\nconst a = [1]\nf(a, a)",
    ],
    [
      "a growth in a callback",
      "const a = [1]\nfor (const x of a) { [1].forEach(() => a.push(x)) }",
    ],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    ["a fill of another array", "const out = []\nfor (const e of args.entries) { out.push(e) }"],
    [
      "a fill of a field of another object",
      "const state = { seen: [] }\nfor (const e of args.entries) { state.seen.push(e) }",
    ],
    [
      "a fill from a nested walk",
      "const out = []\nfor (const row of args.rows) { for (const cell of row) { out.push(cell) } }",
    ],
    [
      "a helper that grows another array",
      "const out = []\nfunction add(x) { out.push(x) }\nfor (const e of args.entries) { add(e) }",
    ],
    [
      "a copy that is walked and another grown",
      "const names = args.entries.slice()\nconst out = []\nfor (const e of names) { out.push(e) }",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check counts every pass over data", () => {
  test.each<readonly [string, string]>([
    [
      "four nested for-of loops over text",
      "const cs = 'x'.repeat(1000).split('')\nfor (const a of cs) { for (const b of cs) { for (const c of cs) { for (const d of cs) { log(d) } } } }",
    ],
    [
      "three nested for-of loops",
      "const cs = args.entries\nfor (const a of cs) { for (const b of cs) { for (const c of cs) { log(c) } } }",
    ],
    [
      "nested for-in loops",
      "for (const a in args) { for (const b in args) { for (const c in args) { log(c) } } }",
    ],
    [
      "nested callbacks",
      "const cs = args.entries\ncs.map((a) => cs.map((b) => cs.map((c) => cs.forEach((d) => log(d)))))",
    ],
    [
      "a callback in a for-of in a callback",
      "const cs = args.entries\ncs.map((a) => { for (const b of cs) { cs.forEach((c) => log(c)) } })",
    ],
    [
      "a counted loop around two passes",
      "const cs = args.entries\nfor (let i = 0; i < 10; i++) { for (const a of cs) { cs.forEach((b) => log(b)) } }",
    ],
    [
      "a pipeline stage that passes over data twice",
      "await pipeline(args.entries, (e) => args.entries.map((a) => args.entries.map((b) => b)))",
    ],
    [
      "a loop in a function called from a loop",
      "function inner() { for (let j = 0; j < 1000; j++) { log(j) } }\nfor (let i = 0; i < 1000; i++) { inner() }",
    ],
    [
      "a chain of functions that each loop",
      "function c() { for (let k = 0; k < 100; k++) { log(k) } }\nfunction b() { for (let j = 0; j < 100; j++) { c() } }\nfunction a() { for (let i = 0; i < 100; i++) { b() } }\na()",
    ],
    [
      "a function that passes over data called from a pass over data",
      "const cs = args.entries\nfunction inner() { for (const a of cs) { cs.map((b) => b) } }\nfor (const c of cs) { inner() }",
    ],
    ["a repeat of a repeat", "log('x'.repeat(1000).repeat(500))"],
    ["a repeat of a long literal", "log('0123456789'.repeat(1000))"],
    ["a repeat of a name", "const s = 'x'\nlog(s.repeat(10))"],
    ["a repeat of data", "log(args.text.repeat(10))"],
    [
      "a repeat in a loop of the text it builds",
      "let s = 'x'\nfor (let i = 0; i < 40; i++) { s = s.repeat(2) }",
    ],
    ["a repeat with no receiver literal and no count", "log(args.text.repeat())"],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    ["two nested passes", "const cs = args.entries\ncs.map((a) => cs.map((b) => b))"],
    [
      "a for-of in a callback",
      "args.entries.forEach((a) => { for (const b of a.items) { log(b) } })",
    ],
    [
      "a counted loop around a pass",
      "for (let i = 0; i < 100; i++) { args.entries.forEach((a) => log(a)) }",
    ],
    [
      "a function that loops, called from a short loop",
      "function inner() { for (let j = 0; j < 100; j++) { log(j) } }\nfor (let i = 0; i < 10; i++) { inner() }",
    ],
    ["a repeat of a short literal", "log('=-'.repeat(500), '-'.repeat(60))"],
    [
      "pipeline stages that map over data",
      "await pipeline(args.entries, (e) => e.items.map((i) => i), (r) => r)",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check refuses a promise that may never settle", () => {
  test.each<readonly [string, string]>([
    ["a race of nothing", "await Promise.race([])"],
    [
      "a race of what may be nothing",
      "await Promise.race(args.entries.map((e) => agent(e, { agentType: 'holyagent:explorer-map' })))",
    ],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test("allows the other statics a workflow needs", async () => {
    expect(
      await refusal("await Promise.all([Promise.resolve(1)])\nawait Promise.allSettled([])"),
    ).toBeUndefined()
  })
})

describe("the workflow check lets the scripts the root writes run", () => {
  test("a pipeline of writers and reviewers over Assignment ids", async () => {
    expect(
      await refusalOf(
        [
          META,
          "const results = await pipeline(",
          "  args.entries,",
          '  (entry) => agent(`Do ${entry.id}: ${entry.prompt}`, { agentType: "holyagent:worker-implementation", model: entry.model, effort: entry.effort, label: entry.id, phase: "Write" }),',
          "  (report, entry) => agent('Review ' + entry.id + ': ' + report, { label: entry.id, agentType: 'holyagent:reviewer-code', model: 'opus', effort: 'high' }).then((review) => ({ id: entry.id, report, review })),",
          ")",
          "return { done: results.filter((result) => result !== undefined).map((result) => result.id) }",
        ].join("\n"),
      ),
    ).toBeUndefined()
  })

  test("Assignment ids mapped to agent calls, in parallel and in sequence", async () => {
    expect(
      await refusalOf(
        [
          META,
          "const ids = ['assignment-aaa', 'assignment-bbb', 'assignment-ccc']",
          "phase('Write')",
          "const written = await parallel(ids.map((id) => () => agent(args.prompts[0] + id, { agentType: 'holyagent:worker-implementation', model: 'sonnet', effort: 'high', label: id })))",
          "phase('Review')",
          "const reviewed = await Promise.all(ids.map((id) => agent('Review ' + id, { agentType: 'holyagent:reviewer-code', model: 'opus', effort: 'high', label: id })))",
          "const done = []",
          "for (const id of ids) { done.push(id) }",
          "log(`${written.length} written, ${reviewed.length} reviewed`)",
          "return { done }",
        ].join("\n"),
      ),
    ).toBeUndefined()
  })

  test("a helper that starts an agent, a pipeline stage and a sequence of phases", async () => {
    expect(
      await refusalOf(
        [
          META,
          "const start = (id, prompt) => agent(prompt, { agentType: 'holyagent:worker-implementation', model: 'sonnet', effort: 'high', label: id })",
          "const results = []",
          "for (const entry of args.entries) {",
          "  results.push(await start(entry.id, entry.prompt))",
          "}",
          "const [first, ...others] = results",
          "const checked = await pipeline(others, async (report, at) => {",
          "  const text = String(report ?? '').trim()",
          "  if (text === '') return null",
          "  return await agent(text, { agentType: 'holyagent:reviewer-code', model: 'sonnet', effort: 'high' })",
          "})",
          "return { done: args.entries.map((entry) => entry.id), first, checked, n: Math.max(1, others.length) }",
        ].join("\n"),
      ),
    ).toBeUndefined()
  })
})
