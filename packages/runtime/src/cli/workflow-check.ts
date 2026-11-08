import { parse } from "acorn"
import { Effect } from "effect"

import { ROUTES } from "../domain/route.ts"

// The Workflow tool runs a script the root writes inline, and the only way that script starts an
// agent is the global `agent()`. The PreToolUse hook lets such a script run without a prompt when
// it is plain: it is parsed (acorn) and every node must be of a closed set of types, every name
// must resolve to something the script declared or to a global of the workflow, and every
// `agent()` call must name one of our specialists with a string literal. Whatever else a script
// does (a node outside the set, a name that resolves to nothing known, a computed member access,
// a parse error, a script too large or too deep) is a refusal, and a refusal only means the normal
// permission flow. A script that could hang or exhaust memory is not plain either: a loop must be a
// counted `for` over literal bounds, `repeat` repeats a short literal a small literal number of
// times and `padStart` and `padEnd` take a small literal count, no function calls itself (directly,
// through other functions or through a function value), a value is not built from itself twice
// (`[...a, ...a]`, `a.concat(a)`), an array is not given a length or a far index, and what loops,
// data iteration and calls multiply stays under a total. Nothing here runs the script.

/** A node of the syntax tree, read loosely: the walk checks every type before it reads a field. */
interface JsNode {
  readonly type: string
  readonly [field: string]: unknown
}

const isNode = (value: unknown): value is JsNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof (value as { readonly type: unknown }).type === "string"

const nodeAt = (node: JsNode, field: string): JsNode | undefined => {
  const value = node[field]
  return isNode(value) ? value : undefined
}

/** The nodes of a list field; a hole (`[, a]`) is undefined, anything else that is no node too. */
const nodesAt = (node: JsNode, field: string): ReadonlyArray<JsNode | undefined> => {
  const value = node[field]
  return Array.isArray(value)
    ? (value as ReadonlyArray<unknown>).map((item) => (isNode(item) ? item : undefined))
    : []
}

const nameOf = (node: JsNode | undefined): string | undefined =>
  node?.type === "Identifier" && typeof node["name"] === "string" ? node["name"] : undefined

/** The longest script the check reads, and the deepest nesting of the tree it walks. */
const MAX_WORKFLOW_SCRIPT = 1_000_000
const MAX_DEPTH = 120

/**
 * The most iterations one counted `for` loop may run, the most all nested counted loops may run
 * together, and the largest count `repeat`, `padStart` and `padEnd` may be given. A script that
 * needs more is refused and goes through the normal permission flow.
 */
const MAX_LOOP_COUNT = 1_000
const MAX_NESTED_ITERATIONS = 10_000
const MAX_TEXT_COUNT = 1_000

/** The longest literal `repeat` may repeat, and the highest index a script may write into an array. */
const MAX_REPEATED_TEXT = 8
const MAX_WRITE_INDEX = 1_000

/**
 * The iterations a pass over data (a for-of or for-in loop, a callback method, a pipeline stage) is
 * counted as, since its length is not known: two nested passes fit the total, three do not.
 */
const DATA_ITERATIONS = 100

/** The most steps the alias and duplicate checks take; a script that needs more is refused. */
const MAX_ANALYSIS_STEPS = 200_000

/** The string methods whose first argument is a length or a count. */
const TEXT_COUNTS: ReadonlySet<string> = new Set(["repeat", "padStart", "padEnd"])

/** The array methods that add elements to the array they are called on. */
const GROWING_METHODS: ReadonlySet<string> = new Set(["push", "unshift", "splice"])

/**
 * The methods that run a callback, and which arguments are callbacks (`all` for every argument):
 * the only calls that may be given a function value, which they run at once and do not keep.
 */
const CALLBACK_ARGUMENTS: ReadonlyMap<string, number | "all"> = new Map<string, number | "all">([
  ["map", 0],
  ["filter", 0],
  ["flatMap", 0],
  ["forEach", 0],
  ["reduce", 0],
  ["find", 0],
  ["findIndex", 0],
  ["some", 0],
  ["every", 0],
  ["sort", 0],
  ["from", 1],
  ["then", "all"],
  ["catch", "all"],
  ["finally", "all"],
])

/** The callback methods that pass over data, one call of the callback for each element. */
const ITERATING_METHODS: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "flatMap",
  "forEach",
  "reduce",
  "find",
  "findIndex",
  "some",
  "every",
  "sort",
  "from",
])

/** The methods whose result holds the elements of their receiver, a copy to the eyes of a check. */
const COPYING_METHODS: ReadonlySet<string> = new Set([
  "slice",
  "concat",
  "flat",
  "sort",
  "reverse",
  "filter",
])

/** The methods that hand back an array, whatever object they are called on. */
const ARRAY_RESULTS: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "flatMap",
  "flat",
  "slice",
  "concat",
  "sort",
  "reverse",
  "split",
])

/** The methods that put their arguments into their receiver or into the value they return. */
const COMBINING_METHODS: ReadonlySet<string> = new Set([
  "concat",
  "push",
  "unshift",
  "splice",
  "replace",
  "replaceAll",
  "join",
])

/** The globals of the workflow runtime and the plain built-ins a script may use, free. */
const GLOBALS: ReadonlySet<string> = new Set([
  "parallel",
  "pipeline",
  "phase",
  "log",
  "args",
  "budget",
  "JSON",
  "Math",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Promise",
  "Map",
  "Set",
  "Error",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "NaN",
  "Infinity",
  "undefined",
])

/** Host globals a script may not even declare under their own name, so none can look like itself. */
const HOST_GLOBALS: ReadonlySet<string> = new Set([
  "Bun",
  "Deno",
  "fetch",
  "process",
  "require",
  "module",
  "exports",
  "global",
  "globalThis",
  "self",
  "window",
  "Function",
  "eval",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "Worker",
  "WebSocket",
  "Buffer",
  "Symbol",
  "Reflect",
  "Proxy",
  "WebAssembly",
  "Date",
  "console",
  "performance",
  "structuredClone",
  "URL",
  "XMLHttpRequest",
])

/** Names that reach reflection or other code; refused as a property, a key or a declared name. */
const DENIED_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "call",
  "apply",
  "bind",
  "caller",
  "callee",
  "arguments",
  "eval",
  "getPrototypeOf",
  "setPrototypeOf",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "defineProperty",
  "defineProperties",
  "prepareStackTrace",
  "captureStackTrace",
  "stackTraceLimit",
])

/**
 * The instance methods a script may call, by name, on data it holds. Each is called directly: a
 * method read off an object and not called is refused, so none can be aliased, passed as a value or
 * given another `this`. No mutating or reflective static (`assign`, `freeze`, `defineProperty`,
 * `groupBy`, …) is among them.
 */
const CALLABLE_PROPERTIES: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "flatMap",
  "flat",
  "forEach",
  "reduce",
  "find",
  "findIndex",
  "some",
  "every",
  "includes",
  "indexOf",
  "lastIndexOf",
  "join",
  "slice",
  "splice",
  "concat",
  "push",
  "pop",
  "shift",
  "unshift",
  "sort",
  "reverse",
  "at",
  "then",
  "catch",
  "finally",
  "trim",
  "trimStart",
  "trimEnd",
  "split",
  "replace",
  "replaceAll",
  "repeat",
  "charAt",
  "substring",
  "toUpperCase",
  "toLowerCase",
  "startsWith",
  "endsWith",
  "padStart",
  "padEnd",
  "localeCompare",
  "toFixed",
  "toString",
])

/**
 * The methods of a global object a script may call; any other member of it is refused. `race` is
 * not among them: given nothing to race it never settles, and a script cannot tell that from its
 * source.
 */
const GLOBAL_CALLS: Readonly<Record<string, ReadonlySet<string>>> = {
  Object: new Set(["keys", "values", "entries", "fromEntries"]),
  Array: new Set(["isArray", "from", "of"]),
  JSON: new Set(["stringify", "parse"]),
  Math: new Set(["max", "min", "abs", "floor", "ceil", "round", "trunc", "sqrt", "pow", "sign"]),
  Number: new Set(["isInteger", "isFinite", "isNaN", "parseFloat", "parseInt"]),
  Promise: new Set(["all", "allSettled", "resolve", "reject"]),
  budget: new Set(["spent", "remaining"]),
}

/** The fields of a global object a script may read; they are numbers, never objects. */
const GLOBAL_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  Math: new Set(["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2"]),
  Number: new Set([
    "MAX_SAFE_INTEGER",
    "MIN_SAFE_INTEGER",
    "MAX_VALUE",
    "MIN_VALUE",
    "EPSILON",
    "POSITIVE_INFINITY",
    "NEGATIVE_INFINITY",
    "NaN",
  ]),
  budget: new Set(["total"]),
}

/**
 * How many arguments a method takes at most: the methods that run a callback take it alone, since a
 * second argument would be the `this` the callback runs with.
 */
const MAX_ARGUMENTS: Readonly<Record<string, number>> = {
  map: 1,
  forEach: 1,
  filter: 1,
  find: 1,
  findIndex: 1,
  some: 1,
  every: 1,
  flatMap: 1,
  from: 2,
}

/** The free globals a script may use as a plain value; any other is only called or read from. */
const VALUE_GLOBALS: ReadonlySet<string> = new Set(["args", "undefined", "NaN", "Infinity"])

/** The free globals a script may call directly. */
const GLOBAL_FUNCTIONS: ReadonlySet<string> = new Set([
  "parallel",
  "pipeline",
  "phase",
  "log",
  "String",
  "Number",
  "Boolean",
  "Error",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
])

/** The options of `agent()` a script may set. */
const AGENT_OPTIONS: ReadonlySet<string> = new Set([
  "agentType",
  "model",
  "effort",
  "label",
  "phase",
])

// Kept here, not imported from assignment.ts: the Pi extension runs this check on Node, and that
// module reads state through Bun. The Pi extension tests pin the two to the same value.
const PLUGIN_NAMESPACE = "holyagent"

/**
 * The `agentType` values of the Claude plugin's specialists, which the host knows under the plugin
 * namespace (`holyagent:worker-implementation`).
 */
export const CLAUDE_SPECIALISTS: ReadonlySet<string> = new Set(
  ROUTES.map((route) => `${PLUGIN_NAMESPACE}:${route.agent}`),
)

const UNARY: ReadonlySet<string> = new Set(["!", "-", "+", "~", "typeof", "void"])

/** What the script knows about a name it declared. */
interface Binding {
  /** True for a name that holds nothing the script built: a parameter, a loop variable, a function. */
  unsafe: boolean
  /** Every value the name is set to, as a test of whether the script built it; run after the walk. */
  readonly inits: Array<() => boolean>
  /** The functions of the script the name is bound to. */
  readonly functions: Set<JsNode>
  /** Every expression the name is set to, to follow a value through the names that alias it. */
  readonly sources: Array<{ readonly node: JsNode; readonly scope: Scope }>
  /** Every expression stored into a member of the name (`name.field = value`). */
  readonly stored: Array<{ readonly node: JsNode; readonly scope: Scope }>
}

const newBinding = (): Binding => ({
  unsafe: false,
  inits: [],
  functions: new Set(),
  sources: [],
  stored: [],
})

/** The names a scope holds, and the scope around it. */
interface Scope {
  readonly parent: Scope | undefined
  readonly names: Map<string, Binding>
  /** True for the module and a function, the scopes `var` lands in. */
  readonly isFunction: boolean
}

/** How a name is used: as a value, called, read from (`name.x`) or written to. */
type Use = "value" | "callee" | "object" | "write"

/** The work a function of the script does once, as the iterations its loops and calls multiply to. */
interface WorkContext {
  max: number
  /** The calls of script functions in it, each with the iterations around the call. */
  readonly calls: Array<Reference>
}

/** A for-of loop, the names it walks and what its body does that could lengthen what it walks. */
interface Walk {
  readonly walked: ReadonlyArray<string>
  readonly scope: Scope
  readonly sites: Array<GrowthSite>
  readonly calls: Array<Reference>
}

/** A call of `push`, `unshift` or `splice`: the names its receiver is made of, and where it stands. */
interface GrowthSite {
  readonly names: ReadonlyArray<string>
  /** True when the receiver is not a name or a field of one, so no name says what grows. */
  readonly opaque: boolean
  readonly scope: Scope
  readonly within: ReadonlyArray<JsNode>
}

/** A use of a name, resolved against the scopes once the whole script has been walked. */
interface Reference {
  readonly name: string
  readonly scope: Scope
  readonly use: Use
  /** The functions of the script the use stands in, outermost first. */
  readonly within: ReadonlyArray<JsNode>
  /** The iterations the loops and passes around the use run together. */
  readonly factor: number
  /** Where the name stands in the script, to tell which uses a stretch of it holds. */
  readonly start: number
}

/** A value used as more than one part of the value built from it (`[a, a]`, `a.concat(a)`). */
interface Combination {
  /** The construct that builds the value (`a + a`, `[a, a]`, `a.concat(a)`). */
  readonly at: JsNode
  readonly operands: ReadonlyArray<JsNode>
  readonly scope: Scope
  /** Set for a call by name: it counts only when the name is a function of the script. */
  readonly callee?: string | undefined
  /** True when the operands are merged into one value, so a copy of one is the one. */
  readonly merging?: boolean
}

/**
 * Where names are set or changed to something built from `value` (a declaration, an assignment, a
 * write into a member, a push), so that a value built by doubling is followed to the names that
 * hold it.
 */
interface Store {
  readonly names: ReadonlyArray<string>
  readonly scope: Scope
  readonly value: JsNode
  /** True when the value is added to what the names hold (a push, `+=`, a write into a member). */
  readonly adds: boolean
}

/** A value handed to the names that take it as a parameter or a loop variable. */
interface Flow {
  readonly inputs: ReadonlyArray<JsNode>
  readonly takers: () => ReadonlyArray<Binding>
}

/** A call of a name, with the expressions it is given. */
interface Applied {
  readonly node: JsNode
  readonly name: string
  readonly scope: Scope
  readonly inputs: ReadonlyArray<JsNode>
}

/** Where a name is read, as the path of fields under it (`a.b.c` is `a` and `["b", "c"]`). */
interface Occurrence {
  readonly name: string
  readonly scope: Scope
  readonly path: ReadonlyArray<string>
}

const childScope = (parent: Scope, isFunction: boolean): Scope => ({
  parent,
  names: new Map(),
  isFunction,
})

const binding = (scope: Scope | undefined, name: string): Binding | undefined =>
  scope === undefined ? undefined : (scope.names.get(name) ?? binding(scope.parent, name))

const varScope = (scope: Scope): Scope =>
  scope.isFunction || scope.parent === undefined ? scope : varScope(scope.parent)

/** The name at the root of `a.b.c`, which decides what an assignment into it changes. */
const rootName = (node: JsNode | undefined): string | undefined =>
  node?.type === "MemberExpression" ? rootName(nodeAt(node, "object")) : nameOf(node)

/** Where a node starts and ends in the script. */
const startOf = (node: JsNode): number => (typeof node["start"] === "number" ? node["start"] : 0)
const endOf = (node: JsNode): number => (typeof node["end"] === "number" ? node["end"] : 0)

/** The value of an integer literal that a number can hold exactly, or undefined for anything else. */
const integerLiteral = (node: JsNode | undefined): number | undefined => {
  const value = node?.type === "Literal" ? node["value"] : undefined
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined
}

/**
 * The counter and the number of iterations of a `for` loop of the form `for (let i = 0; i < 10;
 * i++)`: a `let` counter set to an integer literal, a comparison with an integer literal and a
 * literal step towards it (`++`, `--`, `+= n`, `-= n`). Any other loop head has no known bound and
 * gives undefined.
 */
const countedLoop = (node: JsNode): { counter: string; count: number } | undefined => {
  const init = nodeAt(node, "init")
  const test = nodeAt(node, "test")
  const update = nodeAt(node, "update")
  if (init?.type !== "VariableDeclaration" || init["kind"] !== "let") return undefined
  const [declarator, ...more] = nodesAt(init, "declarations")
  if (declarator?.type !== "VariableDeclarator" || more.length > 0) return undefined
  const counter = nameOf(nodeAt(declarator, "id"))
  const start = integerLiteral(nodeAt(declarator, "init"))
  if (counter === undefined || start === undefined) return undefined
  if (test?.type !== "BinaryExpression" || nameOf(nodeAt(test, "left")) !== counter)
    return undefined
  const bound = integerLiteral(nodeAt(test, "right"))
  if (bound === undefined) return undefined

  let step: number | undefined
  if (update?.type === "UpdateExpression" && nameOf(nodeAt(update, "argument")) === counter)
    step = update["operator"] === "++" ? 1 : -1
  else if (update?.type === "AssignmentExpression" && nameOf(nodeAt(update, "left")) === counter) {
    const amount = integerLiteral(nodeAt(update, "right"))
    if (amount !== undefined && amount > 0)
      step =
        update["operator"] === "+=" ? amount : update["operator"] === "-=" ? -amount : undefined
  }
  if (step === undefined) return undefined

  // The distance to the bound, and none when the step walks away from it (a loop that never ends).
  const operator = test["operator"]
  const distance =
    step > 0
      ? operator === "<"
        ? bound - start
        : operator === "<="
          ? bound - start + 1
          : undefined
      : operator === ">"
        ? start - bound
        : operator === ">="
          ? start - bound + 1
          : undefined
  return distance === undefined
    ? undefined
    : { counter, count: Math.max(0, Math.ceil(distance / Math.abs(step))) }
}

/** The names a pattern or an assignment target sets; a member (`a[i]`) sets none. */
const assignedNames = (node: JsNode | undefined, into: Set<string>): void => {
  switch (node?.type) {
    case "Identifier":
      into.add(nameOf(node) ?? "")
      return
    case "RestElement":
      return assignedNames(nodeAt(node, "argument"), into)
    case "AssignmentPattern":
      return assignedNames(nodeAt(node, "left"), into)
    case "ArrayPattern":
      for (const element of nodesAt(node, "elements")) assignedNames(element, into)
      return
    case "ObjectPattern":
      for (const property of nodesAt(node, "properties"))
        assignedNames(property?.type === "Property" ? nodeAt(property, "value") : property, into)
      return
    default:
  }
}

/**
 * Whether anything under `node` satisfies `found`, looking through every field. A tree deeper than
 * the walk allows counts as a match, so the caller refuses it.
 */
const anyNode = (node: unknown, found: (node: JsNode) => boolean, depth = 0): boolean => {
  if (depth > MAX_DEPTH) return true
  if (Array.isArray(node)) return node.some((item) => anyNode(item, found, depth + 1))
  if (!isNode(node)) return false
  return (
    found(node) ||
    Object.values(node).some(
      (value) => typeof value === "object" && anyNode(value, found, depth + 1),
    )
  )
}

/** Whether the body sets the name anywhere: an assignment, an update or a `for` target. */
const setsName = (body: unknown, name: string): boolean =>
  anyNode(body, (node) => {
    const target =
      node.type === "AssignmentExpression" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement"
        ? nodeAt(node, "left")
        : node.type === "UpdateExpression"
          ? nodeAt(node, "argument")
          : undefined
    const names = new Set<string>()
    assignedNames(target, names)
    return names.has(name)
  })

/** Whether the node is a function written in place: an arrow function or a function expression. */
const isFunctionLiteral = (node: JsNode | undefined): node is JsNode =>
  node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression"

/**
 * The names a declaration sets to the whole value, not a part of it: a plain name, or the rest of a
 * pattern (`const [first, ...others] = list` sets `others` to a copy of the list less one).
 */
const copiedNames = (pattern: JsNode | undefined): ReadonlyArray<string> => {
  if (pattern?.type === "Identifier") return [nameOf(pattern) ?? ""]
  const entries = nodesAt(
    pattern ?? { type: "" },
    pattern?.type === "ArrayPattern" ? "elements" : "properties",
  )
  return entries.flatMap((entry) => {
    const into = new Set<string>()
    if (entry?.type === "RestElement") assignedNames(entry, into)
    return [...into]
  })
}

/** The node a spread element spreads, or the node itself. */
const unspread = (node: JsNode | undefined): JsNode | undefined =>
  node?.type === "SpreadElement" ? nodeAt(node, "argument") : node

/** The nodes of the list that are there; a hole in an array is not. */
const definedNodes = (list: ReadonlyArray<JsNode | undefined>): ReadonlyArray<JsNode> =>
  list.filter((node): node is JsNode => node !== undefined)

/** The text of a string literal or of a template without parts, or undefined for anything else. */
const literalText = (node: JsNode | undefined): string | undefined => {
  if (node?.type === "Literal") return typeof node["value"] === "string" ? node["value"] : undefined
  const [quasi, ...more] = nodesAt(node ?? { type: "" }, "quasis")
  const value = quasi?.["value"]
  const cooked =
    typeof value === "object" && value !== null ? (value as { cooked?: unknown }).cooked : undefined
  return node?.type === "TemplateLiteral" &&
    more.length === 0 &&
    nodesAt(node, "expressions").length === 0 &&
    typeof cooked === "string"
    ? cooked
    : undefined
}

/**
 * Whether the value puts longer text in place of text of the target (`s = s.replaceAll("a", "bb")`,
 * `s = s.split("").join("--")`), which done over and over grows the text by a factor each time. A
 * replacement with a `$` in it can paste the match back in (`$&`, `$1`), so it counts as longer
 * whatever its length. A pattern or a replacement that is no literal is not judged here.
 */
const replacesWithMore = (value: JsNode | undefined, target: JsNode | undefined): boolean => {
  const roots = identifiersIn(target)
  return anyNode(value, (node) => {
    const callee = node.type === "CallExpression" ? nodeAt(node, "callee") : undefined
    const method =
      callee?.type === "MemberExpression" ? nameOf(nodeAt(callee, "property")) : undefined
    if (method !== "replace" && method !== "replaceAll" && method !== "join") return false
    const [first, second] = nodesAt(node, "arguments")
    const receiver = nodeAt(callee ?? node, "object")
    if (method === "join") {
      // `join()` with no separator joins with a comma.
      const splitCall = receiver?.type === "CallExpression" ? receiver : undefined
      const splitter = nodeAt(splitCall ?? node, "callee")
      const splitOn =
        splitCall !== undefined &&
        splitter?.type === "MemberExpression" &&
        nameOf(nodeAt(splitter, "property")) === "split"
          ? literalText(nodesAt(splitCall, "arguments")[0])
          : undefined
      const joinWith = first === undefined ? "," : literalText(first)
      return (
        splitOn !== undefined &&
        joinWith !== undefined &&
        joinWith.length > splitOn.length &&
        identifiersIn(receiver).some((name) => roots.includes(name))
      )
    }
    const from = literalText(first)
    const to = literalText(second)
    return (
      from !== undefined &&
      to !== undefined &&
      (to.length > from.length || to.includes("$")) &&
      identifiersIn(receiver).some((name) => roots.includes(name))
    )
  })
}

/** Whether the node is a name or fields of one by name (`a`, `a.b`), nothing computed. */
const isPlainChain = (node: JsNode | undefined): boolean =>
  node?.type === "Identifier" ||
  (node?.type === "MemberExpression" &&
    node["computed"] !== true &&
    isPlainChain(nodeAt(node, "object")))

/** Whether the node is a name or fields of one (`a`, `a.b`, `a[0]`), nothing computed. */
const isChain = (node: JsNode | undefined): boolean =>
  node?.type === "Identifier" ||
  (node?.type === "MemberExpression" && isChain(nodeAt(node, "object")))

/** The field a member reads, as text. */
const fieldOf = (member: JsNode): string => {
  const property = nodeAt(member, "property")
  return member["computed"] === true && property?.type === "Literal"
    ? String(property["value"])
    : (nameOf(property) ?? "?")
}

/**
 * The names read anywhere under the node. The field of a member and the key of an object are not
 * names; every other identifier is, parameters of a function written in it included.
 */
const identifiersIn = (node: unknown, into: Array<string> = [], depth = 0): Array<string> => {
  if (depth > MAX_DEPTH) return into
  if (Array.isArray(node)) {
    for (const item of node) identifiersIn(item, into, depth + 1)
    return into
  }
  if (!isNode(node)) return into
  if (node.type === "Identifier") {
    into.push(nameOf(node) ?? "")
    return into
  }
  const skipped =
    node.type === "MemberExpression" && node["computed"] !== true
      ? "property"
      : node.type === "Property" && node["computed"] !== true
        ? "key"
        : undefined
  for (const [field, value] of Object.entries(node))
    if (field !== skipped && typeof value === "object") identifiersIn(value, into, depth + 1)
  return into
}

/**
 * Where names are read under the node, with the fields under them: `a.b.c` reads `a` at `b.c`, and
 * `a.slice()` reads `a` at nothing, since a method is not a field. A function written in place is
 * left out; the walk checks its own body.
 */
const occurrencesIn = (
  node: unknown,
  scope: Scope,
  into: Array<Occurrence>,
  depth = 0,
): Array<Occurrence> => {
  if (depth > MAX_DEPTH) return into
  if (Array.isArray(node)) {
    for (const item of node) occurrencesIn(item, scope, into, depth + 1)
    return into
  }
  if (!isNode(node)) return into
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return into
  if (node.type === "Identifier") {
    into.push({ name: nameOf(node) ?? "", scope, path: [] })
    return into
  }
  if (node.type === "MemberExpression") {
    const path: Array<string> = []
    let at: JsNode | undefined = node
    while (at?.type === "MemberExpression") {
      path.unshift(fieldOf(at))
      at = nodeAt(at, "object")
    }
    if (at?.type === "Identifier") into.push({ name: nameOf(at) ?? "", scope, path })
    else occurrencesIn(at, scope, into, depth + 1)
    return into
  }
  if (node.type === "CallExpression") {
    const callee = nodeAt(node, "callee")
    // The name of a function called is no value of the call; a method is no field of its receiver.
    if (callee?.type === "MemberExpression")
      occurrencesIn(nodeAt(callee, "object"), scope, into, depth + 1)
    else if (callee?.type !== "Identifier") occurrencesIn(callee, scope, into, depth + 1)
    occurrencesIn(node["arguments"], scope, into, depth + 1)
    return into
  }
  const skipped = node.type === "Property" && node["computed"] !== true ? "key" : undefined
  for (const [field, value] of Object.entries(node))
    if (field !== skipped && typeof value === "object") occurrencesIn(value, scope, into, depth + 1)
  return into
}

/**
 * The deepest check of what `@tintinweb/pi-subagents` runs. The package does not parse a workflow
 * script: it finds `export const meta =` by pattern and evaluates the fragment after it on the host
 * thread (`workflow/meta.ts`), then compiles the script, `export` blanked, as a classic script
 * inside an async arrow function in a worker (`workflow/worker-source.ts`). An approximation of
 * either leaves a script that reads one way to the check and another way to the package, so the
 * helpers below repeat the package's own steps and the check parses their results.
 */

/** `meta.ts:61`, the package's pattern for the meta line, made global here to count its matches. */
const META_DECLARATION = /(^|[\r\n])[ \t]*export[ \t\r\n]+const[ \t\r\n]+meta[ \t\r\n]*=/g

/**
 * Port of `scanObjectLiteral` (`meta.ts:93-174`): the index just past the object literal that
 * starts at `open`, or -1 when the braces never balance, and whether a `${` opened in a template.
 * The package tracks strings, templates, comments and regexes, by the same rules, to keep braces
 * inside them from moving the depth. Kept line for line so the two cut the same fragment.
 */
const scanObjectLiteral = (
  source: string,
  open: number,
): { readonly end: number; readonly sawInterpolation: boolean } => {
  let depth = 0
  let i = open
  let sawInterpolation = false
  let mode: "code" | "line-comment" | "block-comment" | "single" | "double" | "template" | "regex" =
    "code"
  const templateStack: Array<number> = []

  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]

    if (mode === "line-comment") {
      if (c === "\n") mode = "code"
      i++
      continue
    }
    if (mode === "block-comment") {
      if (c === "*" && next === "/") {
        mode = "code"
        i += 2
        continue
      }
      i++
      continue
    }
    if (mode === "single" || mode === "double" || mode === "regex") {
      if (c === "\\") {
        i += 2
        continue
      }
      if (mode === "single" && c === "'") mode = "code"
      else if (mode === "double" && c === '"') mode = "code"
      else if (mode === "regex" && c === "/") mode = "code"
      else if (c === "\n" && mode !== "double") mode = "code"
      i++
      continue
    }
    if (mode === "template") {
      if (c === "\\") {
        i += 2
        continue
      }
      if (c === "`") {
        mode = "code"
        i++
        continue
      }
      if (c === "$" && next === "{") {
        sawInterpolation = true
        templateStack.push(depth)
        depth++
        mode = "code"
        i += 2
        continue
      }
      i++
      continue
    }

    if (c === "/" && next === "/") {
      mode = "line-comment"
      i += 2
      continue
    }
    if (c === "/" && next === "*") {
      mode = "block-comment"
      i += 2
      continue
    }
    if (c === "'") {
      mode = "single"
      i++
      continue
    }
    if (c === '"') {
      mode = "double"
      i++
      continue
    }
    if (c === "`") {
      mode = "template"
      i++
      continue
    }
    if (c === "/" && isRegexPosition(source, i)) {
      mode = "regex"
      i++
      continue
    }
    if (c === "{") {
      depth++
      i++
      continue
    }
    if (c === "}") {
      depth--
      i++
      if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
        templateStack.pop()
        mode = "template"
        continue
      }
      if (depth === 0) return { end: i, sawInterpolation }
      continue
    }
    i++
  }
  return { end: -1, sawInterpolation }
}

/** Port of `isRegexPosition` (`meta.ts:176-183`): whether the `/` at `i` opens a regex literal. */
const isRegexPosition = (source: string, i: number): boolean => {
  let j = i - 1
  while (j >= 0 && /\s/.test(source[j] ?? "")) j--
  if (j < 0) return true
  return !/[\w$)\]]/.test(source[j] ?? "")
}

/**
 * A literal and nothing else: strings, numbers, booleans, `null`, and arrays and objects of them,
 * with plain keys. No identifier, call, `this`, template, spread, getter, method or computed key.
 */
const literalOnly = (node: JsNode | undefined, depth: number): boolean => {
  if (node === undefined || depth > MAX_DEPTH) return false
  if (node.type === "Literal") return !("regex" in node) && !("bigint" in node)
  if (node.type === "ArrayExpression")
    return nodesAt(node, "elements").every((item) => literalOnly(item, depth + 1))
  if (node.type !== "ObjectExpression") return false
  return nodesAt(node, "properties").every((property) => {
    const key = nodeAt(property ?? { type: "" }, "key")
    const name =
      key?.type === "Literal" && typeof key["value"] === "string" ? key["value"] : nameOf(key)
    return (
      property?.type === "Property" &&
      property["computed"] === false &&
      property["kind"] === "init" &&
      property["method"] !== true &&
      name !== undefined &&
      !DENIED_NAMES.has(name) &&
      literalOnly(nodeAt(property, "value"), depth + 1)
    )
  })
}

/** The line the wrapper puts before the script, as `worker-source.ts:757` builds it. */
const WRAPPER_OPEN = "(async () => {"

/**
 * What the worker's prelude adds before the script on one line (`worker-source.ts:55-72`, a `const
 * Date = …;` statement): the parse of the script cannot tell its text from this stand-in.
 */
const WRAPPER_PRELUDE = "const Date = void 0;"

/**
 * The program the Pi package runs for `script`, as a tree for the check to walk, or the reason the
 * package would run something the check cannot vet.
 *
 * First the meta fragment, computed as `extractMeta` does (`meta.ts:216-247`): the package takes
 * the first match of the meta pattern, the first `{` after it and the brace-scanned fragment from
 * there, and evaluates `(fragment)` on the host thread, where `this.constructor.constructor`
 * reaches `process`. The fragment is accepted only as an object expression of literals that is the
 * whole fragment, and a script with no match, or more than one, is refused. Then the body the
 * worker compiles (`meta.ts:289-290`, `worker-source.ts:757`): the script with the first match's
 * `export` blanked, wrapped as `(async () => {` prelude `\n` body `\n})()`, parsed as a classic
 * script, so HTML-like comments and Annex B function hoisting read as they do at run time. The tree
 * is returned as a program of the statements of the wrapper's body, after the prelude, and only
 * when the wrapper stands as built (the body did not close it and open another).
 */
const workerProgram = (
  script: string,
): { readonly program: JsNode } | { readonly refusal: string } => {
  const matches = [...script.matchAll(META_DECLARATION)]
  const found = matches[0]
  if (found === undefined)
    return {
      refusal: "has no line that reads as `export const meta =`, which the package requires",
    }
  if (matches.length > 1)
    return { refusal: "has more than one line that reads as `export const meta =`" }

  const open = script.indexOf("{", (found.index ?? 0) + found[0].length)
  if (open === -1) return { refusal: "gives `export const meta` no object literal" }
  const { end, sawInterpolation } = scanObjectLiteral(script, open)
  if (end === -1) return { refusal: "has a `meta` object literal that is never closed" }
  if (sawInterpolation) return { refusal: "uses template interpolation in `meta`" }
  const fragment = script.slice(open, end)
  const wrapped = parse(`(${fragment})`, { ecmaVersion: "latest", sourceType: "script" })
  const statement = wrapped.body[0] as unknown as JsNode | undefined
  const value = statement === undefined ? undefined : nodeAt(statement, "expression")
  if (
    wrapped.body.length !== 1 ||
    statement?.type !== "ExpressionStatement" ||
    value?.type !== "ObjectExpression" ||
    startOf(value) !== 1 ||
    endOf(value) !== fragment.length + 1 ||
    !literalOnly(value, 1)
  )
    return { refusal: "has a `meta` that is not an object literal of plain literals" }

  const exportAt = script.indexOf("export", found.index)
  const body = `${script.slice(0, exportAt)}${" ".repeat(6)}${script.slice(exportAt + 6)}`
  const prefix = `${WRAPPER_OPEN}${WRAPPER_PRELUDE}\n`
  const source = `${prefix}${body}\n})()`
  const program = parse(source, { ecmaVersion: "latest", sourceType: "script" })
  const call = nodeAt(program.body[0] as unknown as JsNode, "expression")
  const arrow = call === undefined ? undefined : nodeAt(call, "callee")
  const block = arrow === undefined ? undefined : nodeAt(arrow, "body")
  const statements = block === undefined ? [] : nodesAt(block, "body")
  const prelude = statements[0]
  if (
    program.body.length !== 1 ||
    call?.type !== "CallExpression" ||
    nodesAt(call, "arguments").length !== 0 ||
    arrow?.type !== "ArrowFunctionExpression" ||
    arrow["async"] !== true ||
    block?.type !== "BlockStatement" ||
    endOf(block) !== source.length - 3 ||
    prelude?.type !== "VariableDeclaration" ||
    startOf(prelude) !== WRAPPER_OPEN.length ||
    endOf(prelude) !== prefix.length - 1
  )
    return { refusal: "closes the wrapper the package puts around a script" }
  return { program: { type: "Program", body: statements.slice(1) } }
}

/**
 * Why a script is not plain (the first reason found), or undefined when it is: the script parsed as
 * a module with top-level await (or, when `classic`, as the program the Pi package runs, see
 * {@link workerProgram}), every node of a type in the closed set, every name resolved, every
 * `agent()` call vetted and at least one of them. A parse error or an overflow throws; the caller
 * turns that into a refusal.
 */
const inspect = (
  script: string,
  specialists: ReadonlySet<string>,
  classic: boolean,
): string | undefined => {
  if (script.length > MAX_WORKFLOW_SCRIPT) return "the script is too large"
  const parsed = classic
    ? workerProgram(script)
    : {
        program: parse(script, {
          ecmaVersion: "latest",
          sourceType: "module",
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true,
        }) as unknown as JsNode,
      }
  if ("refusal" in parsed) return parsed.refusal
  const { program } = parsed
  let refusal: string | undefined
  const refuse = (why: string) => {
    refusal ??= why
  }
  const references: Array<Reference> = []
  // Assignments to a name and writes into a member, checked once every name is known.
  const assignments: Array<{
    name: string
    scope: Scope
    right: JsNode | undefined
    builtHere: () => boolean
  }> = []
  const memberWrites: Array<{
    root: string | undefined
    scope: Scope
    right: JsNode | undefined
  }> = []
  // What `Array.from` is given, to check once every name is known that it is an array.
  const arraysFrom: Array<{ source: JsNode; scope: Scope }> = []
  let agentCalls = 0
  // The iterations the loops and passes over data around the statement being walked run together,
  // counted from the start of the function of the script it stands in.
  let loopWork = 1
  const rootContext: WorkContext = { max: 1, calls: [] }
  let context = rootContext
  const contexts = new Map<JsNode, WorkContext>()
  // The functions of the script around the statement being walked, outermost first, and the loops
  // over data (for-of) whose body it stands in.
  let functionsAround: ReadonlyArray<JsNode> = []
  let walks: ReadonlyArray<Walk> = []
  let loopDepth = 0
  const everyWalk: Array<Walk> = []
  const growths: Array<GrowthSite> = []
  const combinations: Array<Combination> = []
  // The calls that put text in place of text (`replace`, `replaceAll`, `join`), judged once every
  // name is known: whether they paste in more than they take out.
  const textSwaps: Array<{
    readonly node: JsNode
    readonly receiver: JsNode
    readonly method: string
    readonly first: JsNode | undefined
    readonly second: JsNode | undefined
    readonly scope: Scope
    /** Whether it stands in a loop or a function, where it can run again and again. */
    readonly repeats: boolean
  }> = []
  const combine = (at: JsNode, combination: Omit<Combination, "at">) => {
    combinations.push({ ...combination, at })
  }
  // Where a value built by doubling goes: the names it is stored in, the parameters and loop
  // variables it is handed to, the calls of named functions, and the parameters of each function.
  const stores: Array<Store> = []
  const flows: Array<Flow> = []
  const applications: Array<Applied> = []
  const functionNodes: Array<JsNode> = []
  const parametersOf = new Map<JsNode, ReadonlyArray<Binding>>()
  const firstParameterOf = new Map<JsNode, ReadonlyArray<Binding>>()
  // The functions that call something the script cannot see into, by where the call stands.
  const dynamicIn: Array<ReadonlyArray<JsNode>> = []
  // Function values: where one may stand, the functions that are bound to a name, and the
  // callbacks that may hand back a function (a stage that builds the thunks of `parallel()`).
  const allowedFunctions = new Set<JsNode>()
  const namedFunctions = new Set<JsNode>()
  const functionMakers = new Set<JsNode>()
  const functionAssignments: Array<{ name: string; scope: Scope; node: JsNode }> = []
  let analysisSteps = 0
  const spend = () => {
    analysisSteps += 1
    return analysisSteps <= MAX_ANALYSIS_STEPS
  }
  const setWork = (next: number) => {
    loopWork = next
    context.max = Math.max(context.max, next)
    if (next > MAX_NESTED_ITERATIONS) refuse("nests loops that run too many iterations")
  }

  /**
   * Declares a name; `origin` tests whether the script built its value, and `undefined` is none
   * yet.
   */
  const declare = (scope: Scope, name: string, origin?: (() => boolean) | "unsafe") => {
    if (GLOBALS.has(name) || HOST_GLOBALS.has(name) || DENIED_NAMES.has(name) || name === "agent")
      refuse(`declares ${name}, a name of the host`)
    const held: Binding = scope.names.get(name) ?? newBinding()
    if (origin === "unsafe") held.unsafe = true
    else if (origin !== undefined) held.inits.push(origin)
    scope.names.set(name, held)
  }

  const refer = (node: JsNode, scope: Scope, use: Use) => {
    const name = nameOf(node)
    if (name === undefined) return refuse("reads a name it cannot read")
    const reference: Reference = {
      name,
      scope,
      use,
      within: functionsAround,
      factor: loopWork,
      start: startOf(node),
    }
    references.push(reference)
    if (use !== "callee") return
    context.calls.push(reference)
    for (const walk of walks) walk.calls.push(reference)
  }

  /** Notes that a call stands here whose callee the check cannot follow. */
  const callsBlind = () => {
    dynamicIn.push(functionsAround)
  }

  // Whether a script built the value of an expression itself, or took it from `args` or an agent:
  // a literal, an agent() result, data read from `args`, a result of a data method, or a name
  // that holds only such values. Run after the walk, when every name is known.
  const evaluating = new Set<Binding>()
  const builtBinding = (held: Binding): boolean => {
    if (evaluating.has(held) || held.unsafe || held.inits.length === 0) return false
    evaluating.add(held)
    const built = held.inits.every((init) => init())
    evaluating.delete(held)
    return built
  }
  const builtHere = (node: JsNode | undefined, scope: Scope): boolean => {
    switch (node?.type) {
      case "ObjectExpression":
      case "ArrayExpression":
      case "Literal":
      case "TemplateLiteral":
        return true
      case "AwaitExpression":
        return builtHere(nodeAt(node, "argument"), scope)
      case "ChainExpression":
        return builtHere(nodeAt(node, "expression"), scope)
      case "MemberExpression":
        return builtHere(nodeAt(node, "object"), scope)
      case "ConditionalExpression":
        return (
          builtHere(nodeAt(node, "consequent"), scope) &&
          builtHere(nodeAt(node, "alternate"), scope)
        )
      case "CallExpression": {
        const callee = nodeAt(node, "callee")
        if (nameOf(callee) === "agent") return true
        const object = callee?.type === "MemberExpression" ? nodeAt(callee, "object") : undefined
        const global = nameOf(object)
        return (
          object !== undefined &&
          (global !== undefined && GLOBAL_CALLS[global] !== undefined
            ? binding(scope, global) === undefined
            : builtHere(object, scope))
        )
      }
      case "Identifier": {
        const name = nameOf(node) ?? ""
        const held = binding(scope, name)
        return held === undefined ? VALUE_GLOBALS.has(name) : builtBinding(held)
      }
      default:
        return false
    }
  }

  // A binding pattern (a declaration or a parameter). Keys are plain identifiers, never computed.
  const declarePattern = (
    node: JsNode | undefined,
    scope: Scope,
    target: Scope,
    depth: number,
    origin?: (() => boolean) | "unsafe",
  ): void => {
    if (node === undefined || depth > MAX_DEPTH) return refuse("nests too deep")
    switch (node.type) {
      case "Identifier":
        return declare(target, nameOf(node) ?? "", origin)
      case "RestElement":
        return declarePattern(nodeAt(node, "argument"), scope, target, depth + 1, origin)
      case "AssignmentPattern":
        declarePattern(nodeAt(node, "left"), scope, target, depth + 1, origin)
        return expression(nodeAt(node, "right"), scope, depth + 1)
      case "ArrayPattern":
        for (const element of nodesAt(node, "elements"))
          if (element !== undefined) declarePattern(element, scope, target, depth + 1, origin)
        return
      case "ObjectPattern":
        for (const property of nodesAt(node, "properties")) {
          if (property?.type === "RestElement")
            declarePattern(property, scope, target, depth + 1, origin)
          else if (
            property?.type === "Property" &&
            property["computed"] === false &&
            property["kind"] === "init" &&
            nameOf(nodeAt(property, "key")) !== undefined &&
            !DENIED_NAMES.has(nameOf(nodeAt(property, "key")) ?? "")
          )
            declarePattern(nodeAt(property, "value"), scope, target, depth + 1, origin)
          else refuse("destructures with a key that is not a plain name")
        }
        return
      default:
        return refuse(`binds with ${node.type}`)
    }
  }

  const variableDeclaration = (node: JsNode, scope: Scope, depth: number, loop?: "unsafe") => {
    const kind = node["kind"]
    if (kind !== "var" && kind !== "let" && kind !== "const")
      return refuse(`declares with ${String(kind)}`)
    for (const declarator of nodesAt(node, "declarations")) {
      if (declarator?.type !== "VariableDeclarator") return refuse("declares oddly")
      const init = nodeAt(declarator, "init")
      const id = nodeAt(declarator, "id")
      const target = kind === "var" ? varScope(scope) : scope
      declarePattern(
        id,
        scope,
        target,
        depth + 1,
        loop ?? (init === undefined ? undefined : () => builtHere(init, scope)),
      )
      if (init !== undefined && loop === undefined) {
        if (isFunctionLiteral(init) && id?.type === "Identifier") {
          allowedFunctions.add(init)
          namedFunctions.add(init)
          target.names.get(nameOf(id) ?? "")?.functions.add(init)
        } else {
          for (const name of copiedNames(id))
            target.names.get(name)?.sources.push({ node: init, scope })
          const names = new Set<string>()
          assignedNames(id, names)
          stores.push({ names: [...names], scope, value: init, adds: false })
        }
      }
      expression(init, scope, depth + 1)
    }
  }

  const functionNode = (node: JsNode, scope: Scope, depth: number) => {
    if (node["generator"] === true) return refuse("uses a generator")
    const inner = childScope(scope, true)
    const own = nameOf(nodeAt(node, "id"))
    if (node.type === "FunctionExpression" && own !== undefined) {
      declare(inner, own, "unsafe")
      inner.names.get(own)?.functions.add(node)
    }
    for (const parameter of nodesAt(node, "params"))
      declarePattern(parameter, inner, inner, depth + 1, "unsafe")
    const parameterNames = new Set<string>()
    for (const parameter of nodesAt(node, "params")) assignedNames(parameter, parameterNames)
    const firstNames = new Set<string>()
    assignedNames(nodesAt(node, "params")[0], firstNames)
    functionNodes.push(node)
    parametersOf.set(
      node,
      [...parameterNames].flatMap((name) => inner.names.get(name) ?? []),
    )
    firstParameterOf.set(
      node,
      [...firstNames].flatMap((name) => inner.names.get(name) ?? []),
    )
    // A function bound to a name does its own work whenever it is called: it starts from one
    // iteration and is priced where it is called. Any other runs where it stands.
    const outerWork = loopWork
    const outerContext = context
    if (node.type === "FunctionDeclaration" || namedFunctions.has(node)) {
      loopWork = 1
      context = { max: 1, calls: [] }
      contexts.set(node, context)
    }
    const outerFunctions = functionsAround
    functionsAround = [...functionsAround, node]
    const body = nodeAt(node, "body")
    if (body?.type === "BlockStatement") statements(nodesAt(body, "body"), inner, depth + 1)
    else {
      if (isFunctionLiteral(body) && functionMakers.has(node)) {
        allowedFunctions.add(body)
        functionMakers.add(body)
      }
      expression(body, inner, depth + 1)
    }
    functionsAround = outerFunctions
    loopWork = outerWork
    context = outerContext
  }

  const objectProperty = (property: JsNode | undefined, scope: Scope, depth: number) => {
    if (property?.type === "SpreadElement")
      return expression(nodeAt(property, "argument"), scope, depth + 1)
    const key = nodeAt(property ?? { type: "" }, "key")
    const keyName =
      key?.type === "Literal" &&
      (typeof key["value"] === "string" || typeof key["value"] === "number")
        ? String(key["value"])
        : nameOf(key)
    if (
      property?.type !== "Property" ||
      property["computed"] !== false ||
      property["kind"] !== "init" ||
      property["method"] === true ||
      keyName === undefined ||
      keyName === "length" ||
      DENIED_NAMES.has(keyName)
    )
      return refuse("builds an object with a key it cannot vet")
    expression(nodeAt(property, "value"), scope, depth + 1)
  }

  const memberExpression = (node: JsNode, scope: Scope, depth: number, called: boolean) => {
    const object = nodeAt(node, "object")
    if (object?.type === "Identifier") refer(object, scope, "object")
    else expression(object, scope, depth + 1)
    const property = nodeAt(node, "property")
    if (node["computed"] === true) {
      const index = property?.type === "Literal" ? property["value"] : undefined
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0)
        refuse("reads a member by a computed key")
      return
    }
    const name = nameOf(property)
    if (name === undefined || DENIED_NAMES.has(name)) return refuse(`reads .${name ?? "?"}`)
    // A global object is read and called only through the short lists of what a workflow needs,
    // so none of it can be changed, frozen, or taken as a value. `args` is plain data.
    const owner = nameOf(object)
    if (owner !== undefined && GLOBALS.has(owner) && owner !== "args") {
      const allowed = (called ? GLOBAL_CALLS : GLOBAL_FIELDS)[owner]
      if (allowed === undefined || !allowed.has(name))
        refuse(`${called ? "calls" : "reads"} ${owner}.${name}`)
      return
    }
    // A method is called directly or not at all, so it cannot be aliased or given another `this`.
    if (called !== CALLABLE_PROPERTIES.has(name))
      refuse(called ? `calls .${name}` : `reads the method .${name} without calling it`)
  }

  const agentCall = (node: JsNode, scope: Scope, depth: number) => {
    agentCalls += 1
    const args = nodesAt(node, "arguments")
    const [prompt, options, ...rest] = args
    if (
      node["optional"] === true ||
      rest.length > 0 ||
      prompt === undefined ||
      prompt.type === "SpreadElement" ||
      options?.type !== "ObjectExpression"
    )
      return refuse("calls agent() other than as agent(prompt, { … })")
    expression(prompt, scope, depth + 1)
    let named = 0
    for (const property of nodesAt(options, "properties")) {
      const key = nodeAt(property ?? { type: "" }, "key")
      const name =
        key?.type === "Literal" && typeof key["value"] === "string" ? key["value"] : nameOf(key)
      if (
        property?.type !== "Property" ||
        property["computed"] !== false ||
        property["kind"] !== "init" ||
        property["method"] === true ||
        name === undefined ||
        !AGENT_OPTIONS.has(name)
      )
        return refuse("sets an agent() option it cannot vet")
      const value = nodeAt(property, "value")
      if (name !== "agentType") expression(value, scope, depth + 1)
      else if (
        value?.type === "Literal" &&
        typeof value["value"] === "string" &&
        specialists.has(value["value"])
      )
        named += 1
      else
        return refuse("starts an agent that is not a holyagent specialist by a literal agentType")
    }
    if (named !== 1) refuse("gives agent() no single agentType")
  }

  const callExpression = (node: JsNode, scope: Scope, depth: number) => {
    const callee = nodeAt(node, "callee")
    if (nameOf(callee) === "agent") return agentCall(node, scope, depth)
    if (node["optional"] === true) return refuse("makes an optional call")
    const given = nodesAt(node, "arguments")
    const values = definedNodes(given.map(unspread))
    const receiver = callee?.type === "MemberExpression" ? nodeAt(callee, "object") : undefined
    // What a callback written in place is handed: the receiver and the arguments that are no callback.
    const handed = [
      ...(receiver === undefined ? [] : [receiver]),
      ...values.filter((argument) => !isFunctionLiteral(argument)),
    ]
    const nameCalled = nameOf(callee)
    if (nameCalled !== undefined)
      applications.push({ node, name: nameCalled, scope, inputs: values })
    // The arguments the call hands a function to run, and how many times it runs it.
    let callbacks: ReadonlyArray<JsNode | undefined> = []
    let passes = 1
    let method = ""
    if (callee?.type === "Identifier") {
      refer(callee, scope, "callee")
      const name = nameOf(callee)
      if (name === "parallel" || name === "pipeline") callsBlind()
      if (name === "pipeline") {
        callbacks = given.slice(1)
        passes = DATA_ITERATIONS
      }
      if (name === "parallel")
        callbacks = given.flatMap((argument) =>
          argument?.type === "ArrayExpression" ? nodesAt(argument, "elements") : [],
        )
      if (values.length > 1) combine(node, { operands: values, scope, callee: name })
    } else if (callee?.type === "MemberExpression") {
      memberExpression(callee, scope, depth + 1, true)
      const computed = callee["computed"] === true
      method = computed ? "" : (nameOf(nodeAt(callee, "property")) ?? "")
      const object = nodeAt(callee, "object")
      const owner = nameOf(object)
      if (computed) callsBlind()
      const limit = MAX_ARGUMENTS[method]
      if (
        !computed &&
        limit !== undefined &&
        (given.length > limit || given.some((argument) => argument?.type === "SpreadElement"))
      )
        refuse("passes a method more arguments than its callback (a this value)")
      const count = integerLiteral(given[0])
      if (
        TEXT_COUNTS.has(method) &&
        given.length > 0 &&
        (count === undefined || count < 0 || count > MAX_TEXT_COUNT)
      )
        refuse(`calls .${method} with a count that is not a literal of at most ${MAX_TEXT_COUNT}`)
      const repeated = object?.type === "Literal" ? object["value"] : undefined
      if (
        method === "repeat" &&
        (typeof repeated !== "string" || repeated.length > MAX_REPEATED_TEXT)
      )
        refuse(`repeats something that is not a literal of at most ${MAX_REPEATED_TEXT} characters`)
      if (owner === "Array" && method === "from" && given[0] !== undefined)
        arraysFrom.push({ source: given[0], scope })
      const position = CALLBACK_ARGUMENTS.get(method)
      if (position !== undefined) {
        callbacks = position === "all" ? given : given.slice(position, position + 1)
        // A function that is not written here may be one that calls back into the script.
        if (callbacks.some((argument) => !isFunctionLiteral(argument))) callsBlind()
        for (const argument of callbacks)
          if (isFunctionLiteral(argument)) {
            functionMakers.add(argument)
          }
        if (ITERATING_METHODS.has(method)) passes = DATA_ITERATIONS
      }
      if (
        object !== undefined &&
        (method === "replace" || method === "replaceAll" || method === "join")
      )
        textSwaps.push({
          node,
          receiver: object,
          method,
          first: given[0],
          second: given[1],
          scope,
          repeats: functionsAround.length > 0 || loopDepth > 0,
        })
      if (COMBINING_METHODS.has(method) && object !== undefined)
        combine(node, { operands: [object, ...values], scope, merging: true })
      else if (owner === "Array" && method === "of") combine(node, { operands: values, scope })
      if (GROWING_METHODS.has(method) && object !== undefined) {
        const site: GrowthSite = {
          names: identifiersIn(object),
          opaque: !isPlainChain(object),
          scope,
          within: functionsAround,
        }
        growths.push(site)
        for (const walk of walks) walk.sites.push(site)
        stores.push({ names: identifiersIn(object), scope, value: node, adds: true })
      }
    } else if (isFunctionLiteral(callee)) functionNode(callee, scope, depth + 1)
    else return refuse("calls something it cannot vet")
    for (const argument of callbacks)
      if (isFunctionLiteral(argument)) {
        allowedFunctions.add(argument)
        flows.push({ inputs: handed, takers: () => parametersOf.get(argument) ?? [] })
        // What `reduce` callback returns is the accumulator the next call is handed.
        if (method === "reduce")
          flows.push({ inputs: [argument], takers: () => firstParameterOf.get(argument) ?? [] })
      }
    if (isFunctionLiteral(callee))
      flows.push({ inputs: values, takers: () => parametersOf.get(callee) ?? [] })
    const outerWork = loopWork
    for (const argument of given) {
      if (passes > 1 && callbacks.includes(argument)) setWork(outerWork * passes)
      expression(
        argument?.type === "SpreadElement" ? nodeAt(argument, "argument") : argument,
        scope,
        depth + 1,
      )
      loopWork = outerWork
    }
  }

  // The target of an assignment or an update: a name, or a member of data the script built (checked
  // once every name is known). `builtHere` tests whether the value assigned is the script's own, and
  // `right` is the value, for the names an alias leads back to.
  const writeTarget = (
    node: JsNode | undefined,
    scope: Scope,
    depth: number,
    builtValue: () => boolean,
    right?: JsNode,
  ) => {
    if (node?.type === "Identifier") {
      refer(node, scope, "write")
      assignments.push({ name: nameOf(node) ?? "", scope, right, builtHere: builtValue })
      return
    }
    if (node?.type === "MemberExpression") {
      // A length or a far index would make a sparse array of any size, for a loop to walk.
      const property = nodeAt(node, "property")
      const index = property?.type === "Literal" ? property["value"] : undefined
      if (
        (node["computed"] !== true && nameOf(property) === "length") ||
        (typeof index === "number" && index > MAX_WRITE_INDEX)
      )
        refuse(`writes a length or an index above ${MAX_WRITE_INDEX} into an array`)
      memberWrites.push({ root: rootName(node), scope, right })
      return memberExpression(node, scope, depth + 1, false)
    }
    refuse("assigns to something that is not a name or a member")
  }

  function expression(node: JsNode | undefined, scope: Scope, depth: number): void {
    if (node === undefined) return
    if (depth > MAX_DEPTH) return refuse("nests too deep")
    switch (node.type) {
      case "Identifier":
        return refer(node, scope, "value")
      case "Literal":
        if ("regex" in node || "bigint" in node) refuse("uses a regular expression or a bigint")
        return
      case "TemplateLiteral":
        combine(node, {
          operands: definedNodes(nodesAt(node, "expressions")),
          scope,
          merging: true,
        })
        for (const part of nodesAt(node, "expressions")) expression(part, scope, depth + 1)
        return
      case "ArrayExpression":
        combine(node, {
          operands: definedNodes(nodesAt(node, "elements").map(unspread)),
          scope,
          merging: nodesAt(node, "elements").some((element) => element?.type === "SpreadElement"),
        })
        for (const element of nodesAt(node, "elements"))
          expression(
            element?.type === "SpreadElement" ? nodeAt(element, "argument") : element,
            scope,
            depth + 1,
          )
        return
      case "ObjectExpression":
        combine(node, {
          operands: definedNodes(
            nodesAt(node, "properties").map((property) =>
              property?.type === "SpreadElement"
                ? nodeAt(property, "argument")
                : nodeAt(property ?? node, "value"),
            ),
          ),
          scope,
          merging: nodesAt(node, "properties").some(
            (property) => property?.type === "SpreadElement",
          ),
        })
        for (const property of nodesAt(node, "properties")) objectProperty(property, scope, depth)
        return
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        // A function value may stand only where it is run at once, by a method or an operator of
        // the workflow, or where it is bound to a name; held anywhere else it could be called back.
        if (!allowedFunctions.has(node))
          return refuse("holds a function where only a callback may be")
        return functionNode(node, scope, depth)
      case "UnaryExpression":
        if (!UNARY.has(String(node["operator"]))) return refuse("uses delete")
        return expression(nodeAt(node, "argument"), scope, depth + 1)
      case "UpdateExpression":
        return writeTarget(nodeAt(node, "argument"), scope, depth, () => true)
      case "BinaryExpression":
      case "LogicalExpression":
        if (node["operator"] === "+")
          combine(node, {
            operands: definedNodes([nodeAt(node, "left"), nodeAt(node, "right")]),
            scope,
            merging: true,
          })
        expression(nodeAt(node, "left"), scope, depth + 1)
        return expression(nodeAt(node, "right"), scope, depth + 1)
      case "AssignmentExpression": {
        const left = nodeAt(node, "left")
        const right = nodeAt(node, "right")
        const operator = node["operator"]
        if (operator === "=" && left?.type === "Identifier" && isFunctionLiteral(right)) {
          allowedFunctions.add(right)
          namedFunctions.add(right)
          functionAssignments.push({ name: nameOf(left) ?? "", scope, node: right })
        }
        if (operator === "+=")
          combine(node, { operands: definedNodes([left, right]), scope, merging: true })
        if (
          (operator === "=" || operator === "+=") &&
          (functionsAround.length > 0 || loopDepth > 0) &&
          replacesWithMore(right, left)
        )
          refuse("replaces text with longer text again and again")
        if (!isFunctionLiteral(right)) {
          const names = new Set<string>()
          assignedNames(left, names)
          const root = rootName(left)
          if (root !== undefined) names.add(root)
          stores.push({
            names: [...names],
            scope,
            value: node,
            adds: operator !== "=" || left?.type === "MemberExpression",
          })
        }
        writeTarget(
          left,
          scope,
          depth,
          operator === "=" ? () => builtHere(right, scope) : () => true,
          operator === "=" && !isFunctionLiteral(right) ? right : undefined,
        )
        return expression(right, scope, depth + 1)
      }
      case "ConditionalExpression":
        expression(nodeAt(node, "test"), scope, depth + 1)
        expression(nodeAt(node, "consequent"), scope, depth + 1)
        return expression(nodeAt(node, "alternate"), scope, depth + 1)
      case "AwaitExpression":
        return expression(nodeAt(node, "argument"), scope, depth + 1)
      case "ChainExpression":
        return expression(nodeAt(node, "expression"), scope, depth + 1)
      case "MemberExpression":
        return memberExpression(node, scope, depth, false)
      case "CallExpression":
        return callExpression(node, scope, depth)
      default:
        return refuse(`uses ${node.type}`)
    }
  }

  function statements(list: ReadonlyArray<JsNode | undefined>, scope: Scope, depth: number): void {
    for (const node of list) statement(node, scope, depth + 1)
  }

  function statement(node: JsNode | undefined, scope: Scope, depth: number): void {
    if (node === undefined) return
    if (depth > MAX_DEPTH) return refuse("nests too deep")
    const inner = () => childScope(scope, false)
    switch (node.type) {
      case "EmptyStatement":
        return
      case "ExpressionStatement":
        return expression(nodeAt(node, "expression"), scope, depth + 1)
      case "VariableDeclaration":
        return variableDeclaration(node, scope, depth)
      case "FunctionDeclaration": {
        // A classic script hoists a function declared in a block to the function around it, a
        // module keeps it in the block; under Pi no name may mean two things, so only a function
        // body (or the script) declares functions.
        if (classic && !scope.isFunction) refuse("declares a function inside a block")
        const name = nameOf(nodeAt(node, "id")) ?? ""
        declare(scope, name, "unsafe")
        scope.names.get(name)?.functions.add(node)
        return functionNode(node, scope, depth)
      }
      case "ReturnStatement":
      case "ThrowStatement": {
        // A callback that builds thunks may return one.
        const result = nodeAt(node, "argument")
        const maker = functionsAround[functionsAround.length - 1]
        if (
          node.type === "ReturnStatement" &&
          isFunctionLiteral(result) &&
          maker !== undefined &&
          functionMakers.has(maker)
        ) {
          allowedFunctions.add(result)
          functionMakers.add(result)
        }
        return expression(result, scope, depth + 1)
      }
      case "IfStatement":
        expression(nodeAt(node, "test"), scope, depth + 1)
        statement(nodeAt(node, "consequent"), scope, depth + 1)
        return statement(nodeAt(node, "alternate"), scope, depth + 1)
      case "BlockStatement":
        return statements(nodesAt(node, "body"), inner(), depth)
      case "ForStatement": {
        const loop = inner()
        const counted = countedLoop(node)
        if (
          counted === undefined ||
          counted.count > MAX_LOOP_COUNT ||
          setsName(nodeAt(node, "body"), counted.counter)
        )
          refuse(
            `runs a for loop that is not a counted loop of at most ${MAX_LOOP_COUNT} iterations (for (let i = 0; i < 10; i++))`,
          )
        const outerWork = loopWork
        setWork(loopWork * Math.max(counted?.count ?? 1, 1))
        const init = nodeAt(node, "init")
        if (init?.type === "VariableDeclaration") variableDeclaration(init, loop, depth + 1)
        else expression(init, loop, depth + 1)
        expression(nodeAt(node, "test"), loop, depth + 1)
        expression(nodeAt(node, "update"), loop, depth + 1)
        loopDepth += 1
        statement(nodeAt(node, "body"), loop, depth + 1)
        loopDepth -= 1
        loopWork = outerWork
        return
      }
      case "ForOfStatement":
      case "ForInStatement": {
        const loop = inner()
        const left = nodeAt(node, "left")
        if (left?.type === "VariableDeclaration")
          variableDeclaration(left, loop, depth + 1, "unsafe")
        else writeTarget(left, loop, depth + 1, () => false)
        // A loop over data ends with the data, unless its body keeps adding to what it walks; that
        // is checked once every name is known (see the end of the walk).
        const right = nodeAt(node, "right")
        expression(right, loop, depth + 1)
        if (right !== undefined) {
          const taken = new Set<string>()
          assignedNames(
            left?.type === "VariableDeclaration"
              ? nodeAt(nodesAt(left, "declarations")[0] ?? left, "id")
              : left,
            taken,
          )
          const root = rootName(left)
          if (root !== undefined) taken.add(root)
          flows.push({
            inputs: [right],
            takers: () => [...taken].flatMap((name) => binding(loop, name) ?? []),
          })
        }
        const walk: Walk = { walked: identifiersIn(right), scope, sites: [], calls: [] }
        const outerWork = loopWork
        const outerWalks = walks
        if (node.type === "ForOfStatement") {
          everyWalk.push(walk)
          walks = [...walks, walk]
        }
        setWork(outerWork * DATA_ITERATIONS)
        loopDepth += 1
        statement(nodeAt(node, "body"), loop, depth + 1)
        loopDepth -= 1
        walks = outerWalks
        loopWork = outerWork
        return
      }
      case "WhileStatement":
      case "DoWhileStatement":
        return refuse("uses a while or do loop, which has no bound")
      case "BreakStatement":
      case "ContinueStatement":
        if (node["label"] !== null) refuse("uses a label")
        return
      case "TryStatement": {
        statement(nodeAt(node, "block"), scope, depth + 1)
        const handler = nodeAt(node, "handler")
        if (handler !== undefined) {
          const catching = inner()
          const parameter = nodeAt(handler, "param")
          if (parameter !== undefined)
            declarePattern(parameter, catching, catching, depth + 1, "unsafe")
          statements(nodesAt(nodeAt(handler, "body") ?? handler, "body"), catching, depth)
        }
        return statement(nodeAt(node, "finalizer"), scope, depth + 1)
      }
      case "SwitchStatement": {
        expression(nodeAt(node, "discriminant"), scope, depth + 1)
        const cases = inner()
        for (const entry of nodesAt(node, "cases")) {
          expression(nodeAt(entry ?? { type: "" }, "test"), cases, depth + 1)
          statements(nodesAt(entry ?? { type: "" }, "consequent"), cases, depth)
        }
        return
      }
      default:
        return refuse(`uses ${node.type}`)
    }
  }

  /**
   * The checks that need every name resolved: what calls what, what a loop walks and its body
   * grows, which values are used twice to build a bigger one, and what the loops and calls multiply
   * to.
   */
  function analyse() {
    // What a name stands for: its binding, or "args"; any other global of the workflow is no value.
    const keyOf = (name: string, scope: Scope): Binding | string | undefined =>
      binding(scope, name) ?? (name === "args" ? "args" : undefined)

    // Calls: the functions each function calls by name, and the functions that call through
    // something the check cannot see (a parameter, a computed member, a callback not written in
    // place). Recursion, or a call into a function that calls blindly from inside any function,
    // could call back around to itself.
    const dynamic = new Set<JsNode>()
    for (const within of dynamicIn) for (const caller of within) dynamic.add(caller)
    const edges = new Map<JsNode, Set<JsNode>>()
    const calls = references.filter((reference) => reference.use === "callee")
    for (const call of calls) {
      const held = binding(call.scope, call.name)
      if (held === undefined) continue
      if (held.functions.size === 0) {
        for (const caller of call.within) dynamic.add(caller)
        continue
      }
      for (const caller of call.within) {
        const callees = edges.get(caller) ?? new Set<JsNode>()
        for (const callee of held.functions) callees.add(callee)
        edges.set(caller, callees)
      }
    }
    for (const call of calls) {
      const held = binding(call.scope, call.name)
      if (
        call.within.length > 0 &&
        held !== undefined &&
        [...held.functions].some((callee) => dynamic.has(callee))
      )
        refuse(`calls ${call.name} from a function, and ${call.name} calls what it cannot see`)
    }
    const visiting = new Map<JsNode, "open" | "done">()
    const loops = (caller: JsNode): boolean => {
      const seen = visiting.get(caller)
      if (seen !== undefined) return seen === "open"
      visiting.set(caller, "open")
      const found = [...(edges.get(caller) ?? [])].some(loops)
      visiting.set(caller, "done")
      return found
    }
    if ([...edges.keys()].some(loops)) return refuse("has a function that calls itself")

    // Work: what loops, passes over data and the calls of functions multiply to.
    const costs = new Map<WorkContext, number>()
    const cost = (work: WorkContext): number => {
      const known = costs.get(work)
      if (known !== undefined) return known
      costs.set(work, work.max)
      // Every call costs: a function that calls another twice runs it twice.
      let total = work.max
      for (const call of work.calls)
        for (const callee of binding(call.scope, call.name)?.functions ?? []) {
          const inner = contexts.get(callee)
          if (inner !== undefined) total += call.factor * cost(inner)
        }
      costs.set(work, total)
      return total
    }
    if (cost(rootContext) > MAX_NESTED_ITERATIONS)
      refuse("calls functions that run too many iterations from its loops")

    // What a value was copied from: a name or fields of one, a copy of it (`[...a]`, `a.slice()`),
    // or either of two choices.
    const copiedFrom = (node: JsNode | undefined, scope: Scope, deep = true): Array<Occurrence> => {
      if (node === undefined) return []
      if (isChain(node)) return occurrencesIn(node, scope, [])
      if (!deep) return []
      switch (node.type) {
        case "AwaitExpression":
          return copiedFrom(nodeAt(node, "argument"), scope)
        case "ChainExpression":
          return copiedFrom(nodeAt(node, "expression"), scope)
        case "LogicalExpression":
          return [
            ...copiedFrom(nodeAt(node, "left"), scope),
            ...copiedFrom(nodeAt(node, "right"), scope),
          ]
        case "ConditionalExpression":
          return [
            ...copiedFrom(nodeAt(node, "consequent"), scope),
            ...copiedFrom(nodeAt(node, "alternate"), scope),
          ]
        case "ArrayExpression":
          return nodesAt(node, "elements").flatMap((element) =>
            element?.type === "SpreadElement" ? copiedFrom(nodeAt(element, "argument"), scope) : [],
          )
        case "CallExpression": {
          const callee = nodeAt(node, "callee")
          if (callee?.type !== "MemberExpression" || callee["computed"] === true) return []
          const method = nameOf(nodeAt(callee, "property")) ?? ""
          const object = nodeAt(callee, "object")
          // `Array.from(a)` copies its argument; any other method hands back something made from
          // its receiver (`a.map(…)`), which an alias must not hide.
          if (nameOf(object) === "Array" && method === "from")
            return copiedFrom(nodesAt(node, "arguments")[0], scope)
          return [
            ...copiedFrom(object, scope),
            ...(COPYING_METHODS.has(method)
              ? nodesAt(node, "arguments").flatMap((argument) =>
                  copiedFrom(unspread(argument), scope),
                )
              : []),
          ]
        }
        default:
          return []
      }
    }

    // `Array.from` takes the length of an object that has one, so what it is given must be an
    // array: a literal, a result of a method that hands one back or of `Object.keys`, `values` or
    // `entries`, data of `args`, or a name that holds only such values.
    const holdsArray = (node: JsNode | undefined, scope: Scope, seen: Set<Binding>): boolean => {
      switch (node?.type) {
        case "ArrayExpression":
          return true
        case "AwaitExpression":
        case "ChainExpression":
          return holdsArray(
            nodeAt(node, node.type === "AwaitExpression" ? "argument" : "expression"),
            scope,
            seen,
          )
        case "ConditionalExpression":
          return (
            holdsArray(nodeAt(node, "consequent"), scope, seen) &&
            holdsArray(nodeAt(node, "alternate"), scope, seen)
          )
        case "LogicalExpression":
          return (
            holdsArray(nodeAt(node, "left"), scope, seen) &&
            holdsArray(nodeAt(node, "right"), scope, seen)
          )
        case "MemberExpression":
          return rootName(node) === "args" && binding(scope, "args") === undefined
        case "Identifier": {
          const held = binding(scope, nameOf(node) ?? "")
          if (held === undefined || held.unsafe || held.sources.length === 0) return false
          if (seen.has(held)) return true
          seen.add(held)
          return held.sources.every((source) => holdsArray(source.node, source.scope, seen))
        }
        case "CallExpression": {
          const callee = nodeAt(node, "callee")
          if (callee?.type !== "MemberExpression" || callee["computed"] === true) return false
          const owner = nameOf(nodeAt(callee, "object"))
          const method = nameOf(nodeAt(callee, "property")) ?? ""
          if (owner !== undefined && binding(scope, owner) === undefined)
            return (
              (owner === "Object" && ["keys", "values", "entries"].includes(method)) ||
              (owner === "Array" && (method === "from" || method === "of")) ||
              (owner === "Promise" && (method === "all" || method === "allSettled"))
            )
          return ARRAY_RESULTS.has(method)
        }
        default:
          return false
      }
    }
    for (const entry of arraysFrom)
      if (!holdsArray(entry.source, entry.scope, new Set()))
        return refuse("builds an array from something that is not known to be an array")

    // Loops over data: the names a for-of walks, and every name its value was copied from.
    const UNSAFE = "a parameter or a loop variable"
    const reaching = (names: ReadonlyArray<string>, scope: Scope): Set<Binding | string> => {
      const seen = new Set<Binding | string>()
      const visit = (name: string, at: Scope) => {
        const key = keyOf(name, at)
        if (key === undefined || seen.has(key) || !spend()) return
        seen.add(key)
        if (typeof key === "string") return
        if (key.unsafe) seen.add(UNSAFE)
        for (const source of key.sources)
          for (const origin of copiedFrom(source.node, source.scope))
            visit(origin.name, source.scope)
      }
      for (const name of names) visit(name, scope)
      return seen
    }
    const shares = (left: Set<Binding | string>, right: Set<Binding | string>) =>
      [...left].some((key) => right.has(key))
    const reachable = (from: Iterable<JsNode>): Set<JsNode> => {
      const found = new Set<JsNode>()
      const visit = (node: JsNode) => {
        if (found.has(node)) return
        found.add(node)
        for (const next of edges.get(node) ?? []) visit(next)
      }
      for (const node of from) visit(node)
      return found
    }
    // A value that is no copy of a name and has none stored in it (`[]`, `{ seen: [] }`) cannot be
    // what a loop walks. Growing anything else inside a loop over data could grow what it walks,
    // however it was reached: through a container, a destructuring or an awaited promise.
    const isFresh = (held: Binding) =>
      !held.unsafe &&
      held.sources.length > 0 &&
      builtBinding(held) &&
      [...held.sources, ...held.stored].every((entry) => identifiersIn(entry.node).length === 0)
    const growsFresh = (site: GrowthSite) =>
      site.names.every((name) => {
        const held = binding(site.scope, name)
        return held !== undefined && isFresh(held)
      })
    for (const walk of everyWalk) {
      const walked = reaching(walk.walked, walk.scope)
      // A loop over what a function returns walks something no name says.
      const viaFunction = [...walked].some(
        (key) => typeof key !== "string" && key.functions.size > 0,
      )
      for (const site of walk.sites)
        if (
          site.opaque ||
          viaFunction ||
          !growsFresh(site) ||
          shares(reaching(site.names, site.scope), walked)
        )
          return refuse("adds to the array a for-of loop walks")
      for (const call of walk.calls) {
        const callees = reachable(binding(call.scope, call.name)?.functions ?? [])
        if ([...callees].some((callee) => dynamic.has(callee)))
          return refuse("calls, in a for-of loop, a function that calls what it cannot see")
        for (const site of growths) {
          if (!site.within.some((caller) => callees.has(caller))) continue
          const grown = reaching(site.names, site.scope)
          if (
            site.opaque ||
            viaFunction ||
            !growsFresh(site) ||
            grown.has(UNSAFE) ||
            shares(grown, walked)
          )
            return refuse("calls, in a for-of loop, a function that adds to an array")
        }
      }
    }

    // Values used twice to build a bigger one: two operands of a construct that read the same
    // value, directly or through a name that was copied from it. Using a name twice in one
    // expression is bounded by the size of the script, however the result is used. What grows
    // without bound is a value that is itself built that way and used twice again: it doubles on
    // each round of a loop or call, or on each of a chain of statements. So a use twice is refused
    // when the value used is "grown": a name that is set from a doubled value, from a call of a
    // function that doubles, or from another grown name, whether directly, through a copy, a
    // member, a push, a loop variable or a parameter it is handed to.
    const ids = new Map<Binding | string, number>()
    const idOf = (key: Binding | string) => {
      const known = ids.get(key)
      if (known !== undefined) return known
      ids.set(key, ids.size)
      return ids.size - 1
    }
    const readings = (
      operand: JsNode,
      scope: Scope,
      deep: boolean,
    ): Map<string, Binding | string> => {
      const found = new Map<string, Binding | string>()
      const visit = (name: string, at: Scope, path: ReadonlyArray<string>, seen: Set<Binding>) => {
        const key = keyOf(name, at)
        if (key === undefined || !spend()) return
        found.set(`${idOf(key)}:${path.join(".")}`, key)
        if (typeof key === "string" || seen.has(key)) return
        seen.add(key)
        for (const source of key.sources) {
          const plain = isChain(source.node)
          for (const origin of copiedFrom(source.node, source.scope, deep))
            visit(origin.name, origin.scope, plain ? [...origin.path, ...path] : origin.path, seen)
        }
      }
      for (const origin of occurrencesIn(operand, scope, []))
        visit(origin.name, origin.scope, origin.path, new Set())
      return found
    }
    // Text put in place of text: every literal a name may hold, for a name set only to literals; a
    // conditional holds the literals of both branches.
    const textsOf = (node: JsNode | undefined, scope: Scope, seen: Set<Binding>): Array<string> => {
      const text = literalText(node)
      if (text !== undefined) return [text]
      if (node?.type === "ConditionalExpression") {
        const branches = [nodeAt(node, "consequent"), nodeAt(node, "alternate")].map((branch) =>
          textsOf(branch, scope, seen),
        )
        return branches.some((found) => found.length === 0) ? [] : branches.flat()
      }
      const name = nameOf(node)
      const held = name === undefined ? undefined : binding(scope, name)
      if (held === undefined || held.unsafe || held.sources.length === 0 || seen.has(held))
        return []
      seen.add(held)
      const texts = held.sources.map((source) => textsOf(source.node, source.scope, seen))
      seen.delete(held)
      return texts.some((found) => found.length === 0) ? [] : texts.flat()
    }
    // What a join's receiver was split on: the separator of `s.split(sep)`, `""` for `[...s]` and
    // `Array.from(s)`, followed through the names set to such a value. Empty when it is not known,
    // so a join of an array that does not derive from a split is not judged.
    const separatorsOf = (
      node: JsNode | undefined,
      scope: Scope,
      seen: Set<Binding>,
    ): Array<string> => {
      if (node?.type === "CallExpression") {
        const callee = nodeAt(node, "callee")
        const member = callee?.type === "MemberExpression" ? callee : undefined
        const method = nameOf(nodeAt(member ?? node, "property"))
        const given = nodesAt(node, "arguments")
        if (method === "split") return textsOf(given[0], scope, new Set())
        return nameOf(nodeAt(member ?? node, "object")) === "Array" &&
          method === "from" &&
          given.length === 1
          ? [""]
          : []
      }
      if (node?.type === "ArrayExpression") {
        const elements = nodesAt(node, "elements")
        return elements.length === 1 && elements[0]?.type === "SpreadElement" ? [""] : []
      }
      const name = nameOf(node)
      const held = name === undefined ? undefined : binding(scope, name)
      if (held === undefined || held.sources.length === 0 || seen.has(held)) return []
      seen.add(held)
      const found = held.sources.map((source) => separatorsOf(source.node, source.scope, seen))
      seen.delete(held)
      return found.some((separators) => separators.length === 0) ? [] : found.flat()
    }
    // A swap that pastes in more than it takes out reads its receiver twice, like `s + s`, so a
    // result that flows back into the receiver (through a temporary too) is a doubling. A single
    // `replace` outside any loop or function swaps one match, so it grows the text by a constant.
    for (const swap of textSwaps) {
      if (swap.method === "replace" && !swap.repeats) continue
      const takenTexts =
        swap.method === "join"
          ? separatorsOf(swap.receiver, swap.scope, new Set())
          : textsOf(swap.first, swap.scope, new Set())
      // `join()` with no separator joins with a comma.
      const putTexts =
        swap.method === "join" && swap.first === undefined
          ? [","]
          : textsOf(swap.method === "join" ? swap.first : swap.second, swap.scope, new Set())
      if (
        takenTexts.some((from) =>
          putTexts.some(
            (to) => to.length > from.length || (swap.method !== "join" && to.includes("$")),
          ),
        )
      )
        combinations.push({
          at: swap.node,
          operands: [swap.receiver, swap.receiver],
          scope: swap.scope,
          merging: true,
        })
    }
    // The constructs that use a value twice, and the values they use twice.
    const doublings: Array<{ readonly at: JsNode; readonly shared: Array<Binding | string> }> = []
    for (const combination of combinations) {
      if (
        combination.callee !== undefined &&
        (binding(combination.scope, combination.callee)?.functions.size ?? 0) === 0
      )
        continue
      const owners = new Map<string, number>()
      const shared = new Set<Binding | string>()
      for (const [index, operand] of combination.operands.entries())
        for (const [reading, key] of readings(
          operand,
          combination.scope,
          combination.merging === true,
        )) {
          const owner = owners.get(reading)
          if (owner !== undefined && owner !== index) shared.add(key)
          owners.set(reading, index)
        }
      if (shared.size > 0) doublings.push({ at: combination.at, shared: [...shared] })
    }

    // Doubling split over statements: several stores into one name that read the same value
    // (`p.push(...a); p.push(...a)`, `o.x = a; o.y = a`) build from it as many times as they read it.
    // The later store counts as the construct, so that what it stores is grown and a name set from
    // that (`a = p`) is followed. A plain assignment counts only when it reads the name it sets.
    const storesInto = new Map<Binding, Array<Store>>()
    for (const store of stores)
      for (const name of new Set(store.names)) {
        const target = binding(store.scope, name)
        if (target !== undefined) storesInto.set(target, [...(storesInto.get(target) ?? []), store])
      }
    for (const [target, group] of storesInto) {
      if (group.length < 2) continue
      const owners = new Map<string, Store>()
      for (const store of group) {
        const read = readings(store.value, store.scope, true)
        if (!store.adds && ![...read.values()].includes(target)) continue
        const shared = new Set<Binding | string>()
        for (const [reading, key] of read) {
          const owner = owners.get(reading)
          if (owner !== undefined && owner !== store && key !== target) shared.add(key)
          owners.set(reading, store)
        }
        if (shared.size > 0) doublings.push({ at: store.value, shared: [...shared] })
      }
    }

    // What a stretch of the script holds: a construct that doubles, the names it reads and the
    // calls of named functions in it.
    const byStart = <T>(list: ReadonlyArray<T>, start: (item: T) => number): Array<T> =>
      [...list].sort((left, right) => start(left) - start(right))
    const firstFrom = <T>(list: ReadonlyArray<T>, start: (item: T) => number, at: number) => {
      let low = 0
      let high = list.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (start(list[middle] as T) < at) low = middle + 1
        else high = middle
      }
      return low
    }
    const sites = byStart(
      doublings.map((doubling) => doubling.at),
      startOf,
    )
    const uses = byStart(
      references.flatMap((reference) => {
        const held = binding(reference.scope, reference.name)
        return held === undefined ? [] : [{ held, start: reference.start }]
      }),
      (use) => use.start,
    )
    const applied = byStart(applications, (call) => startOf(call.node))
    interface Reads {
      doubles: boolean
      readonly held: Set<Binding>
      readonly calls: Array<Applied>
    }
    const readsCache = new Map<JsNode, Reads>()
    const readsOf = (node: JsNode): Reads => {
      const known = readsCache.get(node)
      if (known !== undefined) return known
      const start = startOf(node)
      const end = endOf(node)
      const reads: Reads = { doubles: false, held: new Set(), calls: [] }
      readsCache.set(node, reads)
      for (let at = firstFrom(sites, startOf, start); at < sites.length && spend(); at++) {
        const site = sites[at] as JsNode
        if (startOf(site) >= end) break
        if (endOf(site) <= end) reads.doubles = true
      }
      for (let at = firstFrom(uses, (use) => use.start, start); at < uses.length && spend(); at++) {
        const use = uses[at]
        if (use === undefined || use.start >= end) break
        reads.held.add(use.held)
      }
      for (
        let at = firstFrom(applied, (call) => startOf(call.node), start);
        at < applied.length;
        at++
      ) {
        const call = applied[at]
        if (call === undefined || startOf(call.node) >= end || !spend()) break
        if (endOf(call.node) <= end) reads.calls.push(call)
      }
      return reads
    }

    // The names that hold a grown value, and the functions that hand one back, found by following
    // the value until nothing new is reached.
    const grown = new Set<Binding>()
    const handingBack = new Set<JsNode>()
    const callsGrown = (call: Applied) =>
      [...(binding(call.scope, call.name)?.functions ?? [])].some((callee) =>
        handingBack.has(callee),
      )
    const isGrown = (node: JsNode) => {
      const reads = readsOf(node)
      return (
        reads.doubles ||
        [...reads.held].some((held) => grown.has(held)) ||
        reads.calls.some(callsGrown)
      )
    }
    const handedTo: Array<Flow> = [
      ...flows,
      ...applications.map((call): Flow => ({
        inputs: call.inputs,
        takers: () =>
          [...(binding(call.scope, call.name)?.functions ?? [])].flatMap(
            (callee) => parametersOf.get(callee) ?? [],
          ),
      })),
    ]
    for (let changed = true; changed && spend();) {
      changed = false
      for (const store of stores) {
        const targets = store.names.flatMap((name) => binding(store.scope, name) ?? [])
        if (targets.every((target) => grown.has(target)) || !isGrown(store.value)) continue
        for (const target of targets) grown.add(target)
        changed = true
      }
      for (const flow of handedTo) {
        const takers = flow.takers()
        if (takers.every((taker) => grown.has(taker)) || !flow.inputs.some(isGrown)) continue
        for (const taker of takers) grown.add(taker)
        changed = true
      }
      for (const callee of functionNodes)
        if (!handingBack.has(callee) && isGrown(callee)) {
          handingBack.add(callee)
          changed = true
        }
    }
    // Replacement text nothing says the length of (a parameter, a loop variable, a name set by a
    // computation) can be as long as the text it goes into, so inside a loop or a function it
    // has to come from `args` (which the root hands in, not a runaway script).
    const everyReference = byStart(references, (reference) => reference.start)
    const comesFromArgs = (node: JsNode, seen: Set<Binding>, origin: boolean): boolean => {
      const end = endOf(node)
      const inside: Array<Reference> = []
      for (
        let at = firstFrom(everyReference, (reference) => reference.start, startOf(node));
        at < everyReference.length && spend();
        at++
      ) {
        const reference = everyReference[at]
        if (reference === undefined || reference.start >= end) break
        inside.push(reference)
      }
      // A value written out in the script is no data from `args`; an expression of no names is
      // judged where it stands.
      if (inside.length === 0) return !origin
      return inside.every((reference) => {
        const held = binding(reference.scope, reference.name)
        if (held === undefined || held.functions.size > 0 || seen.has(held)) return true
        seen.add(held)
        // A parameter gets the argument at its position from each call of its function.
        const passed = applications.flatMap((call) =>
          [...(binding(call.scope, call.name)?.functions ?? [])].flatMap((callee) => {
            const given = call.inputs[(parametersOf.get(callee) ?? []).indexOf(held)]
            return given === undefined ? [] : [given]
          }),
        )
        const origins = [
          ...held.sources.map((source) => source.node),
          ...passed,
          ...flows.filter((flow) => flow.takers().includes(held)).flatMap((flow) => flow.inputs),
        ]
        return origins.length > 0 && origins.every((from) => comesFromArgs(from, seen, true))
      })
    }
    for (const swap of textSwaps)
      if (
        swap.repeats &&
        swap.method !== "join" &&
        swap.second !== undefined &&
        textsOf(swap.second, swap.scope, new Set()).length === 0 &&
        !comesFromArgs(swap.second, new Set(), false)
      )
        return refuse("replaces text with text whose length it cannot tell, again and again")
    for (const doubling of doublings)
      if (doubling.shared.some((key) => typeof key !== "string" && grown.has(key)))
        return refuse("uses one value twice to build a bigger one")
    if (analysisSteps > MAX_ANALYSIS_STEPS) refuse("is too tangled to check")
  }

  const moduleScope: Scope = { parent: undefined, names: new Map(), isFunction: true }
  let exported = 0
  for (const node of nodesAt(program, "body")) {
    if (node?.type !== "ExportNamedDeclaration") {
      statement(node, moduleScope, 1)
      continue
    }
    exported += 1
    const declaration = nodeAt(node, "declaration")
    const declarators = nodesAt(declaration ?? node, "declarations")
    const meta = declarators[0]
    if (
      exported > 1 ||
      declaration?.type !== "VariableDeclaration" ||
      declaration["kind"] !== "const" ||
      declarators.length !== 1 ||
      nameOf(nodeAt(meta ?? node, "id")) !== "meta" ||
      nodeAt(meta ?? node, "init")?.type !== "ObjectExpression" ||
      !literalOnly(nodeAt(meta ?? node, "init"), 1)
    )
      refuse("exports anything but `export const meta = { … }` of literals")
    moduleScope.names.set("meta", { ...newBinding(), unsafe: true })
  }

  for (const reference of references) {
    const held = binding(reference.scope, reference.name)
    const { name, use } = reference
    if (held !== undefined) {
      if (held.functions.size > 0 && (use === "value" || use === "object"))
        refuse(`uses the function ${name} as a value; a function is only called`)
      continue
    }
    if (use === "write") refuse(`assigns to ${name}, which it did not declare`)
    else if (!GLOBALS.has(name)) refuse(`uses ${name}, which it did not declare`)
    else if (use === "value" && !VALUE_GLOBALS.has(name))
      refuse(`uses ${name} as a value; a global is only called or read from`)
    else if (use === "callee" && !GLOBAL_FUNCTIONS.has(name)) refuse(`calls ${name}`)
  }
  for (const entry of functionAssignments)
    binding(entry.scope, entry.name)?.functions.add(entry.node)
  for (const assignment of assignments) {
    const held = binding(assignment.scope, assignment.name)
    held?.inits.push(assignment.builtHere)
    if (assignment.right !== undefined)
      held?.sources.push({ node: assignment.right, scope: assignment.scope })
  }
  for (const write of memberWrites) {
    const held = write.root === undefined ? undefined : binding(write.scope, write.root)
    if (held === undefined || !builtBinding(held))
      refuse("writes into something the script did not build")
    if (write.right !== undefined) held?.stored.push({ node: write.right, scope: write.scope })
  }
  if (refusal === undefined) analyse()
  if (refusal === undefined && agentCalls === 0) refuse("starts no agent")
  return refusal
}

/**
 * Why the hook does not let an inline Workflow script run without a prompt, or undefined when it
 * does: the script is plain (see the top of this file) and every `agent()` call in it starts one of
 * this plugin's specialists by a string-literal `agentType`. It never fails: whatever goes wrong
 * while reading the script (a syntax error, a tree too deep for the stack) is a refusal.
 * `specialists` is the set of `agentType` values that count as specialists: the Claude plugin's by
 * default, or the bare names the Pi package ships them under. `host` "pi" checks the program
 * `@tintinweb/pi-subagents` runs, meta fragment included (see {@link workerProgram}), where "claude"
 * checks the script as a module.
 */
export const workflowRefusal = (
  script: string,
  specialists: ReadonlySet<string> = CLAUDE_SPECIALISTS,
  host: "claude" | "pi" = "claude",
): Effect.Effect<string | undefined> =>
  Effect.try({
    try: () => inspect(script, specialists, host === "pi"),
    catch: (cause) => `cannot read the script: ${String(cause)}`,
  }).pipe(Effect.catch((reason) => Effect.succeed<string | undefined>(reason)))
