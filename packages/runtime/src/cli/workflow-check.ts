import { parse } from "acorn"
import { Effect } from "effect"

import { ROUTES } from "../domain/route.ts"
import { PLUGIN_NAMESPACE } from "./assignment.ts"

// The Workflow tool runs a script the root writes inline, and the only way that script starts an
// agent is the global `agent()`. The PreToolUse hook lets such a script run without a prompt when
// it is plain: it is parsed (acorn) and every node must be of a closed set of types, every name
// must resolve to something the script declared or to a global of the workflow, and every
// `agent()` call must name one of our specialists with a string literal. Whatever else a script
// does (a node outside the set, a name that resolves to nothing known, a computed member access,
// a parse error, a script too large or too deep) is a refusal, and a refusal only means the normal
// permission flow. Nothing here runs the script.

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
export const MAX_WORKFLOW_SCRIPT = 1_000_000
const MAX_DEPTH = 120

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

/** The methods of a global object a script may call; any other member of it is refused. */
const GLOBAL_CALLS: Readonly<Record<string, ReadonlySet<string>>> = {
  Object: new Set(["keys", "values", "entries", "fromEntries"]),
  Array: new Set(["isArray", "from", "of"]),
  JSON: new Set(["stringify", "parse"]),
  Math: new Set(["max", "min", "abs", "floor", "ceil", "round", "trunc", "sqrt", "pow", "sign"]),
  Number: new Set(["isInteger", "isFinite", "isNaN", "parseFloat", "parseInt"]),
  Promise: new Set(["all", "allSettled", "race", "resolve", "reject"]),
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

const SPECIALISTS: ReadonlySet<string> = new Set(
  ROUTES.map((route) => `${PLUGIN_NAMESPACE}:${route.agent}`),
)

const UNARY: ReadonlySet<string> = new Set(["!", "-", "+", "~", "typeof", "void"])

/** What the script knows about a name it declared. */
interface Binding {
  /** True for a name that holds nothing the script built: a parameter, a loop variable, a function. */
  unsafe: boolean
  /** Every value the name is set to, as a test of whether the script built it; run after the walk. */
  readonly inits: Array<() => boolean>
}

/** The names a scope holds, and the scope around it. */
interface Scope {
  readonly parent: Scope | undefined
  readonly names: Map<string, Binding>
  /** True for the module and a function, the scopes `var` lands in. */
  readonly isFunction: boolean
}

/** How a name is used: as a value, called, read from (`name.x`) or written to. */
type Use = "value" | "callee" | "object" | "write"

/** A use of a name, resolved against the scopes once the whole script has been walked. */
interface Reference {
  readonly name: string
  readonly scope: Scope
  readonly use: Use
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

/**
 * Why a script is not plain (the first reason found), or undefined when it is: the script parsed as
 * a module with top-level await, every node of a type in the closed set, every name resolved, every
 * `agent()` call vetted and at least one of them. A parse error or an overflow throws; the caller
 * turns that into a refusal.
 */
const inspect = (script: string): string | undefined => {
  if (script.length > MAX_WORKFLOW_SCRIPT) return "the script is too large"
  const program = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  }) as unknown as JsNode
  let refusal: string | undefined
  const refuse = (why: string) => {
    refusal ??= why
  }
  const references: Array<Reference> = []
  // Assignments to a name and writes into a member, checked once every name is known.
  const assignments: Array<{ name: string; scope: Scope; builtHere: () => boolean }> = []
  const memberWrites: Array<{ root: string | undefined; scope: Scope }> = []
  let agentCalls = 0

  /**
   * Declares a name; `origin` tests whether the script built its value, and `undefined` is none
   * yet.
   */
  const declare = (scope: Scope, name: string, origin?: (() => boolean) | "unsafe") => {
    if (GLOBALS.has(name) || HOST_GLOBALS.has(name) || DENIED_NAMES.has(name) || name === "agent")
      refuse(`declares ${name}, a name of the host`)
    const held: Binding = scope.names.get(name) ?? { unsafe: false, inits: [] }
    if (origin === "unsafe") held.unsafe = true
    else if (origin !== undefined) held.inits.push(origin)
    scope.names.set(name, held)
  }

  const refer = (node: JsNode, scope: Scope, use: Use) => {
    const name = nameOf(node)
    if (name === undefined) refuse("reads a name it cannot read")
    else references.push({ name, scope, use })
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
      declarePattern(
        nodeAt(declarator, "id"),
        scope,
        kind === "var" ? varScope(scope) : scope,
        depth + 1,
        loop ?? (init === undefined ? undefined : () => builtHere(init, scope)),
      )
      expression(init, scope, depth + 1)
    }
  }

  const functionNode = (node: JsNode, scope: Scope, depth: number) => {
    if (node["generator"] === true) return refuse("uses a generator")
    const inner = childScope(scope, true)
    const own = nameOf(nodeAt(node, "id"))
    if (node.type === "FunctionExpression" && own !== undefined) declare(inner, own, "unsafe")
    for (const parameter of nodesAt(node, "params"))
      declarePattern(parameter, inner, inner, depth + 1, "unsafe")
    const body = nodeAt(node, "body")
    if (body?.type === "BlockStatement") statements(nodesAt(body, "body"), inner, depth + 1)
    else expression(body, inner, depth + 1)
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
        SPECIALISTS.has(value["value"])
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
    if (callee?.type === "Identifier") refer(callee, scope, "callee")
    else if (callee?.type === "MemberExpression") {
      memberExpression(callee, scope, depth + 1, true)
      const limit = MAX_ARGUMENTS[nameOf(nodeAt(callee, "property")) ?? ""]
      const given = nodesAt(node, "arguments")
      if (
        callee["computed"] !== true &&
        limit !== undefined &&
        (given.length > limit || given.some((argument) => argument?.type === "SpreadElement"))
      )
        refuse("passes a method more arguments than its callback (a this value)")
    } else if (callee?.type === "ArrowFunctionExpression" || callee?.type === "FunctionExpression")
      functionNode(callee, scope, depth + 1)
    else return refuse("calls something it cannot vet")
    for (const argument of nodesAt(node, "arguments"))
      expression(
        argument?.type === "SpreadElement" ? nodeAt(argument, "argument") : argument,
        scope,
        depth + 1,
      )
  }

  // The target of an assignment or an update: a name, or a member of data the script built (checked
  // once every name is known). `builtHere` tests whether the value assigned is the script's own.
  const writeTarget = (
    node: JsNode | undefined,
    scope: Scope,
    depth: number,
    builtValue: () => boolean,
  ) => {
    if (node?.type === "Identifier") {
      refer(node, scope, "write")
      assignments.push({ name: nameOf(node) ?? "", scope, builtHere: builtValue })
      return
    }
    if (node?.type === "MemberExpression") {
      memberWrites.push({ root: rootName(node), scope })
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
        for (const part of nodesAt(node, "expressions")) expression(part, scope, depth + 1)
        return
      case "ArrayExpression":
        for (const element of nodesAt(node, "elements"))
          expression(
            element?.type === "SpreadElement" ? nodeAt(element, "argument") : element,
            scope,
            depth + 1,
          )
        return
      case "ObjectExpression":
        for (const property of nodesAt(node, "properties")) objectProperty(property, scope, depth)
        return
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return functionNode(node, scope, depth)
      case "UnaryExpression":
        if (!UNARY.has(String(node["operator"]))) return refuse("uses delete")
        return expression(nodeAt(node, "argument"), scope, depth + 1)
      case "UpdateExpression":
        return writeTarget(nodeAt(node, "argument"), scope, depth, () => true)
      case "BinaryExpression":
      case "LogicalExpression":
        expression(nodeAt(node, "left"), scope, depth + 1)
        return expression(nodeAt(node, "right"), scope, depth + 1)
      case "AssignmentExpression": {
        const right = nodeAt(node, "right")
        writeTarget(
          nodeAt(node, "left"),
          scope,
          depth,
          node["operator"] === "=" ? () => builtHere(right, scope) : () => true,
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
      case "FunctionDeclaration":
        declare(scope, nameOf(nodeAt(node, "id")) ?? "", "unsafe")
        return functionNode(node, scope, depth)
      case "ReturnStatement":
      case "ThrowStatement":
        return expression(nodeAt(node, "argument"), scope, depth + 1)
      case "IfStatement":
        expression(nodeAt(node, "test"), scope, depth + 1)
        statement(nodeAt(node, "consequent"), scope, depth + 1)
        return statement(nodeAt(node, "alternate"), scope, depth + 1)
      case "BlockStatement":
        return statements(nodesAt(node, "body"), inner(), depth)
      case "ForStatement": {
        const loop = inner()
        const init = nodeAt(node, "init")
        if (init?.type === "VariableDeclaration") variableDeclaration(init, loop, depth + 1)
        else expression(init, loop, depth + 1)
        expression(nodeAt(node, "test"), loop, depth + 1)
        expression(nodeAt(node, "update"), loop, depth + 1)
        return statement(nodeAt(node, "body"), loop, depth + 1)
      }
      case "ForOfStatement":
      case "ForInStatement": {
        const loop = inner()
        const left = nodeAt(node, "left")
        if (left?.type === "VariableDeclaration")
          variableDeclaration(left, loop, depth + 1, "unsafe")
        else writeTarget(left, loop, depth + 1, () => false)
        expression(nodeAt(node, "right"), loop, depth + 1)
        return statement(nodeAt(node, "body"), loop, depth + 1)
      }
      case "WhileStatement":
      case "DoWhileStatement":
        expression(nodeAt(node, "test"), scope, depth + 1)
        return statement(nodeAt(node, "body"), scope, depth + 1)
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

  // `export const meta = { … }` of literals only, the one export a workflow script may make.
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
    moduleScope.names.set("meta", { unsafe: true, inits: [] })
  }

  for (const reference of references) {
    if (binding(reference.scope, reference.name) !== undefined) continue
    const { name, use } = reference
    if (use === "write") refuse(`assigns to ${name}, which it did not declare`)
    else if (!GLOBALS.has(name)) refuse(`uses ${name}, which it did not declare`)
    else if (use === "value" && !VALUE_GLOBALS.has(name))
      refuse(`uses ${name} as a value; a global is only called or read from`)
    else if (use === "callee" && !GLOBAL_FUNCTIONS.has(name)) refuse(`calls ${name}`)
  }
  for (const assignment of assignments)
    binding(assignment.scope, assignment.name)?.inits.push(assignment.builtHere)
  for (const write of memberWrites) {
    const held = write.root === undefined ? undefined : binding(write.scope, write.root)
    if (held === undefined || !builtBinding(held))
      refuse("writes into something the script did not build")
  }
  if (refusal === undefined && agentCalls === 0) refuse("starts no agent")
  return refusal
}

/**
 * Why the hook does not let an inline Workflow script run without a prompt, or undefined when it
 * does: the script is plain (see the top of this file) and every `agent()` call in it starts one of
 * this plugin's specialists by a string-literal `agentType`. It never fails: whatever goes wrong
 * while reading the script (a syntax error, a tree too deep for the stack) is a refusal.
 */
export const workflowRefusal = (script: string): Effect.Effect<string | undefined> =>
  Effect.try({
    try: () => inspect(script),
    catch: (cause) => `cannot read the script: ${String(cause)}`,
  }).pipe(Effect.catch((reason) => Effect.succeed<string | undefined>(reason)))
