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

/** The only names a script may call as a method; any other name is read as a plain field. */
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
  "all",
  "allSettled",
  "race",
  "resolve",
  "reject",
  "keys",
  "values",
  "entries",
  "fromEntries",
  "assign",
  "freeze",
  "from",
  "of",
  "isArray",
  "isInteger",
  "stringify",
  "parse",
  "max",
  "min",
  "abs",
  "floor",
  "ceil",
  "round",
  "trunc",
  "sqrt",
  "pow",
  "sign",
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

/** The names a scope holds, and the scope around it. */
interface Scope {
  readonly parent: Scope | undefined
  readonly names: Set<string>
  /** True for the module and a function, the scopes `var` lands in. */
  readonly isFunction: boolean
}

/** A use of a name, resolved against the scopes once the whole script has been walked. */
interface Reference {
  readonly name: string
  readonly scope: Scope
  /** True when the use assigns to the name. */
  readonly write: boolean
}

const childScope = (parent: Scope, isFunction: boolean): Scope => ({
  parent,
  names: new Set(),
  isFunction,
})

const bound = (scope: Scope | undefined, name: string): boolean =>
  scope !== undefined && (scope.names.has(name) || bound(scope.parent, name))

const varScope = (scope: Scope): Scope =>
  scope.isFunction || scope.parent === undefined ? scope : varScope(scope.parent)

/** True for the root object of `a.b.c`, the name that decides what an assignment to it changes. */
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
  let agentCalls = 0

  const declare = (scope: Scope, name: string) => {
    if (GLOBALS.has(name) || HOST_GLOBALS.has(name) || DENIED_NAMES.has(name) || name === "agent")
      refuse(`declares ${name}, a name of the host`)
    scope.names.add(name)
  }

  const refer = (node: JsNode, scope: Scope, write: boolean) => {
    const name = nameOf(node)
    if (name === undefined) refuse("reads a name it cannot read")
    else references.push({ name, scope, write })
  }

  // A binding pattern (a declaration or a parameter). Keys are plain identifiers, never computed.
  const declarePattern = (
    node: JsNode | undefined,
    scope: Scope,
    target: Scope,
    depth: number,
  ): void => {
    if (node === undefined || depth > MAX_DEPTH) return refuse("nests too deep")
    switch (node.type) {
      case "Identifier":
        return declare(target, nameOf(node) ?? "")
      case "RestElement":
        return declarePattern(nodeAt(node, "argument"), scope, target, depth + 1)
      case "AssignmentPattern":
        declarePattern(nodeAt(node, "left"), scope, target, depth + 1)
        return expression(nodeAt(node, "right"), scope, depth + 1)
      case "ArrayPattern":
        for (const element of nodesAt(node, "elements"))
          if (element !== undefined) declarePattern(element, scope, target, depth + 1)
        return
      case "ObjectPattern":
        for (const property of nodesAt(node, "properties")) {
          if (property?.type === "RestElement") declarePattern(property, scope, target, depth + 1)
          else if (
            property?.type === "Property" &&
            property["computed"] === false &&
            property["kind"] === "init" &&
            nameOf(nodeAt(property, "key")) !== undefined &&
            !DENIED_NAMES.has(nameOf(nodeAt(property, "key")) ?? "")
          )
            declarePattern(nodeAt(property, "value"), scope, target, depth + 1)
          else refuse("destructures with a key that is not a plain name")
        }
        return
      default:
        return refuse(`binds with ${node.type}`)
    }
  }

  const variableDeclaration = (node: JsNode, scope: Scope, depth: number) => {
    const kind = node["kind"]
    if (kind !== "var" && kind !== "let" && kind !== "const")
      return refuse(`declares with ${String(kind)}`)
    for (const declarator of nodesAt(node, "declarations")) {
      if (declarator?.type !== "VariableDeclarator") return refuse("declares oddly")
      declarePattern(
        nodeAt(declarator, "id"),
        scope,
        kind === "var" ? varScope(scope) : scope,
        depth + 1,
      )
      expression(nodeAt(declarator, "init"), scope, depth + 1)
    }
  }

  const functionNode = (node: JsNode, scope: Scope, depth: number) => {
    if (node["generator"] === true) return refuse("uses a generator")
    const inner = childScope(scope, true)
    const own = nameOf(nodeAt(node, "id"))
    if (node.type === "FunctionExpression" && own !== undefined) declare(inner, own)
    for (const parameter of nodesAt(node, "params"))
      declarePattern(parameter, inner, inner, depth + 1)
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
    expression(nodeAt(node, "object"), scope, depth + 1)
    const property = nodeAt(node, "property")
    if (node["computed"] === true) {
      const index = property?.type === "Literal" ? property["value"] : undefined
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0)
        refuse("reads a member by a computed key")
      return
    }
    const name = nameOf(property)
    if (name === undefined || DENIED_NAMES.has(name)) return refuse(`reads .${name ?? "?"}`)
    // The budget is an object of the workflow runtime itself, so any method of it may be called.
    if (called && !CALLABLE_PROPERTIES.has(name) && rootName(node) !== "budget")
      refuse(`calls .${name}`)
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
    if (callee?.type === "Identifier") refer(callee, scope, false)
    else if (callee?.type === "MemberExpression") memberExpression(callee, scope, depth + 1, true)
    else if (callee?.type === "ArrowFunctionExpression" || callee?.type === "FunctionExpression")
      functionNode(callee, scope, depth + 1)
    else return refuse("calls something it cannot vet")
    for (const argument of nodesAt(node, "arguments"))
      expression(
        argument?.type === "SpreadElement" ? nodeAt(argument, "argument") : argument,
        scope,
        depth + 1,
      )
  }

  // The target of an assignment or an update: a name, or a member of something the script declared.
  const writeTarget = (node: JsNode | undefined, scope: Scope, depth: number) => {
    if (node?.type === "Identifier") return refer(node, scope, true)
    if (node?.type === "MemberExpression") {
      const root = rootName(node)
      if (root === undefined || !bound(scope, root)) return refuse("assigns into a global")
      return memberExpression(node, scope, depth + 1, false)
    }
    refuse("assigns to something that is not a name or a member")
  }

  function expression(node: JsNode | undefined, scope: Scope, depth: number): void {
    if (node === undefined) return
    if (depth > MAX_DEPTH) return refuse("nests too deep")
    switch (node.type) {
      case "Identifier":
        return refer(node, scope, false)
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
        return writeTarget(nodeAt(node, "argument"), scope, depth)
      case "BinaryExpression":
      case "LogicalExpression":
        expression(nodeAt(node, "left"), scope, depth + 1)
        return expression(nodeAt(node, "right"), scope, depth + 1)
      case "AssignmentExpression":
        writeTarget(nodeAt(node, "left"), scope, depth)
        return expression(nodeAt(node, "right"), scope, depth + 1)
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
        declare(scope, nameOf(nodeAt(node, "id")) ?? "")
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
        if (left?.type === "VariableDeclaration") variableDeclaration(left, loop, depth + 1)
        else writeTarget(left, loop, depth + 1)
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
          if (parameter !== undefined) declarePattern(parameter, catching, catching, depth + 1)
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

  const moduleScope: Scope = { parent: undefined, names: new Set(), isFunction: true }
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
    moduleScope.names.add("meta")
  }

  for (const reference of references) {
    if (bound(reference.scope, reference.name)) continue
    if (reference.write) refuse(`assigns to ${reference.name}, which it did not declare`)
    else if (!GLOBALS.has(reference.name))
      refuse(`uses ${reference.name}, which it did not declare`)
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
