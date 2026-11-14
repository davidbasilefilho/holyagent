import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { literalWorkflowName, workflowRefusal } from "../src/cli/workflow-check.ts"

const META = 'export const meta = { name: "w", description: "d" }'
const AGENT = "await agent('p', { agentType: 'holyagent:worker-implementation' })"

/** The refusal of a script made of the lines, with a vetted agent() call and the meta. */
const refusal = (...lines: ReadonlyArray<string>) =>
  Effect.runPromise(workflowRefusal([META, ...lines, AGENT].join("\n")))

/** The refusal of a script as it stands. */
const refusalOf = (script: string) => Effect.runPromise(workflowRefusal(script))

test("both Pi workflow instruction examples pass the literal specialist validator", async () => {
  for (const family of ["gpt-6", "kimi-k3.1"]) {
    const text = await Bun.file(
      `packages/runtime/src/instructions/${family}/root/workflows.md`,
    ).text()
    const script = /```js\n([\s\S]*?)\n```/.exec(text)?.[1]
    expect(script).toBeDefined()
    expect(
      await Effect.runPromise(
        workflowRefusal(script ?? "", new Set(["worker-implementation"]), "pi"),
      ),
    ).toBeUndefined()
  }
})

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

describe("the workflow check separates a value used twice from a value that grows", () => {
  const ASSIGNMENT = "assignment-0mw2000aa-test"
  const call = (prompt: string, type: string) =>
    `  () => agent(${prompt}, { agentType: "holyagent:${type}", model: "sonnet", effort: "high", label: "${ASSIGNMENT}" }).then(() => done.push("${ASSIGNMENT}")),`
  /** A script as the root writes it: a prompt builder that names its argument twice, then agents. */
  const rootScript = (builder: string, calls: ReadonlyArray<string>) =>
    [META, builder, "const done = []", "await parallel([", ...calls, "])", "return { done }"].join(
      "\n",
    )
  const ONE =
    'const p = (id) => "Assignment: " + id + ".\\nRead the brief at /briefs/" + id + ".md now."'
  const TWO =
    'const p = (role, id) => "Role: " + role + ". Assignment: " + id + ".\\nRead the brief at /briefs/" + id + ".md now."'
  const worker = (prompt: string) => call(prompt, "worker-implementation")
  const reviewer = (prompt: string) => call(prompt, "reviewer-code")

  // The shapes of the scripts the root writes: a builder that names its argument in the text twice,
  // called once for each Assignment, and a push that records which agent finished.
  test.each<readonly [string, string]>([
    ["one builder argument, one agent", rootScript(ONE, [worker(`p("${ASSIGNMENT}")`)])],
    [
      "one builder argument, two agents",
      rootScript(ONE, [worker('p("assignment-a")'), worker('p("assignment-b")')]),
    ],
    [
      "a role and an id, two agents",
      rootScript(TWO, [
        reviewer('p("Reviewer.code", "assignment-a")'),
        reviewer('p("Reviewer.code", "assignment-b")'),
      ]),
    ],
    [
      "a role and an id, four agents",
      rootScript(TWO, [
        worker('p("Worker.implementation", "assignment-a")'),
        worker('p("Worker.implementation", "assignment-b")'),
        reviewer('p("Reviewer.code", "assignment-c")'),
        reviewer('p("Reviewer.code", "assignment-d")'),
      ]),
    ],
    [
      "a role and an id, five agents",
      rootScript(TWO, [
        worker('p("Worker.operations", "assignment-a")'),
        reviewer('p("Reviewer.code", "assignment-b")'),
        reviewer('p("Reviewer.code", "assignment-c")'),
        reviewer('p("Reviewer.code", "assignment-d")'),
        reviewer('p("Reviewer.code", "assignment-e")'),
      ]),
    ],
    [
      "a builder called for each id of a list",
      [
        META,
        ONE,
        'const ids = ["assignment-a", "assignment-b"]',
        "const done = []",
        "await parallel(ids.map((id) => () => agent(p(id), { agentType: 'holyagent:worker-implementation', label: id }).then(() => done.push(id))))",
        "return { done }",
      ].join("\n"),
    ],
    [
      "an argument used three times in one expression",
      "const t = (id) => id + ': ' + id + ' / ' + id\nawait agent(t('a'), { agentType: 'holyagent:worker-implementation' })",
    ],
    [
      "two builder results joined",
      `${ONE}\nawait agent(p('a') + p('b'), { agentType: 'holyagent:worker-implementation' })`,
    ],
    [
      "a doubled text used once",
      "const id = args.id\nconst text = id + id\nawait agent(text, { agentType: 'holyagent:worker-implementation' })",
    ],
  ])("allows %s", async (_label, script) => {
    expect(await refusalOf(script)).toBeUndefined()
  })

  // A value built by doubling that is doubled again grows by a factor each time, however the
  // doublings are arranged: in a chain of statements, nested in one expression, handed through a
  // function or a callback, or fed back around a loop through another name.
  test.each<readonly [string, string]>([
    ["a chain of sums", "const a = args.id\nconst b = a + a\nconst c = b + b\nconst d = c + c"],
    ["a chain of arrays", "const a = [1]\nconst b = [a, a]\nconst c = [b, b]"],
    ["a chain of spreads", "const a = [1]\nconst b = [...a, ...a]\nconst c = [...b, ...b]"],
    ["a chain of templates", "const a = 'x'\nconst b = `${a}${a}`\nconst c = `${b}${b}`"],
    ["a sum assigned twice", "let s = 'x'\ns += s\ns += s"],
    [
      "a doubled value copied, then doubled",
      "const a = 'x'\nconst b = a + a\nconst c = b\nlog(c + c)",
    ],
    ["a doubling inside a doubling", "const a = args.id\nconst b = a + a + a + a\nlog(b + b)"],
    [
      "a builder applied to its own result",
      "const d = (v) => v + v\nconst x = d('a')\nconst y = d(x)",
    ],
    ["a builder nested in itself", "const d = (v) => v + v\nlog(d(d(d('a'))))"],
    [
      "a function that hands back a grown value",
      "const a = args.id\nconst t = a + a\nconst g = () => t\nconst u = g()\nlog(u + u)",
    ],
    [
      "a callback that doubles the result of a callback that doubles",
      "const a = ['x']\nconst b = a.map((x) => x + x)\nconst c = b.map((x) => x + x)",
    ],
    [
      "a loop that doubles through a second name",
      "let a = 'x'\nlet b = 'y'\nfor (let i = 0; i < 40; i++) { a = a + b; b = a + a }",
    ],
    [
      "a loop that doubles what it walks into a new array",
      "let a = ['x']\nfor (let i = 0; i < 40; i++) { const b = []\nfor (const x of a) { b.push(x, x) }\na = b }",
    ],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })
})

describe("the workflow check refuses a value doubled by a callback", () => {
  test.each<readonly [string, string]>([
    ["a reduce that doubles text", "log(args.items.reduce((s) => s + s, 'a'))"],
    [
      "a reduce that concats the accumulator with itself",
      "log(args.items.reduce((acc) => acc.concat(acc), ['a']))",
    ],
    [
      "a reduce that spreads the accumulator twice",
      "log(args.items.reduce((a) => ({ ...a, ...a }), {}))",
    ],
    [
      "a reduce with a block body and more parameters",
      "log(args.items.reduce((a, x) => { return [...a, ...a, x] }, []))",
    ],
    [
      "a reduce with a function expression",
      "log(args.items.reduce(function (a) { return [...a, ...a] }, []))",
    ],
    [
      "a map in a loop that doubles each element",
      "let a = [[1]]\nfor (let i = 0; i < 40; i++) { a = a.map((v) => [...v, ...v]) }",
    ],
    [
      "a map in a loop that holds each element twice",
      "let a = [{}]\nfor (let i = 0; i < 40; i++) { a = a.map((v) => ({ left: v, right: v })) }",
    ],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    ["a reduce that sums fields", "log(args.items.reduce((s, x) => s + x.id + ',', ''))"],
    ["a reduce that uses the item twice", "log(args.items.reduce((s, x) => s + x + x, ''))"],
    ["a reduce that appends", "log(args.items.reduce((acc, x) => acc.concat([x]), []))"],
    ["a map that pairs each element with itself", "log(args.items.map((x) => [x, x]))"],
    [
      "a map of a copy that pairs each element with itself",
      "const a = args.items.slice()\nconst pairs = a.map((x) => ({ id: x, again: x }))\nlog(pairs)",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check refuses doubling split over statements", () => {
  test.each<readonly [string, string]>([
    [
      "two pushes of an array into one that is assigned back",
      "let a = [1]\nfor (let i = 0; i < 40; i++) { const p = []\np.push(...a)\np.push(...a)\na = p.map((x) => x) }",
    ],
    [
      "two pushes into an array declared outside the loop",
      "let a = [1]\nconst p = []\nfor (let i = 0; i < 40; i++) { p.push(...a)\np.push(...a)\na = p.map((x) => x) }",
    ],
    [
      "two writes of an object into the fields of another",
      "let a = {}\nfor (let i = 0; i < 40; i++) { const o = {}\no.x = a\no.y = a\na = o }",
    ],
    [
      "two writes of an array into the indexes of another",
      "let a = [1]\nfor (let i = 0; i < 40; i++) { const p = []\np[0] = a\np[1] = a\na = p }",
    ],
    [
      "two appends of the text to another",
      "let a = 'x'\nfor (let i = 0; i < 40; i++) { let t = ''\nt += a\nt += a\na = t.trim() }",
    ],
    [
      "two sums of the text with another",
      "let a = 'x'\nfor (let i = 0; i < 40; i++) { let t = ''\nt = t + a\nt = t + a\na = t.trim() }",
    ],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    [
      "two pushes of different fields of one entry",
      "const out = []\nfor (const e of args.entries) { out.push(e.id)\nout.push(e.prompt) }",
    ],
    [
      "two pushes of one value that is not fed back",
      "const out = []\nconst id = args.id\nout.push(id)\nout.push(id)\nlog(out)",
    ],
    [
      "two writes of fields of one entry",
      "const e = args.entries[0]\nconst o = {}\no.id = e.id\no.prompt = e.prompt\nlog(o)",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check refuses text that grows by replacement or joining", () => {
  test.each<readonly [string, string]>([
    [
      "a split into characters joined with a separator",
      "let s = 'abc'\nfor (let i = 0; i < 40; i++) { s = s.split('').join('--') }",
    ],
    [
      "a split on a word joined with a longer one",
      "let s = 'a b'\nfor (let i = 0; i < 40; i++) { s = s.split(' ').join('--') }",
    ],
    [
      "a split joined with the default comma",
      "let s = 'a b'\nfor (let i = 0; i < 40; i++) { s = s.split('').join() }",
    ],
    [
      "a replacement that pastes the match twice",
      "let s = 'abcd'\nfor (let i = 0; i < 40; i++) { s = s.replaceAll('abcd', '$&$&') }",
    ],
    [
      "a replacement with a dollar in a template",
      "let s = 'abcd'\nfor (let i = 0; i < 40; i++) { s = s.replaceAll('abcd', `$&$&`) }",
    ],
    [
      "a template replacement that is longer",
      "let s = 'a'\nfor (let i = 0; i < 40; i++) { s = s.replaceAll('a', `bb`) }",
    ],
    [
      "a longer replacement kept in a temporary",
      "let s = 'abcd'\nfor (let i = 0; i < 40; i++) { const t = s.replaceAll('abcd', '$&$&'); s = t }",
    ],
    [
      "a longer replacement held in a name",
      "let s = 'a'\nconst r = 'aa'\nfor (let i = 0; i < 40; i++) { s = s.replaceAll('a', r) }",
    ],
    [
      "a longer replacement held in a name, in a function",
      "const r = 'aa'\nconst g = (s) => s.replaceAll('a', r)\nlet s = 'a'\nfor (let i = 0; i < 40; i++) { s = g(s) }",
    ],
    [
      "a pattern and a replacement held in names, through a temporary",
      "let s = 'a'\nconst p = 'a'\nconst r = 'aa'\nfor (let i = 0; i < 40; i++) { const t = s.replaceAll(p, r); s = t }",
    ],
    [
      "a join of the text with itself",
      "let s = 'aa'\nfor (let i = 0; i < 40; i++) { s = s.split('a').join(s) }",
    ],
    [
      "a longer separator kept in a temporary",
      "let s = 'a'\nfor (let i = 0; i < 40; i++) { const t = s.split('').join('--'); s = t }",
    ],
    [
      "a join of a split kept in a name",
      "let s = 'abc'\nfor (let i = 0; i < 40; i++) { const p = s.split(''); s = p.join('--') }",
    ],
    [
      "a join of a spread into characters",
      "let s = 'abc'\nfor (let i = 0; i < 40; i++) { s = [...s].join('--') }",
    ],
    [
      "a join of Array.from into characters",
      "let s = 'abc'\nfor (let i = 0; i < 40; i++) { s = Array.from(s).join('--') }",
    ],
    [
      "a join of a spread kept in a name",
      "let s = 'abc'\nfor (let i = 0; i < 40; i++) { const cs = [...s]; s = cs.join('--') }",
    ],
    [
      "a longer replacement in one branch of a conditional",
      "let s = 'a'\nconst r = args.long ? 'aa' : 'a'\nfor (let i = 0; i < 40; i++) { s = s.replaceAll('a', r) }",
    ],
    [
      "a longer replacement in a conditional written in place",
      "let s = 'a'\nfor (let i = 0; i < 40; i++) { s = s.replaceAll('a', args.long ? 'aa' : 'a') }",
    ],
    [
      "a replacement that is a parameter given a literal",
      "const g = (s, r) => s.replaceAll('a', r)\nlet s = 'a'\nfor (let i = 0; i < 40; i++) { s = g(s, 'bb') }",
    ],
    [
      "a replacement taken from a list written in the script",
      "const names = ['a', 'bb']\nlet s = 'a'\nfor (const n of names) { s = s.replaceAll('a', n) }",
    ],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    [
      "a split and join with the same separator",
      "let s = 'a b'\nfor (let i = 0; i < 3; i++) { s = s.split(' ').join(' ') }",
    ],
    ["a join of mapped ids", "log(args.items.map((x) => x.id).join(', '))"],
    [
      "a replacement without a dollar of the same length",
      "let s = 'abcd'\nfor (let i = 0; i < 3; i++) { s = s.replaceAll('abcd', 'wxyz') }",
    ],
    [
      "a longer replacement of text that does not come from the result",
      "const r = 'aa'\nlet s = ''\nfor (const x of args.items) { s = x.name.replaceAll('a', r) }\nlog(s)",
    ],
    [
      "a longer replacement kept apart from the text it replaces in",
      "const out = []\nfor (const x of args.items) { const t = x.name.replaceAll('a', 'bb'); out.push(t) }\nlog(out)",
    ],
    ["a longer replacement done once", "const t = 'abcd'.replaceAll('abcd', '$&$&')\nlog(t)"],
    ["a join of the text with a separator", "log(args.items.join(args.separator))"],
    ["a single replace outside any loop", "let s = 'abc'\ns = s.replace('a', 'xyz')\nlog(s)"],
    [
      "a join of lines with a newline",
      "let out = ''\nfor (const x of args.items) { const lines = [out, x.name]; out = lines.join('\\n') }\nlog(out)",
    ],
    [
      "a join of the lines of the result with the same newline",
      "let out = 'a\\nb'\nfor (let i = 0; i < 3; i++) { const lines = out.split('\\n'); out = lines.join('\\n') }\nlog(out)",
    ],
    [
      "a join of a spread of lines",
      "const lines = args.items.map((x) => x.name)\nlet out = ''\nfor (let i = 0; i < 3; i++) { out = [...lines].join('\\n') }\nlog(out)",
    ],
    [
      "a replacement of the conditional with the same length",
      "let s = 'a'\nconst r = args.upper ? 'A' : 'b'\nfor (let i = 0; i < 3; i++) { s = s.replaceAll('a', r) }",
    ],
    [
      "a replacement that is a parameter given text from args",
      "const g = (s, r) => s.replaceAll('a', r)\nlet s = 'a'\nfor (let i = 0; i < 3; i++) { s = g(s, args.mark) }",
    ],
    [
      "a replacement that is a field of an item of args",
      "log(args.items.map((x) => x.name.replace('{a}', x.alias)))",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check follows an alias made with map or Array.from", () => {
  test.each<readonly [string, string]>([
    [
      "two maps of one array joined again",
      "let a = [1]\nfor (let i = 0; i < 40; i++) { const b = a.map((x) => x); const c = a.map((x) => x); a = [...b, ...c] }",
    ],
    [
      "two Array.from copies of one array joined again",
      "let a = [1]\nfor (let i = 0; i < 40; i++) { const b = Array.from(a); const c = Array.from(a); a = [...b, ...c] }",
    ],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    ["an array copied by Array.from from args", "log(Array.from(args.items))"],
    [
      "mapped names looped over",
      "const names = args.items.map((x) => x.name)\nconst out = []\nfor (const n of names) { out.push(n.toUpperCase()) }\nlog(out)",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check lets Array.from take only an array", () => {
  test.each<readonly [string, string]>([
    ["parsed text", "log(Array.from(JSON.parse('{\"length\":100000000}'), (x, i) => i))"],
    ["a parameter", "const f = (list) => Array.from(list)\nlog(f([1]))"],
    ["an object built here", "const o = { length: 5 }\nlog(Array.from(o))"],
    ["a name set from parsed text", "const o = JSON.parse('{}')\nlog(Array.from(o))"],
    [
      "a name set from an array and parsed text",
      "let o = [1]\no = JSON.parse('{}')\nlog(Array.from(o))",
    ],
    ["the args object", "log(Array.from(args))"],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    ["an array literal", "log(Array.from([1, 2], (x) => x * 2))"],
    ["a field of args", "log(Array.from(args.items))"],
    ["the keys of an object", "log(Array.from(Object.keys(args)))"],
    ["the result of an array method", "log(Array.from(args.items.map((x) => x.id)))"],
    ["a declared array", "const list = [1, 2]\nlog(Array.from(list))"],
    [
      "the settled results of agents",
      "const r = await Promise.all([agent('p', { agentType: 'holyagent:explorer-map' })])\nlog(Array.from(r))",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check refuses a for-of loop that grows what may alias it", () => {
  test.each<readonly [string, string]>([
    [
      "a destructured container",
      "const a = [1]\nconst [b] = [a]\nfor (const x of a) { b.push(x) }",
    ],
    [
      "an element of a container",
      "const a = [1]\nconst b = [a][0]\nfor (const x of a) { b.push(x) }",
    ],
    [
      "a field of a container",
      "const a = [1]\nconst o = { b: a }\nfor (const x of a) { o.b.push(x) }",
    ],
    [
      "an awaited promise",
      "const a = [1]\nconst b = await Promise.resolve(a)\nfor (const x of a) { b.push(x) }",
    ],
    [
      "a field the array was stored in",
      "const s = {}\nconst a = [1]\ns.k = a\nfor (const x of a) { s.k.push(x) }",
    ],
    [
      "an element the array was pushed into",
      "const rows = []\nconst a = [[1]]\nrows.push(a)\nfor (const x of a) { rows[0].push(x) }",
    ],
    [
      "a name a loop sets",
      "let b = []\nconst a = [1]\nfor (b of [a]) {}\nfor (const x of a) { b.push(x) }",
    ],
    [
      "a function that grows a container",
      "const a = [1]\nconst o = { b: a }\nfunction g() { o.b.push(1) }\nfor (const x of a) { g() }",
    ],
  ])("refuses %s", async (_label, text) => {
    expect(await refusal(text)).toBeString()
  })

  test.each<readonly [string, string]>([
    [
      "an array made in the body",
      "for (const e of args.entries) { const parts = []\nparts.push(e.id)\nlog(parts) }",
    ],
    [
      "a field of an object of literals",
      "const state = { seen: [] }\nfor (const e of args.entries) { state.seen.push(e) }",
    ],
  ])("allows %s", async (_label, text) => {
    expect(await refusal(text)).toBeUndefined()
  })
})

describe("the workflow check adds up what calls cost", () => {
  /** A chain of functions of which each calls the one before it twice. */
  const chain = (length: number) =>
    [
      "const f0 = () => 1",
      ...Array.from({ length }, (_, at) => `const f${at + 1} = () => { f${at}()\nf${at}() }`),
      `f${length}()`,
    ].join("\n")

  test("refuses a chain whose calls multiply past the total", async () => {
    expect(await refusal(chain(15))).toBeString()
  })

  test("allows a short chain and a function called a few times", async () => {
    expect(await refusal(chain(3))).toBeUndefined()
    expect(
      await refusal("const f = (n) => n + 1\nlog(f(1), f(2), f(3), f(4), f(5))"),
    ).toBeUndefined()
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

describe("the Pi mode checks the meta fragment and the program the package runs", () => {
  // The package evaluates a fragment cut from the source by pattern, on the host thread, where
  // `this.constructor.constructor` reaches `process`, and compiles the script as a classic script.
  const SPECIALISTS = new Set(["worker-implementation"])
  const PI_AGENT = "await agent('p', { agentType: 'worker-implementation' })"
  const PAYLOAD = '{ description: this.constructor.constructor("return process")() }'
  const OBJECT = '{ name: "a", description: "d" }'

  const piRefusal = (script: string) =>
    Effect.runPromise(workflowRefusal(script, SPECIALISTS, "pi"))
  /** The refusal of a script made of the lines under the Pi mode, with meta and a vetted agent(). */
  const piLines = (...lines: ReadonlyArray<string>) =>
    piRefusal([META, ...lines, PI_AGENT].join("\n"))

  test.each<readonly [string, string]>([
    ["a block comment", `export const meta = /* ${PAYLOAD} */ ${OBJECT}`],
    ["a line comment", `export const meta = // ${PAYLOAD}\n${OBJECT}`],
    ["a block comment with a nested brace", `export const meta = /* { { */ ${PAYLOAD}`],
  ])("refuses the meta fragment the package cuts from %s", async (_label, line) => {
    expect(await piRefusal(`${line}\n${PI_AGENT}`)).toContain("`meta`")
  })

  test.each<readonly [string, string]>([
    ["a call", '{ name: "a", description: String(1) }'],
    ["a getter", '{ name: "a", get description() { return "d" } }'],
    ["a computed key", '{ name: "a", ["description"]: "d" }'],
    ["a shorthand name", '{ name, description: "d" }'],
    ["a spread", '{ ...other, name: "a" }'],
    ["a template with an expression", "{ name: `a${1}`, description: 'd' }"],
    ["an identifier", '{ name: "a", description: Object }'],
    ["a regex", '{ name: "a", description: /x/ }'],
    ["an arrow function", '{ name: "a", description: () => 1 }'],
  ])("refuses a meta that holds %s", async (_label, object) => {
    expect(await piRefusal(`export const meta = ${object}\n${PI_AGENT}`)).toContain("`meta`")
  })

  test("refuses a script whose meta line is missing or repeated", async () => {
    expect(await piRefusal(PI_AGENT)).toContain("export const meta")
    expect(await piRefusal(`/*\n${META}\n*/\n${META}\n${PI_AGENT}`)).toContain("more than one")
  })

  test("allows a meta of literals, wherever the comments around it stand", async () => {
    expect(await piRefusal(`${META}\n${PI_AGENT}`)).toBeUndefined()
    expect(
      await piRefusal(
        `export const meta = /* the meta */ { name: "a", "description": 'd', n: 1, ok: true, none: null, phases: [{ title: "t", detail: "a}b" }] }\n${PI_AGENT}`,
      ),
    ).toBeUndefined()
    expect(
      await piRefusal(`export const meta = // the meta\n${OBJECT}\n${PI_AGENT}`),
    ).toBeUndefined()
    // The line is the package's meta wherever it stands; what it evaluates is the vetted literal.
    expect(await piRefusal(`const text = \`\n${META}\n\`\n${PI_AGENT}`)).toBeUndefined()
  })

  test("reads the script as a classic script, so an HTML-like comment hides what it hides", async () => {
    // In a classic script `<!--` and a line-leading `-->` start a comment; the function declared on
    // the commented line does not exist, so `workflow` is a global of the worker, not of the script.
    expect(
      await piLines(
        "let n = 0",
        "n <!--n; function workflow() { return 1 }",
        'await workflow({ scriptPath: "x.js" })',
      ),
    ).toContain("workflow")
    expect(
      await piLines(
        "--> function workflow() { return 1 }",
        'await workflow({ scriptPath: "x.js" })',
      ),
    ).toContain("workflow")
  })

  test.each<readonly [string, string]>([
    ["a block", "{ function f() { return 2 } }\nlog(f())"],
    ["an if", "const ok = true\nif (ok) { function g() { return 2 } }\nlog(1)"],
    ["a loop body", "for (let i = 0; i < 2; i++) { function h() { return i } }"],
    ["a case", "switch (1) { case 1: function k() { return 1 } }"],
    ["a try block", "try { function t() { return 1 } } catch (e) { log(e) }"],
  ])(
    "refuses a function declared in %s, which a classic script hoists out of it",
    async (_l, text) => {
      expect(await piLines(text)).toContain("declares a function inside a block")
    },
  )

  test("allows functions declared at the top of the script and of a function", async () => {
    expect(
      await piLines(
        "function one(n) { return n + 1 }",
        "function two(n) { function inner(m) { return one(m) }\nreturn inner(n) }",
        "log(two(1))",
      ),
    ).toBeUndefined()
  })

  test("refuses a script that closes the wrapper the package puts around it", async () => {
    expect(await piLines("})", "log(1)", ";(async () => {")).toContain("wrapper")
  })

  test("applies the rules of the Claude check to the program, with bare names", async () => {
    expect(
      await piRefusal(
        `${META}\nawait agent('p', { agentType: 'holyagent:worker-implementation' })`,
      ),
    ).toBeString()
    expect(await piRefusal(`${META}\nawait agent('p', { agentType: 'other' })`)).toBeString()
    expect(await piRefusal(`${META}\nlog(1)`)).toContain("starts no agent")
    expect(await piRefusal(`${META}\nawait Date.now()\n${PI_AGENT}`)).toBeString()
  })
})

describe("HTML-like text in a string is plain under both hosts", () => {
  // `<!--` and `-->` inside a string or template are data in a module and in a classic script alike.
  const claude = (...lines: ReadonlyArray<string>) => refusal(...lines)
  const pi = (...lines: ReadonlyArray<string>) =>
    Effect.runPromise(
      workflowRefusal(
        [META, ...lines, "await agent('p', { agentType: 'worker-implementation' })"].join("\n"),
        new Set(["worker-implementation"]),
        "pi",
      ),
    )

  test.each<readonly [string, string]>([
    ["`-->` in a template", "log(`a --> b`)"],
    ["`<!--` in a string", "log('a <!-- b')"],
    ["both in a double-quoted string", 'log("<!-- a --> b")'],
    ["`-->` at the start of a template line", "log(`a\n--> b`)"],
    ["both in an agent prompt", "await agent('see <!-- and --> here', { agentType: 'AGENT' })"],
  ])("allows %s", async (_label, text) => {
    expect(await claude(text.replace("AGENT", "holyagent:worker-implementation"))).toBeUndefined()
    expect(await pi(text.replace("AGENT", "worker-implementation"))).toBeUndefined()
  })

  test("the Claude hook still reads the script as a module", async () => {
    expect(await claude("{ function f() { return 2 } }", "log(1)")).toBeUndefined()
    expect(
      await refusalOf(`export const meta = /* x */ { name: "a", description: "d" }\n${AGENT}`),
    ).toBeUndefined()
    expect(await refusalOf(`/*\n${META}\n*/\n${META}\n${AGENT}`)).toBeUndefined()
    expect(await refusalOf(AGENT)).toBeUndefined()
  })
})

describe("the literal workflow name", () => {
  test.each<readonly [string, string, string | undefined]>([
    ["a literal name", "export const meta = { name: 'w', description: 'd' }\nreturn 1", "w"],
    ["a quoted key", "export const meta = { 'name': \"q\" }", "q"],
    ["the last of two names", "export const meta = { name: 'a', name: 'b' }", "b"],
    ["a name that is no string", "export const meta = { name: 2 }", undefined],
    ["no name", "export const meta = { description: 'd' }", undefined],
    ["no meta", "return 1", undefined],
    [
      "two metas",
      "export const meta = { name: 'a' }\nexport const meta = { name: 'b' }",
      undefined,
    ],
    ["a call in the fragment", "export const meta = { name: String('a') }", undefined],
    ["a call elsewhere in the fragment", "export const meta = { name: 'a', x: f() }", undefined],
    ["a getter", "export const meta = { get name() { return 'a' } }", undefined],
    [
      "a constructor chain",
      'export const meta = { name: this.constructor.constructor("return 1")() }',
      undefined,
    ],
    ["an interpolated template", "export const meta = { name: `${x}` }", undefined],
    ["a syntax error", "export const meta = { name: ", undefined],
  ])("%s", (_label, script, expected) => {
    expect(Effect.runSync(literalWorkflowName(script))).toBe(expected)
  })
})
